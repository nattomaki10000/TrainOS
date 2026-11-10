// TrainOS / sys/kernel.js
// OS の核。起動、VFS（メモリ上のツリー）、セーフモード、components の読み込み、最小のデスクトップ。
// 保存先はローカルフォルダのみ対応。Google Drive 版（認証・トークン管理）は未実装。
//
// components: sys/components/*.js を名前順に実行する。各ファイルには `kernel` と `component` が渡される
//   （kernel.desktop / kernel.apps / kernel.settings など）。1つ壊れても他は動く。
//   イベント: kernel.on / once / off（'ready' 'fs' 'settings' 'apps' 'app:launch' 'app:close' 'app:focus' 'file:open'）
//   フック:   kernel.hook(名前, fn)（'launch' 'openFile' 'fs.write' 'fs.delete' 'syscall'。false を返すと中止）
//   ダイアログ: kernel.ui.alert / confirm / prompt / choose。効果音: kernel.sound.play(名前)

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

  // キー割り当てに書ける操作（desktop.act が扱うもの）
  const ACTIONS = ['closeWindow', 'maximize', 'minimize', 'launcher', 'nextWindow', 'prevWindow', 'toMaster'];

  // アプリの権限の説明（確認画面と設定画面で使う）。danger は、確認画面で最初はチェックを外さない・赤く出すもの
  const PERM_INFO = {
    'fs.read': { label: 'ファイルを読む', desc: 'フォルダの中のファイルと、フォルダの一覧を読み取れます。', danger: false },
    'fs.write': { label: 'ファイルを書き換える', desc: 'ファイルの作成・変更・削除・移動ができます（sys/ の中の設定ファイルも含みます）。', danger: true },
    'app.launch': { label: '他のアプリを開く', desc: 'ファイルを開くために、他のアプリを起動できます。', danger: false },
    'system.settings': { label: 'OS の設定を変える', desc: 'テーマやキー割り当てなどの設定、アプリの権限（自分のものも）、標準ファイルの復元を変更できます。', danger: true },
  };

  // ダイアログの見た目。初回に <style> として入れる（OS 本体のダイアログも、アプリ用のダイアログも、同じ見た目）
  const UI_CSS = [
    '.tos-dialog{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:#0008;font-family:var(--font-ui,system-ui,sans-serif);font-size:var(--font-size,14px);line-height:1.5}',
    '.tos-dialog.in-win{position:absolute;z-index:50;background:#0006}',
    '.tos-box{background:var(--win-bg,#fff);color:var(--win-fg,#111);border:var(--win-border,1px solid #8886);border-radius:var(--win-radius,8px);padding:16px;max-width:min(460px,92%);max-height:92%;overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 30px #0008}',
    '.tos-from{font-size:.85em;opacity:.65;overflow-wrap:anywhere}',
    '.tos-title{font-weight:bold;overflow-wrap:anywhere}',
    '.tos-msg{white-space:pre-wrap;overflow-wrap:anywhere}',
    '.tos-chk{display:flex;gap:8px;align-items:flex-start;cursor:pointer}',
    '.tos-chk input{margin-top:.35em}',
    '.tos-chk small{display:block;opacity:.7}',
    '.tos-chk.danger b{color:#d44}',
    '.tos-box input[type=text],.tos-box textarea{font:inherit;color:inherit;background:transparent;border:1px solid #8888;border-radius:4px;padding:4px 6px;width:100%;box-sizing:border-box}',
    '.tos-btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
    '.tos-btns.col{flex-direction:column;align-items:stretch}',
    '.tos-btns button{font:inherit;color:inherit;padding:6px 12px;cursor:pointer;background:var(--btn-bg,#8882);border:1px solid #8886;border-radius:6px;text-align:left}',
    '.tos-btns.row button{text-align:center}',
    '.tos-btns button.primary{font-weight:bold;border-color:currentColor}',
    '.tos-btns button.danger{color:#d44}',
    '.win .c{position:relative}',
  ].join('\n');
  const ensureUiCss = () => {
    if (document.getElementById('tos-ui-css')) return;
    const s = document.createElement('style');
    s.id = 'tos-ui-css';
    s.textContent = UI_CSS;
    document.head.appendChild(s);
  };
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  const K = {
    version: '0.7.0',
    apiVersion: 1, // components の API の版（互換を壊すときだけ上げる）
    safe: false, settings: {}, index: null, backend: null, desktop: null, apps: null, sound: null, _ev: {}, _hooks: {}, _dlgStack: [],

    // ---- イベント: 起こったことを知らせる（返り値は見ない。例外は握りつぶして続ける）----
    on(n, f) { (this._ev[n] = this._ev[n] || []).push(f); return () => this.off(n, f); }, // 返り値は解除する関数
    once(n, f) { const off = this.on(n, (...a) => { off(); f(...a); }); return off; },
    off(n, f) { this._ev[n] = (this._ev[n] || []).filter((x) => x !== f); },
    emit(n, ...a) { for (const f of [...(this._ev[n] || [])]) { try { f(...a); } catch (e) { console.warn(e); } } },

    // ---- フック: 操作の前に呼ばれ、中止（false を返す）や、渡された ctx の書き換えができる ----
    // 例外・5 秒を超える待ち・false 以外の返り値は「そのまま続ける」。1つの壊れたフックで OS を止めない
    hook(n, f) { (this._hooks[n] = this._hooks[n] || []).push(f); return () => { this._hooks[n] = (this._hooks[n] || []).filter((x) => x !== f); }; },
    async runHook(n, ctx) {
      for (const f of [...(this._hooks[n] || [])]) {
        let t;
        try {
          const r = await Promise.race([Promise.resolve(f(ctx)), new Promise((ok) => { t = setTimeout(() => { console.warn('[kernel] hook が 5 秒以内に終わらないので続けます:', n); ok(); }, 5000); })]);
          if (r === false) return false;
        } catch (e) { console.warn('[kernel] hook 失敗:', n, e); }
        finally { clearTimeout(t); }
      }
      return true;
    },

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
      if (!(await this.runHook('fs.write', { path: np, size: blob.size }))) throw new Error('components に拒否されました: ' + np);
      await this.backend.writeFile(np, blob);
      const [dir, name] = split(np);
      const d = this._mkdirIdx(dir);
      const node = { id: np, name, isDirectory: false, mimeType: blob.type, size: blob.size, modifiedTime: new Date().toISOString(), children: null };
      const i = d.children.findIndex((c) => c.name === name);
      if (i >= 0) d.children[i] = node; else d.children.push(node);
      this.emit('fs', np, 'write');
    },
    async createDirectory(path) {
      const np = norm(path);
      await this.backend.mkdir(np);
      this._mkdirIdx(np);
      this.emit('fs', np, 'mkdir');
    },
    async deleteFile(path) {
      const np = norm(path);
      if (np === '/') throw new Error('ルートは削除できません');
      if (!(await this.runHook('fs.delete', { path: np }))) throw new Error('components に拒否されました: ' + np);
      await this.backend.remove(np);
      const [dir, name] = split(np);
      const d = this.find(dir);
      if (d) d.children = d.children.filter((c) => c.name !== name);
      this.emit('fs', np, 'delete');
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

    // フォルダも含めてコピー（中身ごと。コピー先がすでにあるときはエラー）
    async copy(from, to) {
      const a = norm(from), b = norm(to);
      if (a === '/' || b === a || b.startsWith(a + '/')) throw new Error('コピーできません（自分自身の中には入れられません）');
      if (this.find(b)) throw new Error('すでに存在します: ' + b);
      if (!this.find(a)) throw new Error('見つかりません: ' + a);
      const walk = async (src, dst) => {
        const n = this.find(src);
        if (n.isDirectory) {
          await this.createDirectory(dst);
          for (const c of [...n.children]) await walk(src + '/' + c.name, dst + '/' + c.name);
        } else {
          await this.writeFile(dst, await this.readFile(src));
        }
      };
      await walk(a, b);
    },

    // フォルダも含めて移動（コピーしてから元を削除。名前の変更にも使う）
    async move(from, to) {
      const a = norm(from), b = norm(to);
      if (a === '/' || b === a || b.startsWith(a + '/')) throw new Error('移動できません');
      await this.copy(a, b);
      await this.deleteFile(a);
    },

    // 標準ファイルの更新・復元（skeleton.js の updateDefaults）。kernel 経由で読み書きするので一覧にも反映される
    restoreDefaults(force) {
      return window.TrainOSSkeleton.updateDefaults(this.backend, {
        tree: this.index, force: !!force,
        write: (p, b) => this.writeFile(p, b), read: (p) => this.readFile(p), remove: (p) => this.deleteFile(p),
      });
    },

    async flush() {
      if (!this.backend || !this.backend.flush) return;
      const n = this.backend.pending ? this.backend.pending.size : 0;
      await this.backend.flush();
      if (n && this.sound) this.sound.play('save');
    },

    // ---- 設定 ----
    async setSettings(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('不正な設定');
      patch = Object.assign({}, patch);
      if (patch.desktopEnv) { // デスクトップ環境: sys/desktops/<名前>.json の項目を、まとめて設定に入れる
        if (!/^[\w-]+$/.test(patch.desktopEnv)) throw new Error('不正な名前');
        const de = await this.readJson('/sys/desktops/' + patch.desktopEnv + '.json');
        const merged = {};
        for (const k of ['windowManager', 'windowTheme', 'shellTheme', 'cursor', 'wallpaper', 'animation', 'panel', 'iconset', 'keymap', 'font']) if (k in de) merged[k] = de[k];
        patch = Object.assign(merged, patch);
      }
      if ('sound' in patch) { // 効果音のテーマ名（null でオフ）
        if (patch.sound && !/^[\w-]+$/.test(String(patch.sound))) throw new Error('不正な効果音の名前');
        patch.sound = patch.sound ? String(patch.sound) : null;
      }
      if ('soundVolume' in patch) patch.soundVolume = Math.min(100, Math.max(0, Math.round(+patch.soundVolume || 0)));
      if ('disabledStartup' in patch) patch.disabledStartup = (Array.isArray(patch.disabledStartup) ? patch.disabledStartup : []).map(String).filter((n) => /^[\w.-]+\.json$/.test(n));
      const ok = ['theme', 'wallpaper', 'language', 'bootLoader', 'syncMinutes', 'desktop', 'fileTypeHandlers', 'disabledComponents', 'dock', 'font', 'keymap', 'iconset',
        'desktopEnv', 'windowManager', 'windowTheme', 'shellTheme', 'cursor', 'animation', 'panel', 'sound', 'soundVolume', 'disabledStartup'];
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
      if (this.sound) await this.sound.load();
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
      const startup = await this.startupList().catch(() => []);
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
        keys: this.keys || {}, actions: ACTIONS.slice(),
        sounds: json('/sys/sounds'), startup, permissionInfo: PERM_INFO,
        apps: this.apps ? this.apps.list().map((a) => ({ id: a.id, name: a.name, icon: a.icon })) : [],
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

    // キー割り当てを sys/keymaps/<名前>.json に保存して、その割り当てに切り替える（設定画面のショートカット編集用）。
    // 書けるのは Alt か Meta を含む組み合わせだけ（アプリの中でも効くのは、この2つだけのため）
    async saveKeymap(name, map) {
      if (!/^[\w-]+$/.test(String(name))) throw new Error('不正な名前');
      if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('不正なキー割り当て');
      const clean = {};
      for (const [combo, a] of Object.entries(map)) {
        if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+\S+$/.test(combo) || combo.length > 40 || !/(^|\+)(Alt|Meta)\+/.test(combo)) throw new Error('使えない組み合わせです（Alt か Meta が必要）: ' + combo);
        if (typeof a === 'string' && /^\w+$/.test(a)) clean[combo] = a;
        else if (a && typeof a.launch === 'string' && /^[\w-]+$/.test(a.launch)) clean[combo] = typeof a.openPath === 'string' ? { launch: a.launch, openPath: a.openPath } : { launch: a.launch };
        else if (a && typeof a.open === 'string' && a.open.startsWith('/')) clean[combo] = { open: a.open };
        else throw new Error('不正な操作です: ' + combo);
      }
      await this.writeFile('/sys/keymaps/' + name + '.json', JSON.stringify(clean, null, 2));
      if (this.settings.keymap !== name) await this.setSettings({ keymap: name });
      else { await this.loadKeymap(); this.emit('settings'); }
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

    // ---- ダイアログ ----
    // 共通の土台。host が null なら画面の真ん中（OS 本体用）、要素なら、その中だけを覆う（アプリのウィンドウ用）。
    // spec: { from, title, message, note, checks: [{id, label, desc, danger, checked}], input: {value, placeholder, multiline},
    //         buttons: [{label, value, primary, danger}], row（ボタンを横に並べる）, focus（最初に選ぶボタンの番号）, cancel（Esc の値。既定 null）, sound }
    // 返り値は Promise<{ button, input, checks }>。返り値の .cancel() で、外から閉じる（Esc と同じ値になる）
    _modal(spec, host) {
      ensureUiCss();
      if (this.sound && spec.sound !== false) this.sound.play(spec.sound || 'dialog');
      let cancelFn = () => {};
      const p = new Promise((ok) => {
        const d = document.createElement('div');
        d.className = 'tos-dialog' + (host ? ' in-win' : '');
        const box = document.createElement('div');
        box.className = 'tos-box';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        const add = (cls, text) => { const e = document.createElement('div'); e.className = cls; e.textContent = text; box.append(e); };
        if (spec.from) add('tos-from', spec.from);
        if (spec.title) add('tos-title', spec.title);
        if (spec.message) add('tos-msg', spec.message);
        const checks = {};
        for (const c of spec.checks || []) {
          const l = document.createElement('label');
          l.className = 'tos-chk' + (c.danger ? ' danger' : '');
          const i = document.createElement('input');
          i.type = 'checkbox';
          i.checked = !!c.checked;
          const t = document.createElement('span'), b = document.createElement('b');
          b.textContent = c.label;
          t.append(b);
          if (c.desc) { const s = document.createElement('small'); s.textContent = c.desc; t.append(s); }
          l.append(i, t);
          box.append(l);
          checks[c.id] = i;
        }
        let field = null;
        if (spec.input) {
          field = document.createElement(spec.input.multiline ? 'textarea' : 'input');
          if (!spec.input.multiline) field.type = 'text'; else field.rows = 4;
          field.value = str(spec.input.value);
          field.placeholder = str(spec.input.placeholder);
          field.maxLength = 2000;
          box.append(field);
        }
        if (spec.note) add('tos-from', spec.note);
        const bar = document.createElement('div');
        bar.className = 'tos-btns ' + (spec.row ? 'row' : 'col');
        const token = {}, btns = [];
        let primary = null;
        const cancelValue = spec.cancel === undefined ? null : spec.cancel;
        const onKey = (e) => {
          if (this._dlgStack[this._dlgStack.length - 1] !== token) return; // いちばん上のダイアログだけが受ける
          if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(cancelValue); }
          else if (e.key === 'Enter' && field && e.target === field && !spec.input.multiline && primary) { e.preventDefault(); e.stopImmediatePropagation(); done(primary.value); }
          else if (e.key === 'Tab') {
            const f = [...box.querySelectorAll('input,textarea,button')];
            if (!f.length) return;
            const at = f.indexOf(document.activeElement);
            e.preventDefault();
            f[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
          }
        };
        const done = (button) => {
          const i = this._dlgStack.indexOf(token);
          if (i >= 0) this._dlgStack.splice(i, 1);
          document.removeEventListener('keydown', onKey, true);
          const r = { button, input: field ? field.value : null, checks: {} };
          for (const [id, e] of Object.entries(checks)) r.checks[id] = e.checked;
          d.remove();
          ok(r);
        };
        cancelFn = () => done(cancelValue);
        let pi = -1;
        (spec.buttons || []).forEach((x, n) => {
          const k = document.createElement('button');
          k.type = 'button';
          k.textContent = x.label;
          if (x.primary) { k.classList.add('primary'); if (!primary) { primary = x; pi = n; } }
          if (x.danger) k.classList.add('danger');
          k.onclick = () => done(x.value);
          bar.append(k);
          btns.push(k);
        });
        box.append(bar);
        d.append(box);
        if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
        (host || document.body).appendChild(d);
        this._dlgStack.push(token);
        document.addEventListener('keydown', onKey, true);
        const f = field || btns[spec.focus !== undefined ? spec.focus : (pi >= 0 ? pi : 0)];
        if (f) f.focus();
      });
      p.cancel = () => cancelFn();
      return p;
    },

    // 画面の真ん中に出す選択ダイアログ（OS 本体用）。選んだ値を返す。Esc は null
    async dialog({ title, message, buttons }) { return (await this._modal({ title, message, buttons }, null)).button; },

    // components などから使う、画面の真ん中のダイアログ。TrainOS.ui（アプリ用）と同じ形
    ui: {
      alert: async (message, o) => { o = o || {}; await K._modal({ title: o.title, message: str(message), row: true, sound: o.sound, cancel: true, buttons: [{ label: o.okLabel || 'OK', value: true, primary: true }] }, null); },
      confirm: async (message, o) => {
        o = o || {};
        const r = await K._modal({ title: o.title, message: str(message), row: true, sound: o.sound, cancel: false, focus: o.danger ? 0 : 1,
          buttons: [{ label: o.cancelLabel || 'キャンセル', value: false }, { label: o.okLabel || 'OK', value: true, primary: !o.danger, danger: !!o.danger }] }, null);
        return r.button === true;
      },
      prompt: async (message, o) => {
        o = o || {};
        const r = await K._modal({ title: o.title, message: str(message), row: true, sound: o.sound, input: { value: o.value, placeholder: o.placeholder, multiline: !!o.multiline },
          buttons: [{ label: o.cancelLabel || 'キャンセル', value: null }, { label: o.okLabel || 'OK', value: 'ok', primary: true }] }, null);
        return r.button === 'ok' ? r.input : null;
      },
      choose: async (message, buttons, o) => {
        o = o || {};
        const r = await K._modal({ title: o.title, message: str(message), sound: o.sound, buttons: (buttons || []).map((b) => (typeof b === 'object' && b ? b : { label: str(b), value: b })) }, null);
        return r.button;
      },
    },

    // アプリが求める権限の確認画面。{ granted, denied } を返す（「起動しない」や Esc は null）
    async askPermissions(m, need, rec) {
      const again = rec && ((rec.granted || []).length || (rec.denied || []).length);
      const r = await this._modal({
        from: 'アプリの権限',
        title: '「' + m.name + '」が、' + (again ? '新しい権限を求めています' : '権限を求めています'),
        message: 'このアプリは、次のことをしようとしています。許可するものにチェックを入れてください。チェックを外したことは、アプリからできません。',
        note: 'アプリ: ' + m.id + ' / v' + m.version + '\n許可は、設定画面の「アプリの権限」でいつでも変えられます。',
        checks: need.map((p) => {
          const i = PERM_INFO[p];
          return { id: p, label: (i ? i.label : '不明な権限') + '（' + p + '）', desc: i ? i.desc : 'この OS では使われない権限です。', danger: !!(i && i.danger), checked: !!i && p !== 'system.settings' };
        }),
        row: true, cancel: null,
        buttons: [{ label: '起動しない', value: null }, { label: '許可して起動', value: 'ok', primary: true }],
      }, null);
      if (r.button !== 'ok') return null;
      return { granted: need.filter((p) => r.checks[p]), denied: need.filter((p) => !r.checks[p]) };
    },

    // Drive 側も変わっていたとき: 'local'（このタブの内容で上書き）か 'drive'（Drive の内容を残す）を返す。
    // 迷ったとき（Esc）や「両方残す」は、このタブの内容を別のファイルに保存して、Drive の内容を残す（何も失わない）
    async conflictChoice({ path, blob }) {
      const v = await this.dialog({
        title: 'Drive 側でも変更されています',
        message: '「' + path + '」は、このタブで編集している間に、Drive 側でも変更されました。どちらを残しますか？',
        buttons: [
          { label: '両方残す（このタブの内容は、別のファイルに保存する）', value: 'both' },
          { label: 'このタブの内容で、Drive を上書きする', value: 'local' },
          { label: 'Drive の内容を残す（このタブの変更は捨てる）', value: 'drive' },
        ],
      });
      if (v === 'local') return 'local';
      if (v === 'drive') return 'drive';
      const d = new Date(), z = (n) => String(n).padStart(2, '0');
      await this.writeFile(path + '.local-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()), blob);
      return 'drive';
    },

    // ログインの期限切れ: ポップアップはクリック操作の中でしか開けないので、ボタンを出して待つ
    async loginDialog() {
      const v = await this.dialog({
        title: 'Google のログインが切れました',
        message: 'Drive につなぎ直すため、もう一度ログインしてください。未送信の変更は、このまま残っています。',
        buttons: [{ label: 'Google でログイン', value: 'login' }, { label: 'あとで', value: null }],
      });
      if (v !== 'login') throw new Error('ログインしませんでした');
      await this.backend.login();
    },

    // 前のタブで送れなかった変更を、IndexedDB から取り出して溜め直す。食い違いは選ばせる
    async recover() {
      const items = await this.backend.recover();
      for (const it of items) {
        const act = it.conflict ? await this.conflictChoice(it) : 'local';
        if (act === 'drive') await this.backend.discard(it.path);
        else await this.writeFile(it.path, it.blob);
      }
      return items.length;
    },

    // ---- アプリ ----
    launchApp(id, opts) { return this.apps.launch(id, opts); },
    openFile(path) { return this.apps.openFile(path); },

    // ---- components（セーフモードでは読み込まない）----
    // 各 component に渡す `component`。on / once / hook は kernel のものと同じだが、
    // 失敗したときに、どの component のものか分かるよう、名前を付けて警告する
    _compApi(name) {
      const guard = (f) => {
        if (typeof f !== 'function') throw new TypeError('関数を渡してください');
        const warn = (e) => console.warn('[component:' + name + ']', e);
        return (...a) => { try { const r = f(...a); return r && typeof r.then === 'function' ? r.catch(warn) : r; } catch (e) { warn(e); } };
      };
      return {
        name, apiVersion: this.apiVersion,
        on: (n, f) => this.on(String(n), guard(f)),
        once: (n, f) => this.once(String(n), guard(f)),
        hook: (n, f) => this.hook(String(n), guard(f)),
      };
    },

    async loadComponents() {
      const dir = this.find('/sys/components');
      const files = ((dir && dir.children) || []).filter((c) => !c.isDirectory && /\.js$/.test(c.name))
        .map((c) => c.name).sort()
        .filter((n) => !(this.settings.disabledComponents || []).includes(n)); // 設定画面でオフにしたもの
      for (const name of files) {
        try {
          const code = await (await this.readFile('/sys/components/' + name)).text();
          new Function('kernel', 'component', code)(this, this._compApi(name));
        } catch (e) {
          console.warn('[kernel] component 失敗:', name, e);
        }
      }
    },

    // ---- 起動時に開くアプリ: sys/startup/<名前>.json（名前順）----
    // { "app": "terminal", "openPath": "/usr/documents/memo.txt", "delay": 500 } か { "open": "/usr/documents/memo.txt" }。
    // 配列で複数書いてもよい。"enabled": false か、設定の disabledStartup に名前があるとスキップ。セーフモードでは何も開かない
    async startupList() {
      const out = [];
      const off = new Set(this.settings.disabledStartup || []);
      for (const name of this.names('/sys/startup', /\.json$/i)) {
        let desc = '', fileOff = false;
        try {
          const j = await this.readJson('/sys/startup/' + name);
          const items = (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === 'object');
          fileOff = !items.length || items.every((x) => x.enabled === false);
          desc = items.map((x) => (typeof x.app === 'string' ? x.app + (x.openPath ? ' ' + x.openPath : '') : typeof x.open === 'string' ? x.open : '?')).join(', ');
        } catch (e) { desc = '（読めません）'; fileOff = true; }
        out.push({ name, desc, enabled: !off.has(name) && !fileOff, fileOff });
      }
      return out;
    },

    async runStartup() {
      if (this.safe) return [];
      const off = new Set(this.settings.disabledStartup || []);
      const done = [];
      for (const name of this.names('/sys/startup', /\.json$/i)) {
        if (off.has(name)) continue;
        let j;
        try { j = await this.readJson('/sys/startup/' + name); } catch (e) { console.warn('[kernel] 起動時アプリを読めません:', name, e); continue; }
        for (const e of Array.isArray(j) ? j : [j]) {
          if (done.length >= 10) { console.warn('[kernel] 起動時に開くアプリは 10 個までです'); return done; } // 開きすぎて固まらないように
          try {
            if (!e || typeof e !== 'object' || e.enabled === false) continue;
            const delay = Math.min(10000, Math.max(0, +e.delay || 0));
            if (delay) await new Promise((ok) => setTimeout(ok, delay));
            if (typeof e.app === 'string' && /^[\w-]+$/.test(e.app)) await this.apps.launch(e.app, { openPath: typeof e.openPath === 'string' ? e.openPath : null });
            else if (typeof e.open === 'string' && e.open.startsWith('/')) await this.openFile(e.open);
            else continue;
            done.push(name);
          } catch (err) { console.warn('[kernel] 起動時アプリに失敗:', name, err); }
        }
      }
      return done;
    },

    // 設定画面から: アプリを起動時に開くものに加える / 外す
    async addStartup(appId) {
      if (!/^[\w-]+$/.test(String(appId)) || !this.apps.registry.has(appId)) throw new Error('アプリが見つかりません: ' + appId);
      let name = appId + '.json', n = 1;
      while (this.find('/sys/startup/' + name)) name = appId + '-' + (++n) + '.json';
      await this.writeFile('/sys/startup/' + name, JSON.stringify({ app: appId }, null, 2));
      return name;
    },
    async removeStartup(name) {
      if (!/^[\w.-]+\.json$/i.test(String(name)) || !this.find('/sys/startup/' + name)) throw new Error('見つかりません: ' + name);
      await this.deleteFile('/sys/startup/' + name);
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
      this.sound = window.TrainOSSound.create(this); // 効果音（設定を読むまでは鳴らない）
      B.start({ safe: this.safe });
      try {
        B.progress({ value: 5, label: 'ストレージを開いています…' });
        const kind = localStorage.getItem('trainos.backend');
        if (kind === 'drive') {
          this.backend = new window.TrainOSDriveBackend();
          this.backend.onConflict = (info) => this.conflictChoice(info); // 送るとき、Drive 側も変わっていたら選ばせる
          this.backend.askLogin = () => this.loginDialog();              // ログインが切れたら、ボタン付きで頼む
          await this._login();
        }
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
        if (this.backend.recover) {
          B.progress({ value: 42, label: '未送信の変更を確認中…' });
          await this.recover();
        }
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

        await this.sound.load();
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
        this.emit('ready');
        this.sound.play('startup');
        this.runStartup().catch((e) => console.warn('[kernel] 起動時アプリ', e)); // 確認ダイアログで待つことがあるので、起動は待たせない
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
