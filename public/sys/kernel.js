// TrainOS / sys/kernel.js
// OS の核。起動、VFS（メモリ上のツリー）、セーフモード、components の読み込み、最小のデスクトップ。
// 保存先はローカルフォルダのみ対応。Google Drive 版（認証・トークン管理）は未実装。
//
// components: sys/components/*.js を名前順に実行する。各ファイルには `kernel` が渡される
//   （kernel.desktop / kernel.apps / kernel.settings など）。1つ壊れても他は動く。

(function () {
  'use strict';

  const norm = (p) => '/' + String(p).split('/').reduce((a, s) => {
    if (s && s !== '.') { if (s === '..') a.pop(); else a.push(s); }
    return a;
  }, []).join('/');
  const split = (np) => { const i = np.lastIndexOf('/'); return [np.slice(0, i) || '/', np.slice(i + 1)]; };
  const entry = (c) => ({ id: c.id, name: c.name, isDirectory: c.isDirectory, mimeType: c.mimeType, size: c.size, modifiedTime: c.modifiedTime });

  const I = (n) => window.TrainOSIcon(n);

  const K = {
    version: '0.3.0',
    safe: false, settings: {}, index: null, backend: null, desktop: null, apps: null, _ev: {},
    on(n, f) { (this._ev[n] = this._ev[n] || []).push(f); },
    emit(n, ...a) { for (const f of this._ev[n] || []) { try { f(...a); } catch (e) { console.warn(e); } } },

    // ---- VFS: 読み取りはメモリ上のツリー（通信なし）。書き込みはバックエンドへ即時 ----
    find(path) {
      let n = this.index;
      for (const s of norm(path).split('/').filter(Boolean)) {
        n = (n.children || []).find((c) => c.name === s);
        if (!n) return null;
      }
      return n;
    },
    _mkdirIdx(np) {
      let n = this.index, p = '';
      for (const s of np.split('/').filter(Boolean)) {
        p += '/' + s;
        let c = (n.children || []).find((x) => x.name === s);
        if (!c) {
          c = { id: p, name: s, isDirectory: true, mimeType: 'inode/directory', children: [], modifiedTime: new Date().toISOString() };
          n.children.push(c);
        }
        n = c;
      }
      return n;
    },
    async readFile(path) {
      const f = this.find(path);
      if (!f || f.isDirectory) throw new Error('ファイルがありません: ' + path);
      return this.backend.readFile(norm(path));
    },
    async writeFile(path, content) {
      const np = norm(path);
      if (np === '/') throw new Error('不正なパス');
      const blob = content instanceof Blob ? content : new Blob([content]);
      await this.backend.writeFile(np, blob);
      const [dir, name] = split(np);
      const d = this._mkdirIdx(dir);
      const node = { id: np, name, isDirectory: false, mimeType: blob.type, size: blob.size, modifiedTime: new Date().toISOString(), children: null };
      const i = d.children.findIndex((c) => c.name === name);
      if (i >= 0) d.children[i] = node; else d.children.push(node);
      this.emit('fs', np);
    },
    async createDirectory(path) {
      const np = norm(path);
      await this.backend.mkdir(np);
      this._mkdirIdx(np);
      this.emit('fs', np);
    },
    async deleteFile(path) {
      const np = norm(path);
      if (np === '/') throw new Error('ルートは削除できません');
      await this.backend.remove(np);
      const [dir, name] = split(np);
      const d = this.find(dir);
      if (d) d.children = d.children.filter((c) => c.name !== name);
      this.emit('fs', np);
    },
    async listDirectory(path) {
      const d = this.find(path);
      if (!d || !d.isDirectory) throw new Error('フォルダがありません: ' + path);
      return d.children.map(entry);
    },
    async getFileTree(path) {
      const n = this.find(path || '/');
      if (!n) throw new Error('見つかりません: ' + path);
      return n;
    },

    // フォルダも含めて移動（コピーしてから元を削除。名前の変更にも使う）
    async move(from, to) {
      const a = norm(from), b = norm(to);
      if (a === '/' || b === a || b.startsWith(a + '/')) throw new Error('移動できません');
      if (this.find(b)) throw new Error('すでに存在します: ' + b);
      if (!this.find(a)) throw new Error('見つかりません: ' + a);
      const copy = async (src, dst) => {
        const n = this.find(src);
        if (n.isDirectory) {
          await this.createDirectory(dst);
          for (const c of [...n.children]) await copy(src + '/' + c.name, dst + '/' + c.name);
        } else {
          await this.writeFile(dst, await this.readFile(src));
        }
      };
      await copy(a, b);
      await this.deleteFile(a);
    },

    // 標準ファイルの更新・復元（skeleton.js の updateDefaults）。kernel 経由で読み書きするので一覧にも反映される
    restoreDefaults(force) {
      return window.TrainOSSkeleton.updateDefaults(this.backend, {
        tree: this.index, force: !!force,
        write: (p, b) => this.writeFile(p, b), read: (p) => this.readFile(p),
      });
    },

    async flush() { if (this.backend && this.backend.flush) await this.backend.flush(); },

    // ---- 設定 ----
    async setSettings(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('不正な設定');
      const ok = ['theme', 'wallpaper', 'language', 'bootLoader', 'syncMinutes', 'desktop', 'fileTypeHandlers', 'disabledComponents'];
      for (const k of Object.keys(patch)) if (ok.includes(k)) this.settings[k] = patch[k];
      if (patch.bootLoader) {
        await window.TrainOSBoot.use(this, patch.bootLoader); // キャッシュ更新 + settings.json 保存
      } else {
        if ('bootLoader' in patch) localStorage.removeItem('trainos.bootLoader');
        await this.writeFile('/sys/settings.json', JSON.stringify(this.settings, null, 2));
      }
      if (this.backend && 'delay' in this.backend) this.backend.delay = (this.settings.syncMinutes || 10) * 60000;
      this.desktop.applySettings();
      this.emit('settings');
    },

    // フォルダ内のファイル名の一覧（切り替えできるものを設定画面に出すため）
    names(path, re) {
      const d = this.find(path);
      return ((d && d.children) || []).filter((c) => !c.isDirectory && re.test(c.name)).map((c) => c.name).sort();
    },

    async info() {
      let bootLoaders = [];
      try { bootLoaders = await window.TrainOSBoot.list(this); } catch (e) { /* フォルダが無いだけ */ }
      return {
        version: this.version, backend: localStorage.getItem('trainos.backend'),
        user: (this.backend && this.backend.user) || null, bootLoaders, safe: this.safe,
        themes: this.names('/sys/themes', /\.css$/).map((n) => n.replace(/\.css$/, '')),
        wallpapers: this.names('/sys/wallpapers', /\.(png|jpe?g|gif|webp|svg)$/i),
        components: this.names('/sys/components', /\.js$/),
      };
    },

    // ---- アプリ ----
    launchApp(id, opts) { return this.apps.launch(id, opts); },
    openFile(path) { return this.apps.openFile(path); },

    // ---- components（セーフモードでは読み込まない）----
    async loadComponents() {
      const dir = this.find('/sys/components');
      const files = ((dir && dir.children) || []).filter((c) => !c.isDirectory && /\.js$/.test(c.name))
        .map((c) => c.name).sort()
        .filter((n) => !(this.settings.disabledComponents || []).includes(n)); // 設定画面でオフにしたもの
      for (const name of files) {
        try {
          const code = await (await this.readFile('/sys/components/' + name)).text();
          new Function('kernel', code)(this);
        } catch (e) {
          console.warn('[kernel] component 失敗:', name, e);
        }
      }
    },

    // Drive 版: ポップアップはクリック操作が必要なので、ログインボタンを出して待つ
    _login() {
      return new Promise((ok) => {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;background:#000c;color:#eee;font:14px system-ui';
        const b = document.createElement('button');
        b.style.cssText = 'font:inherit;padding:8px 16px;cursor:pointer';
        b.innerHTML = I('google') + ' Google でログイン';
        const msg = document.createElement('p');
        const a = document.createElement('a');
        a.href = 'index.html';
        a.textContent = '保存先を選び直す';
        a.style.color = '#8cf';
        b.onclick = async () => {
          b.disabled = true;
          try { await this.backend.login(); d.remove(); ok(); }
          catch (e) { msg.textContent = (e && e.message) || String(e); b.disabled = false; }
        };
        d.append(b, msg, a);
        document.body.appendChild(d);
      });
    },

    // ---- 起動 ----
    async boot() {
      const B = window.TrainOSBoot;
      this.safe = new URLSearchParams(location.search).get('mode') === 'safe';
      B.start({ safe: this.safe });
      try {
        B.progress({ value: 5, label: 'ストレージを開いています…' });
        const kind = localStorage.getItem('trainos.backend');
        if (kind === 'drive') { this.backend = new window.TrainOSDriveBackend(); await this._login(); }
        else if (kind === 'local') this.backend = await window.TrainOSLocalBackend.open();
        else throw new Error('保存先が未選択です。index.html から起動してください');

        B.progress({ value: 20, label: 'フォルダを確認中…' });
        const S = window.TrainOSSkeleton;
        if ((await S.ensureSkeleton(this.backend)) === 'needs-confirm') {
          if (!confirm('このフォルダには別のファイルがあります。ここに sys/ と usr/ を作りますか？')) throw new Error('キャンセルしました');
          await S.ensureSkeleton(this.backend, { force: true });
        }

        B.progress({ value: 40, label: 'ファイル一覧を読み込み中…' });
        this.index = await this.backend.buildIndex();
        try { this.settings = JSON.parse(await (await this.readFile('/sys/settings.json')).text()); }
        catch (e) { console.warn('[kernel] settings.json を読めません。既定値で続行', e); this.settings = {}; }
        if ('delay' in this.backend) this.backend.delay = (this.settings.syncMinutes || 10) * 60000;

        // バージョンが変わっていたら、標準ファイルを見比べて反映する（/sys/installed.json に入れた版が書いてある）
        let installed = null;
        try { installed = JSON.parse(await (await this.readFile('/sys/installed.json')).text()).version; } catch (e) { /* 未作成 */ }
        if (installed !== this.version) {
          try {
            B.progress({ value: 48, label: '標準ファイルを更新中…' });
            const r = this.updateReport = await this.restoreDefaults();
            console.info('[kernel] 標準ファイル: コピー ' + r.copied.length + ' / 更新 ' + r.updated.length + ' / 編集済み(.new) ' + r.conflicts.length, r);
          } catch (e) { console.warn('[kernel] 標準ファイルの更新に失敗（次回また試します）', e); }
        }

        if (!this.safe) {
          if (this.settings.bootLoader) await B.cache(this, this.settings.bootLoader).catch(() => {});
          B.progress({ value: 55, label: 'components を読み込み中…' });
          await this.loadComponents();
        }

        B.progress({ value: 75, label: 'アプリを走査中…' });
        this.desktop = makeDesktop(this);
        this.apps = new window.TrainOSAppLoader(this);
        await this.apps.scan();

        // sys/apps/ を書き換えたらアプリ一覧を自動で更新（置くだけで使える）
        let t;
        this.on('fs', (p) => {
          if (!p.startsWith('/sys/apps')) return;
          clearTimeout(t);
          t = setTimeout(() => this.apps.scan().then(() => this.desktop.renderIcons()), 300);
        });
        window.addEventListener('beforeunload', (e) => {
          if (this.backend && this.backend.pending && this.backend.pending.size) { e.preventDefault(); e.returnValue = ''; }
        });

        this.desktop.render();
        B.progress({ value: 100, label: '完了' });
        B.done();
      } catch (e) {
        fail(e);
      }
    },
  };

  function fail(e) {
    console.error(e);
    const el = document.getElementById('boot-screen');
    if (!el) return;
    el.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'padding:24px;font:14px system-ui';
    p.textContent = '起動に失敗しました: ' + ((e && e.message) || e);
    const a = document.createElement('a');
    a.href = 'index.html';
    a.textContent = 'index.html に戻る';
    a.style.cssText = 'padding:0 24px;color:#8cf';
    el.append(p, a);
  }

  // デスクトップ: アイコン、ランチャー、ドラッグできるウィンドウ。
  // app_loader が createWindow(app) で中身の要素をもらい、attach(instance, host) でつなぐ。
  function makeDesktop(kernel) {
    const desk = document.getElementById('desktop');
    const bar = document.getElementById('bar');
    const icons = document.createElement('div');
    icons.id = 'icons';
    desk.appendChild(icons);
    const themeEl = document.createElement('style'); // sys/themes/<名前>.css を入れる
    document.head.appendChild(themeEl);
    let z = 1, n = 0;

    const D = {
      createWindow(app) {
        const w = document.createElement('div');
        w.className = 'win';
        const { width, height } = app.manifest.window;
        w.style.cssText = 'left:' + (40 + (n % 8) * 28) + 'px;top:' + (30 + (n % 8) * 28) + 'px;width:' + width + 'px;height:' + height + 'px;z-index:' + (++z);
        n++;
        w.innerHTML = '<div class="t"><span></span><button title="閉じる">' + I('xmark') + '</button></div><div class="c"></div>';
        w.addEventListener('pointerdown', () => { w.style.zIndex = ++z; }, true);
        desk.appendChild(w);
        const c = w.querySelector('.c');
        c._win = w;
        return c;
      },

      attach(instance, host) {
        const w = host._win;
        const t = w.querySelector('.t');
        const title = t.querySelector('span');
        title.textContent = instance.title;
        instance.onTitleChange = (s) => { title.textContent = s; };
        instance.onClose = () => w.remove();
        t.querySelector('button').onclick = () => kernel.apps.close(instance.id);
        t.onpointerdown = (e) => {
          if (e.target.closest('button')) return;
          const dx = e.clientX - w.offsetLeft, dy = e.clientY - w.offsetTop;
          t.setPointerCapture(e.pointerId);
          desk.classList.add('drag');
          t.onpointermove = (m) => { w.style.left = (m.clientX - dx) + 'px'; w.style.top = Math.max(0, m.clientY - dy) + 'px'; };
          t.onpointerup = () => { t.onpointermove = t.onpointerup = null; desk.classList.remove('drag'); };
        };
      },

      // テーマ: sys/themes/<名前>.css を <style> に入れる（色は CSS 変数で決まる）
      // 壁紙: '#色' などの色 / '/パス' / sys/wallpapers 内のファイル名
      applySettings() {
        const s = kernel.settings;
        const theme = /^[\w-]+$/.test(s.theme || '') ? s.theme : 'light';
        kernel.readFile('/sys/themes/' + theme + '.css').then((b) => b.text())
          .then((css) => { themeEl.textContent = css; }, () => { themeEl.textContent = ''; });
        const w = s.wallpaper || '';
        const file = /^[\w-]+\.(png|jpe?g|gif|webp|svg)$/i.test(w) ? '/sys/wallpapers/' + w : w.startsWith('/') ? w : null;
        desk.style.background = '';
        if (file) {
          const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[file.split('.').pop().toLowerCase()] || '';
          kernel.readFile(file).then((blob) => {
            if (D._wp) URL.revokeObjectURL(D._wp);
            D._wp = URL.createObjectURL(new Blob([blob], { type }));
            desk.style.background = 'center / cover url(' + D._wp + ')';
          }).catch(() => {});
        } else if (w) {
          desk.style.background = w;
        }
      },

      // デスクトップのアイコン: settings の shortcuts と /usr/desktop の中身
      renderIcons() {
        icons.replaceChildren();
        const add = (name, icon, open) => {
          const b = document.createElement('button');
          b.className = 'ico';
          b.innerHTML = I(icon) + '<span></span>';
          b.lastChild.textContent = name;
          b.ondblclick = () => open().catch((e) => alert(e.message));
          icons.appendChild(b);
        };
        const sc = (kernel.settings.desktop && kernel.settings.desktop.shortcuts) || [];
        for (const s of sc) {
          if (s.app) {
            const a = kernel.apps.registry.get(s.app);
            if (a) add(s.name, a.manifest.icon, () => kernel.launchApp(s.app));
          } else if (s.path) {
            add(s.name, 'folder', () => kernel.openFile(s.path));
          }
        }
        const d = kernel.find('/usr/desktop');
        for (const c of (d && d.children) || []) {
          add(c.name, c.isDirectory ? 'folder' : 'file', () => kernel.openFile('/usr/desktop/' + c.name));
        }
      },

      render() {
        const b = document.createElement('button');
        b.innerHTML = I('train') + ' TrainOS';
        const m = document.createElement('div');
        m.id = 'menu';
        m.hidden = true;
        b.onclick = () => {
          m.replaceChildren(...kernel.apps.list().map((a) => {
            const i = document.createElement('button');
            i.innerHTML = I(a.icon) + '<span></span>';
            i.lastChild.textContent = a.name;
            i.onclick = () => { m.hidden = true; kernel.apps.launch(a.id).catch((err) => alert(err.message)); };
            return i;
          }));
          m.hidden = !m.hidden;
        };
        bar.append(b, m);

        if (kernel.backend.flush) {
          const sb = document.createElement('button');
          sb.title = 'Google Drive に保存';
          const upd = (c) => { sb.innerHTML = I('floppy-disk') + (c ? ' ' + c : ''); sb.disabled = !c; };
          upd(0);
          kernel.backend.onPending = upd;
          sb.onclick = () => kernel.flush().catch((e) => alert(e.message));
          bar.append(sb);
        }
        if (kernel.safe) {
          const s = document.createElement('span');
          s.textContent = 'セーフモード（components 無効）';
          bar.append(s);
        }
        const v = document.createElement('span');
        v.style.marginLeft = 'auto';
        v.textContent = 'v' + kernel.version;
        bar.append(v);

        D.applySettings();
        D.renderIcons();
        kernel.on('fs', (p) => { if (p.startsWith('/usr/desktop')) D.renderIcons(); });
        kernel.on('settings', () => D.renderIcons());
      },
    };
    return D;
  }

  window.TrainOSKernel = K;
})();
