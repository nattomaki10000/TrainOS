// TrainOS / sys/app_loader.js
// sys/apps/ を走査してアプリを登録し、iframe サンドボックスで起動する。
//
// kernel に必要なもの:
//   readFile / writeFile / listDirectory / createDirectory / deleteFile / getFileTree
//   desktop.createWindow(app) -> HTMLElement   （デスクトップ側が実装。ウィンドウの中身の要素を返す）
//   settings.fileTypeHandlers（任意）          （拡張子 -> アプリID の上書き）
//   runHook / emit / askPermissions / _modal（任意）  （v0.7.0: components のフック、イベント、権限の確認画面、ダイアログ）
//
// 使い方:
//   kernel.apps = new TrainOSAppLoader(kernel);
//   await kernel.apps.scan();
//   await kernel.apps.launch('notepad');
//   await kernel.apps.openFile('/usr/documents/memo.txt');

(function () {
  'use strict';

  const APPS_DIR = '/sys/apps';
  const PERM_FILE = '/sys/permissions.json'; // アプリごとの許可の記録: { version: 1, apps: { id: { granted, denied, at } } }
  const INSTALLED_FILE = '/sys/installed.json';

  // SHA-256（16進）。標準アプリの app.json に手を加えていないかを、installed.json の記録と見比べるのに使う
  async function sha256(blob) {
    const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

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
      } else if (m.type === 'style') {
        const s = document.getElementById('__trainos_css__'); // OS のテーマ・フォント・カーソルが変わった
        if (s) s.textContent = m.css;
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
        restoreDefaults: (force) => call('restoreDefaults', force),
        saveKeymap: (name, map) => call('saveKeymap', name, map),
        getPermissions: () => call('getPermissions'),
        setAppPermission: (id, perm, allowed) => call('setAppPermission', id, perm, !!allowed),
        resetAppPermissions: (id) => call('resetAppPermissions', id),
        addStartup: (id) => call('addStartup', id),
        removeStartup: (name) => call('removeStartup', name),
      },
      // alert / confirm / prompt の代わり（アプリのウィンドウの中に、モーダルで出る。権限は不要）
      ui: {
        alert: (message, o) => call('uiDialog', Object.assign({}, o, { type: 'alert', message })).then(() => undefined),
        confirm: (message, o) => call('uiDialog', Object.assign({}, o, { type: 'confirm', message })).then((v) => v === true),
        prompt: (message, o) => call('uiDialog', Object.assign({}, o, { type: 'prompt', message })),
        choose: (message, buttons, o) => call('uiDialog', Object.assign({}, o, { type: 'choose', message, buttons })),
      },
      sound: { play: (name) => call('playSound', name) }, // 効果音のテーマにある名前だけ鳴る
      fs: {
        readFile: (p) => call('readFile', p),
        readText: async (p) => (await call('readFile', p)).text(),
        writeFile: (p, c) => call('writeFile', p, c instanceof Blob ? c : new Blob([c])),
        list: (p) => call('listDirectory', p),
        tree: (p) => call('getFileTree', p),
        mkdir: (p) => call('createDirectory', p),
        remove: (p) => call('deleteFile', p),
        move: (a, b) => call('moveFile', a, b),
        copy: (a, b) => call('copyFile', a, b),                                            // フォルダは中身ごと
        download: (name, c) => call('download', name, c instanceof Blob ? c : new Blob([c])), // ブラウザのダウンロードとして保存する
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

    // alert は、同じ見た目のダイアログにする（待たずに続く）。confirm / prompt は、同期で答えを返せないので、そのまま（TrainOS.ui を使う）
    window.alert = (m) => { window.TrainOS.ui.alert(m).catch(() => {}); };

    // アプリの中をクリックしたら、そのウィンドウを前面に出す（親は iframe の中のクリックを受け取れないため）
    window.addEventListener('pointerdown', () => parent.postMessage({ type: 'focus' }, '*'), true);

    // Alt / Meta を含むキーは、アプリの中でも OS のキー割り当てが効くように親へ渡す
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.metaKey) {
        parent.postMessage({ type: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey }, '*');
      }
    });

    parent.postMessage({ type: 'ready' }, '*');
  }

  class AppLoader {
    constructor(kernel) {
      this.kernel = kernel;
      this.registry = new Map();   // appId -> { id, manifest, baseDir, entryPath }
      this.instances = new Map();  // instanceId -> instance
      this._seq = 0;
      this._ask = new Map();       // appId -> 確認画面の待ち（二重に出さない）
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
        copyFile:        { perm: 'fs.write',        fn: (i, a, b) => kernel.copy(a, b) },
        download:        { perm: 'fs.read',         fn: (i, name, blob) => this.download(name, blob) },
        saveKeymap:      { perm: 'system.settings', fn: (i, n, m) => kernel.saveKeymap(n, m).then(() => null) },
        getSettings:     { perm: 'system.settings', fn: async () => ({ settings: kernel.settings, info: await kernel.info() }) },
        setSettings:     { perm: 'system.settings', fn: (i, p) => kernel.setSettings(p).then(() => null) },
        flush:           { perm: 'system.settings', fn: () => kernel.flush().then(() => null) },
        restoreDefaults: { perm: 'system.settings', fn: (i, force) => kernel.restoreDefaults(!!force) },
        // v0.7.0
        uiDialog:        { perm: null,              fn: (i, spec) => this.appDialog(i, spec) },
        playSound:       { perm: null,              fn: (i, name) => this._playSound(i, name) },
        getPermissions:  { perm: 'system.settings', fn: () => this.getPermissions() },
        setAppPermission:   { perm: 'system.settings', fn: (i, id, perm, allowed) => this.setPermission(id, perm, allowed) },
        resetAppPermissions: { perm: 'system.settings', fn: (i, id) => this.resetPermissions(id) },
        addStartup:      { perm: 'system.settings', fn: (i, id) => kernel.addStartup(id) },
        removeStartup:   { perm: 'system.settings', fn: (i, name) => kernel.removeStartup(name).then(() => null) },
      };
    }

    destroy() {
      window.removeEventListener('message', this._onMessage);
      for (const id of [...this.instances.keys()]) this.close(id);
    }

    // ---- 走査（VFS のメモリ上ツリーだけを見る。通信なし）----
    async scan() {
      const next = this._reg = new Map(); // 走査中も、いまの一覧を使えるように、できあがってから入れ替える
      // 標準アプリ: installed.json に入れたときのハッシュが書いてあり、app.json が今もそのままのもの。権限の確認なしで起動する
      let installed = {};
      try { installed = JSON.parse(await this._text(INSTALLED_FILE)).files || {}; } catch (e) { /* まだ無い */ }
      const dir = await this.kernel.getFileTree(APPS_DIR);
      for (const node of (dir && dir.children) || []) {
        try {
          if (node.isDirectory) await this._registerFolder(node, installed);
          else if (/\.html?$/i.test(node.name)) this._registerSingle(node);
        } catch (e) {
          console.warn('[AppLoader] skip', node.name, e);
        }
      }
      this.registry = next;
      return [...this.registry.values()].map((a) => a.manifest);
    }

    async _registerFolder(node, installed) {
      const names = new Set((node.children || []).map((c) => c.name));
      let raw = {}, trusted = false;
      if (names.has('app.json')) {
        let blob = null;
        try {
          blob = await this.kernel.readFile(APPS_DIR + '/' + node.name + '/app.json');
          raw = JSON.parse(await blob.text());
        } catch (e) {
          blob = null;
          console.warn('[AppLoader] app.json が壊れています。既定値で登録:', node.name, e);
        }
        const want = blob && installed && installed['sys/apps/' + node.name + '/app.json'];
        if (want) { try { trusted = (await sha256(blob)) === want; } catch (e) { /* 確かめられないときは、確認する */ } }
      }
      const m = normalizeManifest(raw, node.name.replace(/[^\w-]/g, '_'));
      const baseDir = APPS_DIR + '/' + node.name;
      this._reg.set(m.id, { id: m.id, manifest: m, baseDir, entryPath: joinPath(baseDir, m.entry), trusted });
    }

    _registerSingle(node) {
      const id = node.name.replace(/\.html?$/i, '').replace(/[^\w-]/g, '_');
      const m = normalizeManifest({ id }, id);
      // baseDir = null: 相対参照のインライン化はしない（単体で完結させる）
      this._reg.set(m.id, { id: m.id, manifest: m, baseDir: null, entryPath: APPS_DIR + '/' + node.name, trusted: false });
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
      // components のフックで、開くアプリを変えたり、中止したりできる（アプリが無い拡張子に割り当てることもできる）
      const ctx = { path, appId: this.resolveHandler(path) };
      if (!(await this._hook('openFile', ctx))) return null;
      if (typeof ctx.appId !== 'string' || !this.registry.has(ctx.appId)) throw new Error('このファイルを開けるアプリがありません: ' + path);
      if (this.kernel.emit) this.kernel.emit('file:open', { path, appId: ctx.appId });
      return this.launch(ctx.appId, { openPath: path });
    }

    // components のフック（kernel に無ければ、そのまま続ける）
    async _hook(name, ctx) { return this.kernel.runHook ? this.kernel.runHook(name, ctx) : true; }

    // ---- 起動 ----
    // 起動する。権限の確認で「起動しない」を選ばれたとき、フックに止められたときは null
    async launch(appId, opts) {
      let { openPath = null, container = null } = opts || {};
      const hc = { appId, openPath }; // フックは、起動するアプリと開くファイルを書き換えられる
      if (!(await this._hook('launch', hc))) return null;
      appId = hc.appId;
      openPath = typeof hc.openPath === 'string' ? hc.openPath : null;
      const app = this.registry.get(appId);
      if (!app) throw new Error('アプリが見つかりません: ' + appId);

      const single = () => {
        if (!app.manifest.singleInstance) return null;
        const existing = [...this.instances.values()].find((i) => i.appId === appId);
        if (!existing) return null;
        if (openPath) existing.send({ type: 'open', path: openPath });
        return existing;
      };
      const had = single();
      if (had) return had;

      const perms = await this.grantPermissions(app);
      if (!perms) return null;
      const again = single(); // 確認を待っている間に、同じアプリが開かれていたら、そちらを使う
      if (again) return again;

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
        perms,                // このインスタンスに許された権限（app.json の要求と、確認画面での許可の重なり）
        closed: false,
        ready: false,
        onTitleChange: null,  // デスクトップが設定
        onClose: null,        // デスクトップが設定
        send: (msg) => { if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, '*'); },
      };
      this.instances.set(instance.id, instance);
      host.appendChild(iframe);
      if (this.kernel.desktop.attach) this.kernel.desktop.attach(instance, host);
      if (this.kernel.emit) { this.kernel.emit('apps'); this.kernel.emit('app:launch', { instance }); }
      if (this.kernel.sound) this.kernel.sound.play('launch');
      return instance;
    }

    close(instanceId) {
      const inst = this.instances.get(instanceId);
      if (!inst) return;
      this.instances.delete(instanceId);
      inst.closed = true;
      for (const d of [...(inst.dialogs || [])]) d.cancel(); // 出ているダイアログは、キャンセル扱いで閉じる
      inst.iframe.remove();
      if (inst.onClose) inst.onClose();
      if (this.kernel.emit) { this.kernel.emit('apps'); this.kernel.emit('app:close', { instance: inst }); }
      if (this.kernel.sound) this.kernel.sound.play('close');
    }

    // ---- アプリのダイアログ（TrainOS.ui）: そのアプリのウィンドウの中だけを覆うので、ほかのウィンドウは使える ----
    // 見た目と答えは OS が決める。アプリが決められるのは、題名・本文・ボタンの文字と値だけ。
    // 「どのアプリからか」を OS が必ず先頭に出すので、アプリが OS を装うことはできない
    appDialog(inst, raw) {
      if (!this.kernel._modal) throw new Error('ダイアログを出せません');
      const s = raw && typeof raw === 'object' ? raw : {};
      const text = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);
      const type = ['alert', 'confirm', 'prompt', 'choose'].includes(s.type) ? s.type : 'alert';
      const ok = text(s.okLabel, 40) || 'OK', no = text(s.cancelLabel, 40) || 'キャンセル';
      const spec = { from: inst.app.manifest.name + ' からのメッセージ', title: text(s.title, 100), message: text(s.message, 4000), row: type !== 'choose', cancel: null };
      if (type === 'alert') { spec.buttons = [{ label: ok, value: true, primary: true }]; spec.cancel = true; }
      else if (type === 'confirm') { spec.buttons = [{ label: no, value: false }, { label: ok, value: true, primary: !s.danger, danger: !!s.danger }]; spec.cancel = false; spec.focus = s.danger ? 0 : 1; }
      else if (type === 'prompt') { spec.input = { value: text(s.value, 2000), placeholder: text(s.placeholder, 200), multiline: !!s.multiline }; spec.buttons = [{ label: no, value: null }, { label: ok, value: 'ok', primary: true }]; }
      else {
        spec.buttons = (Array.isArray(s.buttons) ? s.buttons : []).slice(0, 8).map((b) => {
          const o = b && typeof b === 'object' ? b : { label: b, value: b };
          const label = text(o.label, 80);
          return { label, value: ['string', 'number', 'boolean'].includes(typeof o.value) ? o.value : label };
        }).filter((b) => b.label);
        if (!spec.buttons.length) throw new Error('選択肢がありません');
      }
      if ((inst._dpend || 0) >= 10) throw new Error('ダイアログが多すぎます');
      inst._dpend = (inst._dpend || 0) + 1;
      const run = async () => {
        if (inst.closed || !inst.iframe.parentElement) return null;
        if (inst.focus) inst.focus();            // 隠れていたら出して、前に持ってくる
        inst.iframe.inert = true;                // ダイアログの間は、アプリの中を操作できない（キーボードも）
        inst.iframe.setAttribute('inert', '');
        const p = this.kernel._modal(spec, inst.iframe.parentElement);
        (inst.dialogs = inst.dialogs || []).push(p);
        try {
          const r = await p;
          return type === 'prompt' ? (r.button === 'ok' ? r.input : null) : r.button;
        } finally {
          inst.dialogs.splice(inst.dialogs.indexOf(p), 1);
          inst.iframe.inert = false;
          inst.iframe.removeAttribute('inert');
        }
      };
      const next = (inst._dq || Promise.resolve()).then(run); // 同じアプリのダイアログは、順番に出す
      inst._dq = next.catch(() => {}).then(() => { inst._dpend--; });
      return next;
    }

    _playSound(inst, name) {
      const now = Date.now();
      inst._snd = (inst._snd || []).filter((t) => now - t < 1000);
      if (inst._snd.length >= 8) return false; // 鳴らしすぎ
      inst._snd.push(now);
      return !!(this.kernel.sound && this.kernel.sound.play(name));
    }

    // ---- 権限 ----
    // 標準アプリ（trusted）は、app.json の要求どおりに、確認なしで許す。
    // それ以外は、初めて起動するとき（と、新しい権限を求めたとき）に確認画面を出し、/sys/permissions.json に記録する。
    // 許可したものと、断ったものの両方を覚えるので、断った権限を毎回聞き直すことはしない。「起動しない」は記録しない。
    async _readPerm() {
      try {
        const j = JSON.parse(await this._text(PERM_FILE));
        if (j && typeof j === 'object' && j.apps && typeof j.apps === 'object' && !Array.isArray(j.apps)) return j;
      } catch (e) { /* まだ無い、または壊れている */ }
      return { version: 1, apps: {} };
    }

    _writePerm(store) {
      this._pw = (this._pw || Promise.resolve()).catch(() => {}).then(() => this.kernel.writeFile(PERM_FILE, JSON.stringify(store, null, 2)));
      return this._pw;
    }

    _rec(store, id) {
      const r = Object.prototype.hasOwnProperty.call(store.apps, id) ? store.apps[id] : null;
      const list = (v) => (Array.isArray(v) ? v.map(String) : []);
      return { granted: list(r && r.granted), denied: list(r && r.denied), at: (r && r.at) || null };
    }

    // 許された権限の配列（要求した順）。「起動しない」なら null
    async grantPermissions(app) {
      const req = app.manifest.permissions;
      if (!req.length || app.trusted) return req.slice();
      const id = app.id;
      if (this._ask.has(id)) { const r = await this._ask.get(id); return r ? r.slice() : r; }
      const p = (async () => {
        const store = await this._readPerm();
        const rec = this._rec(store, id);
        const known = new Set([...rec.granted, ...rec.denied]);
        const need = req.filter((x) => !known.has(x));
        if (need.length) {
          const r = await this.kernel.askPermissions(app.manifest, need, rec);
          if (!r) return null;
          rec.granted = [...new Set([...rec.granted, ...r.granted])];
          rec.denied = [...new Set([...rec.denied, ...r.denied])];
          rec.at = new Date().toISOString();
          if (id !== '__proto__') {
            store.apps[id] = rec;
            try { await this._writePerm(store); } catch (e) { console.warn('[AppLoader] 権限の記録を保存できません（今回は有効）', e); }
          }
        }
        return req.filter((x) => rec.granted.includes(x));
      })();
      this._ask.set(id, p);
      try { return await p; } finally { this._ask.delete(id); }
    }

    // 設定画面用: すべてのアプリの、要求・許可・断った権限
    async getPermissions() {
      const store = await this._readPerm();
      return [...this.registry.values()].map((a) => {
        const req = a.manifest.permissions, r = this._rec(store, a.id);
        return {
          id: a.id, name: a.manifest.name, version: a.manifest.version, trusted: !!a.trusted, requested: req.slice(),
          granted: a.trusted ? req.slice() : req.filter((x) => r.granted.includes(x)),
          denied: a.trusted ? [] : req.filter((x) => r.denied.includes(x)),
        };
      });
    }

    _live(appId, perms) { for (const i of this.instances.values()) if (i.appId === appId) i.perms = perms.slice(); }

    // 許可・不許可を変える。開いているアプリにも、すぐ効く
    async setPermission(id, perm, allowed) {
      const app = this.registry.get(id);
      if (!app) throw new Error('アプリが見つかりません: ' + id);
      if (app.trusted) throw new Error('標準アプリの権限は変えられません');
      if (!app.manifest.permissions.includes(perm)) throw new Error('このアプリが求めていない権限です: ' + perm);
      if (id === '__proto__') throw new Error('このアプリの権限は記録できません');
      const store = await this._readPerm();
      const rec = this._rec(store, id);
      rec.granted = rec.granted.filter((x) => x !== perm);
      rec.denied = rec.denied.filter((x) => x !== perm);
      (allowed ? rec.granted : rec.denied).push(perm);
      rec.at = new Date().toISOString();
      store.apps[id] = rec;
      await this._writePerm(store);
      this._live(id, app.manifest.permissions.filter((x) => rec.granted.includes(x)));
      return null;
    }

    // 記録を消す。開いているアプリは権限をなくし、次に起動するとき、また確認する
    async resetPermissions(id) {
      const app = this.registry.get(id);
      if (!app) throw new Error('アプリが見つかりません: ' + id);
      if (app.trusted) throw new Error('標準アプリの権限は変えられません');
      const store = await this._readPerm();
      if (Object.prototype.hasOwnProperty.call(store.apps, id)) { delete store.apps[id]; await this._writePerm(store); }
      this._live(id, []);
      return null;
    }

    // アプリから頼まれたダウンロード。サンドボックスのアプリ自身はダウンロードできない（allow-downloads を付けない）ので、親が代わりに行う
    download(name, blob) {
      if (!(blob instanceof Blob)) throw new Error('ダウンロードするデータが不正です');
      const n = String(name || 'download').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'download';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = n;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return null;
    }

    // 開いているアプリすべてにメッセージを送る
    broadcast(msg) {
      for (const i of this.instances.values()) i.send(msg);
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

      // OS のテーマ・フォント・カーソルを、アプリの中にも渡す（設定が変わったら broadcast で更新される）
      const cs = doc.createElement('style');
      cs.id = '__trainos_css__';
      cs.textContent = this.kernel.appCss || '';
      doc.head.insertBefore(cs, doc.head.firstChild);

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
      } else if (m.type === 'key' && this.kernel.handleKey) {
        this.kernel.handleKey(m);
      } else if (m.type === 'focus' && inst.focus) {
        inst.focus();
      }
    }

    async _handleSyscall(inst, msg) {
      const { id, method, args } = msg;
      try {
        if (!Object.prototype.hasOwnProperty.call(this.syscalls, method)) {
          throw new Error('不明なシステムコール: ' + method);
        }
        const sc = this.syscalls[method];
        if (sc.perm && !(inst.perms || []).includes(sc.perm)) {
          throw new Error('権限がありません: ' + sc.perm);
        }
        // components のフック。false を返すと、このシステムコールは拒否される
        if (!(await this._hook('syscall', { appId: inst.appId, method, args: Array.isArray(args) ? args.slice() : [] }))) {
          throw new Error('components に拒否されました: ' + method);
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
