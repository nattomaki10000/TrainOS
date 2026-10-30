// TrainOS / sys/app_loader.js
// sys/apps/ を走査してアプリを登録し、iframe サンドボックスで起動する。
//
// kernel に必要なもの:
//   readFile / writeFile / listDirectory / createDirectory / deleteFile / getFileTree
//   desktop.createWindow(app) -> HTMLElement   （デスクトップ側が実装。ウィンドウの中身の要素を返す）
//   settings.fileTypeHandlers（任意）          （拡張子 -> アプリID の上書き）
//
// 使い方:
//   kernel.apps = new TrainOSAppLoader(kernel);
//   await kernel.apps.scan();
//   await kernel.apps.launch('notepad');
//   await kernel.apps.openFile('/usr/documents/memo.txt');

(function () {
  'use strict';

  const APPS_DIR = '/sys/apps';

  const DEFAULT_MANIFEST = {
    version: '0.0.0',
    icon: 'cube',
    entry: 'index.html',
    extensions: [],
    permissions: ['fs.read', 'fs.write'],
    singleInstance: false,
    window: { width: 640, height: 480 },
  };

  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm',
  };

  function joinPath(base, rel) {
    const out = [];
    for (const seg of (base + '/' + rel).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop(); else out.push(seg);
    }
    return '/' + out.join('/');
  }

  function extOf(path) {
    const m = /\.([^./]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
  }

  function blobToDataUrl(blob, path) {
    const typed = blob.type ? blob : new Blob([blob], { type: MIME_BY_EXT[extOf(path)] || 'application/octet-stream' });
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(typed);
    });
  }

  function normalizeManifest(raw, fallbackId) {
    const m = Object.assign({}, DEFAULT_MANIFEST, raw && typeof raw === 'object' ? raw : {});
    m.id = /^[\w-]+$/.test(String(m.id || '')) ? String(m.id) : fallbackId;
    m.name = String(m.name || m.id);
    m.entry = String(m.entry || DEFAULT_MANIFEST.entry);
    m.icon = String(m.icon || 'cube');
    m.extensions = (Array.isArray(m.extensions) ? m.extensions : [])
      .map((e) => String(e).replace(/^\./, '').toLowerCase());
    m.permissions = Array.isArray(m.permissions)
      ? m.permissions.map(String)
      : DEFAULT_MANIFEST.permissions.slice();
    m.window = Object.assign({}, DEFAULT_MANIFEST.window, m.window);
    return m;
  }

  // iframe 内に注入される SDK（アプリ側の window.TrainOS）。
  // toString() で文字列化して注入するため、外側の変数は参照できない。
  function sdkMain() {
    const pending = new Map();
    let seq = 0;
    let openHandler = null;
    let pendingOpen = null;

    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      parent.postMessage({ type: 'syscall', id, method, args }, '*');
    });

    window.addEventListener('message', (e) => {
      if (e.source !== parent) return;
      const m = e.data || {};
      if (m.type === 'result') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      } else if (m.type === 'open') {
        if (openHandler) openHandler(m.path); else pendingOpen = m.path;
      }
    });

    window.TrainOS = {
      icon: (n) => {
        const i = (window.__TI__ || {})[n];
        return i ? '<svg viewBox="' + i.vb + '" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="' + i.d + '"/></svg>' : '';
      },
      sys: {
        getSettings: () => call('getSettings'),
        setSettings: (patch) => call('setSettings', patch),
        flush: () => call('flush'),
      },
      fs: {
        readFile: (p) => call('readFile', p),
        readText: async (p) => (await call('readFile', p)).text(),
        writeFile: (p, c) => call('writeFile', p, c instanceof Blob ? c : new Blob([c])),
        list: (p) => call('listDirectory', p),
        tree: (p) => call('getFileTree', p),
        mkdir: (p) => call('createDirectory', p),
        remove: (p) => call('deleteFile', p),
        move: (a, b) => call('moveFile', a, b),
      },
      app: {
        setTitle: (t) => call('setTitle', t),
        close: () => call('close'),
        openFile: (p) => call('openFile', p),
        onOpen: (fn) => {
          openHandler = fn;
          if (pendingOpen !== null) { const p = pendingOpen; pendingOpen = null; fn(p); }
        },
      },
    };

    parent.postMessage({ type: 'ready' }, '*');
  }

  class AppLoader {
    constructor(kernel) {
      this.kernel = kernel;
      this.registry = new Map();   // appId -> { id, manifest, baseDir, entryPath }
      this.instances = new Map();  // instanceId -> instance
      this._seq = 0;
      this._onMessage = this._onMessage.bind(this);
      window.addEventListener('message', this._onMessage);

      // システムコールのホワイトリスト。ここに無いものはアプリから呼べない
      // （getAuthToken などはそもそも公開しない）。
      // path の正規化・検証は kernel / VFS 側の責務。
      this.syscalls = {
        readFile:        { perm: 'fs.read',    fn: (i, p) => kernel.readFile(p) },
        listDirectory:   { perm: 'fs.read',    fn: (i, p) => kernel.listDirectory(p) },
        getFileTree:     { perm: 'fs.read',    fn: (i, p) => kernel.getFileTree(p) },
        writeFile:       { perm: 'fs.write',   fn: (i, p, c) => kernel.writeFile(p, c) },
        createDirectory: { perm: 'fs.write',   fn: (i, p) => kernel.createDirectory(p) },
        deleteFile:      { perm: 'fs.write',   fn: (i, p) => kernel.deleteFile(p) },
        openFile:        { perm: 'app.launch', fn: (i, p) => this.openFile(p).then(() => null) },
        setTitle:        { perm: null,         fn: (i, t) => { i.title = String(t); if (i.onTitleChange) i.onTitleChange(i.title); } },
        close:           { perm: null,         fn: (i) => this.close(i.id) },
        moveFile:        { perm: 'fs.write',        fn: (i, a, b) => kernel.move(a, b) },
        getSettings:     { perm: 'system.settings', fn: async () => ({ settings: kernel.settings, info: await kernel.info() }) },
        setSettings:     { perm: 'system.settings', fn: (i, p) => kernel.setSettings(p).then(() => null) },
        flush:           { perm: 'system.settings', fn: () => kernel.flush().then(() => null) },
      };
    }

    destroy() {
      window.removeEventListener('message', this._onMessage);
      for (const id of [...this.instances.keys()]) this.close(id);
    }

    // ---- 走査（VFS のメモリ上ツリーだけを見る。通信なし）----
    async scan() {
      this.registry.clear();
      const dir = await this.kernel.getFileTree(APPS_DIR);
      for (const node of (dir && dir.children) || []) {
        try {
          if (node.isDirectory) await this._registerFolder(node);
          else if (/\.html?$/i.test(node.name)) this._registerSingle(node);
        } catch (e) {
          console.warn('[AppLoader] skip', node.name, e);
        }
      }
      return [...this.registry.values()].map((a) => a.manifest);
    }

    async _registerFolder(node) {
      const names = new Set((node.children || []).map((c) => c.name));
      let raw = {};
      if (names.has('app.json')) {
        try {
          raw = JSON.parse(await this._text(APPS_DIR + '/' + node.name + '/app.json'));
        } catch (e) {
          console.warn('[AppLoader] app.json が壊れています。既定値で登録:', node.name, e);
        }
      }
      const m = normalizeManifest(raw, node.name.replace(/[^\w-]/g, '_'));
      const baseDir = APPS_DIR + '/' + node.name;
      this.registry.set(m.id, { id: m.id, manifest: m, baseDir, entryPath: joinPath(baseDir, m.entry) });
    }

    _registerSingle(node) {
      const id = node.name.replace(/\.html?$/i, '').replace(/[^\w-]/g, '_');
      const m = normalizeManifest({ id }, id);
      // baseDir = null: 相対参照のインライン化はしない（単体で完結させる）
      this.registry.set(m.id, { id: m.id, manifest: m, baseDir: null, entryPath: APPS_DIR + '/' + node.name });
    }

    list() {
      return [...this.registry.values()].map((a) => a.manifest);
    }

    // ---- 拡張子 -> アプリ ----
    resolveHandler(path) {
      const ext = extOf(path);
      const overrides = (this.kernel.settings && this.kernel.settings.fileTypeHandlers) || {};
      if (overrides[ext] && this.registry.has(overrides[ext])) return overrides[ext];
      for (const app of this.registry.values()) {
        if (app.manifest.extensions.includes(ext)) return app.id;
      }
      return null;
    }

    async openFile(path) {
      const node = this.kernel.find && this.kernel.find(path);
      if (node && node.isDirectory) return this.launch('explorer', { openPath: path }); // フォルダはエクスプローラーで開く
      const id = this.resolveHandler(path);
      if (!id) throw new Error('このファイルを開けるアプリがありません: ' + path);
      return this.launch(id, { openPath: path });
    }

    // ---- 起動 ----
    async launch(appId, opts) {
      const { openPath = null, container = null } = opts || {};
      const app = this.registry.get(appId);
      if (!app) throw new Error('アプリが見つかりません: ' + appId);

      if (app.manifest.singleInstance) {
        const existing = [...this.instances.values()].find((i) => i.appId === appId);
        if (existing) {
          if (openPath) existing.send({ type: 'open', path: openPath });
          return existing;
        }
      }

      const host = container || this.kernel.desktop.createWindow(app);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts'); // allow-same-origin / allow-modals は付けない
      iframe.style.cssText = 'border:0;width:100%;height:100%;display:block';
      iframe.srcdoc = await this.buildSrcdoc(app);

      const instance = {
        id: ++this._seq,
        appId,
        app,
        iframe,
        title: app.manifest.name,
        openPath,
        ready: false,
        onTitleChange: null,  // デスクトップが設定
        onClose: null,        // デスクトップが設定
        send: (msg) => { if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, '*'); },
      };
      this.instances.set(instance.id, instance);
      host.appendChild(iframe);
      if (this.kernel.desktop.attach) this.kernel.desktop.attach(instance, host);
      return instance;
    }

    close(instanceId) {
      const inst = this.instances.get(instanceId);
      if (!inst) return;
      this.instances.delete(instanceId);
      inst.iframe.remove();
      if (inst.onClose) inst.onClose();
    }

    // ---- HTML 組み立て ----
    async buildSrcdoc(app) {
      const html = await this._text(app.entryPath);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const entryDir = app.entryPath.replace(/\/[^/]*$/, '');

      // アプリフォルダ内の相対パスだけを解決する（../ でフォルダ外には出さない）
      const localPath = (url) => {
        if (!app.baseDir || !url || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return null;
        const p = joinPath(entryDir, url.split(/[?#]/)[0]);
        return (p === app.baseDir || p.startsWith(app.baseDir + '/')) ? p : null;
      };

      for (const el of [...doc.querySelectorAll('script[src]')]) {
        const p = localPath(el.getAttribute('src'));
        if (!p) continue;
        el.removeAttribute('src');
        el.textContent = (await this._text(p)).replace(/<\/script/gi, '<\\/script');
      }

      for (const el of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
        const p = localPath(el.getAttribute('href'));
        if (!p) continue;
        const style = doc.createElement('style');
        style.textContent = (await this._text(p)).replace(/<\/style/gi, '<\\/style');
        el.replaceWith(style);
      }

      for (const el of [...doc.querySelectorAll('img[src], audio[src], video[src], source[src]')]) {
        const p = localPath(el.getAttribute('src'));
        if (!p) continue;
        el.setAttribute('src', await blobToDataUrl(await this.kernel.readFile(p), p));
      }

      const ic = doc.createElement('script');
      ic.textContent = 'window.__TI__=' + JSON.stringify(window.TrainOSIcons || {}) + ';';
      doc.head.insertBefore(ic, doc.head.firstChild);

      const sdk = doc.createElement('script');
      sdk.textContent = '(' + sdkMain.toString() + ')();';
      doc.head.insertBefore(sdk, doc.head.firstChild);

      return '<!doctype html>\n' + doc.documentElement.outerHTML;
    }

    // ---- システムコール ----
    _onMessage(e) {
      const inst = [...this.instances.values()].find((i) => i.iframe.contentWindow === e.source);
      if (!inst) return;
      const m = e.data || {};
      if (m.type === 'ready') {
        inst.ready = true;
        if (inst.openPath) inst.send({ type: 'open', path: inst.openPath });
      } else if (m.type === 'syscall') {
        this._handleSyscall(inst, m);
      }
    }

    async _handleSyscall(inst, msg) {
      const { id, method, args } = msg;
      try {
        if (!Object.prototype.hasOwnProperty.call(this.syscalls, method)) {
          throw new Error('不明なシステムコール: ' + method);
        }
        const sc = this.syscalls[method];
        if (sc.perm && !inst.app.manifest.permissions.includes(sc.perm)) {
          throw new Error('権限がありません: ' + sc.perm);
        }
        const result = await sc.fn(inst, ...(Array.isArray(args) ? args : []));
        inst.send({ type: 'result', id, result: result === undefined ? null : result });
      } catch (err) {
        inst.send({ type: 'result', id, error: String((err && err.message) || err) });
      }
    }

    async _text(path) {
      return (await this.kernel.readFile(path)).text();
    }
  }

  window.TrainOSAppLoader = AppLoader;
})();
