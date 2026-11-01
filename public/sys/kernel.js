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

  // キーの組み合わせを "Alt+T" のような文字列にする（配列に依らず code から決める）
  const keyCombo = (e) => {
    const k = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3)
      : /^Digit\d$/.test(e.code || '') ? e.code.slice(5)
      : e.code === 'Space' ? 'Space' : e.code === 'Comma' ? ',' : e.code === 'Period' ? '.'
      : (e.key || '').length === 1 ? e.key.toUpperCase() : (e.key || '');
    if (!k || ['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return '';
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+');
  };

  const K = {
    version: '0.3.2',
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
      if (patch.desktopEnv) { // デスクトップ環境: sys/desktops/<名前>.json の項目を、まとめて設定に入れる
        if (!/^[\w-]+$/.test(patch.desktopEnv)) throw new Error('不正な名前');
        const de = await this.readJson('/sys/desktops/' + patch.desktopEnv + '.json');
        const merged = {};
        for (const k of ['windowManager', 'windowTheme', 'shellTheme', 'cursor', 'wallpaper', 'animation', 'panel', 'iconset', 'keymap', 'font']) if (k in de) merged[k] = de[k];
        patch = Object.assign(merged, patch);
      }
      const ok = ['theme', 'wallpaper', 'language', 'bootLoader', 'syncMinutes', 'desktop', 'fileTypeHandlers', 'disabledComponents', 'dock', 'font', 'keymap', 'iconset',
        'desktopEnv', 'windowManager', 'windowTheme', 'shellTheme', 'cursor', 'animation', 'panel'];
      for (const k of Object.keys(patch)) if (ok.includes(k)) this.settings[k] = patch[k];
      if (patch.bootLoader) {
        await window.TrainOSBoot.use(this, patch.bootLoader); // キャッシュ更新 + settings.json 保存
      } else {
        if ('bootLoader' in patch) localStorage.removeItem('trainos.bootLoader');
        await this.writeFile('/sys/settings.json', JSON.stringify(this.settings, null, 2));
      }
      if (this.backend && 'delay' in this.backend) this.backend.delay = (this.settings.syncMinutes || 10) * 60000;
      await this.loadIconset();
      await this.desktop.apply();
      await this.loadKeymap();
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
      const json = (dir) => this.names(dir, /\.json$/).map((n) => n.replace(/\.json$/, ''));
      const css = (dir) => this.names(dir, /\.css$/).map((n) => n.replace(/\.css$/, ''));
      return {
        version: this.version, backend: localStorage.getItem('trainos.backend'),
        user: (this.backend && this.backend.user) || null, bootLoaders, safe: this.safe,
        desktops: json('/sys/desktops'),
        windowManagers: this.names('/sys/wm', /\.js$/).map((n) => n.replace(/\.js$/, '')),
        windowThemes: css('/sys/window_themes'), shellThemes: css('/sys/shell_themes'),
        animations: css('/sys/animations'), cursors: json('/sys/cursors'),
        panels: [...new Set([...json('/sys/panels'), ...json('/sys/docks')])].sort(), // docks は v0.3.1 の古い置き場所
        wallpapers: this.names('/sys/wallpapers', /\.(png|jpe?g|gif|webp|svg|html)$/i),
        components: this.names('/sys/components', /\.js$/),
        keymaps: json('/sys/keymaps'), iconsets: json('/sys/iconsets'),
        fonts: this.names('/sys/fonts', /\.(woff2?|ttf|otf)$/i),
      };
    },

    async readJson(path) { return JSON.parse(await (await this.readFile(path)).text()); },

    // アイコンセット: sys/iconsets/<名前>.json の {アイコン名: {vb, d}} で、標準のアイコンを差し替える
    async loadIconset() {
      const icons = window.TrainOSIcons;
      this._icons0 = this._icons0 || Object.assign({}, icons);
      for (const k of Object.keys(icons)) delete icons[k];
      Object.assign(icons, this._icons0);
      const n = this.settings.iconset;
      if (this.safe || !n || !/^[\w-]+$/.test(n)) return;
      try {
        const set = await this.readJson('/sys/iconsets/' + n + '.json');
        for (const [k, v] of Object.entries(set)) {
          // SVG の属性に入るので、引用符や < > を含むものは受け付けない
          if (/^[\w-]+$/.test(k) && v && typeof v.vb === 'string' && typeof v.d === 'string' && !/["<>]/.test(v.vb + v.d)) icons[k] = { vb: v.vb, d: v.d };
        }
      } catch (e) { console.warn('[kernel] iconset を読めません', e); }
    },

    // キー割り当て: sys/keymaps/<名前>.json の {"Alt+T": アクション}
    async loadKeymap() {
      this.keys = {};
      const n = this.settings.keymap === undefined ? 'default' : this.settings.keymap;
      if (this.safe || !n || !/^[\w-]+$/.test(n)) return;
      try { this.keys = await this.readJson('/sys/keymaps/' + n + '.json'); }
      catch (e) { console.warn('[kernel] keymap を読めません', e); }
    },

    // 割り当てがあれば実行して true を返す（e は KeyboardEvent か、同じ項目を持つ普通のオブジェクト）
    handleKey(e) {
      const c = keyCombo(e);
      if (!c || !this.keys || !Object.prototype.hasOwnProperty.call(this.keys, c)) return false;
      const a = this.keys[c];
      const warn = (err) => console.warn('[kernel] キー操作に失敗', err);
      if (typeof a === 'string') { if (!this.desktop.act(a)) return false; }
      else if (a && a.launch) this.apps.launch(a.launch, { openPath: a.openPath }).catch(warn);
      else if (a && a.open) this.openFile(a.open).catch(warn);
      else return false;
      return true;
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

        await this.loadIconset();

        B.progress({ value: 75, label: 'アプリを走査中…' });
        this.desktop = window.TrainOSDesktop.create(this);
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

        await this.desktop.start();
        await this.loadKeymap();
        document.addEventListener('keydown', (e) => { if (this.handleKey(e)) e.preventDefault(); });
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

  window.TrainOSKernel = K;
})();
