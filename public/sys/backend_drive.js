// TrainOS / sys/backend_drive.js
// Google Drive バックエンド。マイドライブ直下の TrainOS/ フォルダをルートにする。
//
// 認証: Firebase Auth（Google）。アクセストークンはこのクラスの内部（#token）にだけ置き、アプリには渡さない。
//       期限切れ（401、または約55分）になったら askLogin（ボタン付きダイアログ）で再ログインして、そのまま続ける。
// 読み取り: buildIndex() が階層ごとにまとめて取得し、以後の一覧は kernel のメモリ上ツリーで通信なし。
// 書き込み: メモリに溜めて、delay（既定10分）ごと、または flush() でまとめて Drive へ送る。{ immediate: true } はその場で送る。
//   - 溜めた書き込みは IndexedDB にも保存する。タブを閉じても失わず、次の起動で recover() が拾う。
//   - 送る前に、Drive 側が溜めた時点から変わっていないか確かめる。変わっていたら onConflict で選ばせる
//     （'local' = このタブの内容で上書き / 'drive' = Drive の内容を残す）。
//   - オフラインや失敗のときは、溜めたまま残して、つながったとき・一定間隔で再送する（status に状態が入る）。

(function () {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files/';
  const UPLOAD_V2 = 'https://www.googleapis.com/upload/drive/v2/files/'; // v2 の更新は PUT（ブラウザの CORS を通る）
  const FOLDER = 'application/vnd.google-apps.folder';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const TOKEN_MS = 55 * 60 * 1000; // アクセストークンは約1時間。少し早めに取り直す
  const parts = (p) => p.split('/').filter(Boolean);
  const same = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);
  // 通信エラー（fetch が投げる TypeError）。別の window 由来でも見分けられるよう、型ではなく名前で見る
  const isNet = (e) => !!e && e.name === 'TypeError';

  const loadScript = (src) => new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ng(new Error('読み込めません: ' + src));
    document.head.appendChild(s);
  });

  // 未送信の書き込みを置く場所。IndexedDB（ブラウザを閉じても残る）。
  function idbStore(name) {
    let dbp = null;
    const open = () => new Promise((ok, ng) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pending');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ng(r.error);
    });
    const tx = async (mode, fn) => {
      dbp = dbp || open();
      const db = await dbp;
      return new Promise((ok, ng) => {
        const t = db.transaction('pending', mode);
        const q = fn(t.objectStore('pending'));
        t.oncomplete = () => ok(q && q.result);
        t.onerror = t.onabort = () => ng(t.error);
      });
    };
    return {
      put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
      all: () => tx('readonly', (s) => s.getAll()),
    };
  }

  class DriveBackend {
    #token = null;
    #exp = 0;

    constructor(opts) {
      opts = opts || {};
      this.user = null;
      this.ids = new Map();      // パス -> { id, dir, mtime }
      this.rootId = null;
      this.pending = new Map();  // パス -> Blob（Drive へ未送信）
      this.bases = new Map();    // パス -> 溜め始めたときの、Drive 側の更新時刻（食い違いの検出用）
      this.mine = new Map();     // このタブで作ったもの。一覧への反映が遅れても見えるようにする
      this.timer = null;
      this.delay = 600000;
      this.fails = 0;
      this.status = 'ok';        // ok / offline / login / error
      this.onPending = null;     // (件数, status) => void
      this.onConflict = null;    // ({ path, blob, driveModified, base }) => Promise<'local' | 'drive'>
      this.askLogin = null;      // () => Promise<void>（ボタン付きで再ログインさせる）
      this.store = opts.store || window.TrainOSDriveStore || (typeof indexedDB !== 'undefined' ? idbStore('trainos-drive') : null);
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('online', () => { if (this.pending.size) this.flush().catch(() => {}); });
      }
    }

    async login() {
      const cfg = window.TRAINOS_FIREBASE;
      if (!cfg || !cfg.apiKey || /^YOUR_/.test(cfg.apiKey)) {
        throw new Error('firebase-config.js に Firebase の設定を入れてください（docs.html 参照）');
      }
      if (!window.firebase) {
        await loadScript(SDK + 'firebase-app-compat.js');
        await loadScript(SDK + 'firebase-auth-compat.js');
      }
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope(SCOPE);
      const r = await firebase.auth().signInWithPopup(provider);
      this.#token = r.credential.accessToken;
      this.#exp = Date.now() + TOKEN_MS;
      this.user = r.user.email;
    }

    // 同時に何度も聞かないよう、再ログインは1つにまとめる
    _relogin() {
      if (!this._rl) {
        this._rl = (async () => {
          try { await (this.askLogin ? this.askLogin() : this.login()); }
          catch (e) { const err = new Error('Google のログインが必要です'); err.code = 'login'; throw err; }
        })().finally(() => { this._rl = null; });
      }
      return this._rl;
    }

    async _f(url, init) {
      if (this.#exp && Date.now() > this.#exp) await this._relogin();
      const go = () => fetch(url, Object.assign({}, init, {
        headers: Object.assign({}, init && init.headers, { Authorization: 'Bearer ' + this.#token }),
      }));
      let r = await go();
      if (r.status === 401) { await this._relogin(); r = await go(); }
      if (!r.ok) throw new Error('Drive エラー ' + r.status);
      return r;
    }

    _notify() { if (this.onPending) this.onPending(this.pending.size, this.status); }

    _classify(e) {
      const offline = isNet(e) || (typeof navigator !== 'undefined' && navigator.onLine === false);
      this.status = e && e.code === 'login' ? 'login' : offline ? 'offline' : 'error';
      this._notify();
    }

    // 画面に出すエラーを、分かる言葉にする（種類は status に入っている）
    _friendly(e) {
      const n = this.pending.size;
      if (this.status === 'offline') return Object.assign(new Error('オフラインです。つながると自動で送ります（未送信 ' + n + ' 件）'), { code: 'offline' });
      return e;
    }

    async _create(name, parent, folder) {
      const body = { name, parents: [parent] };
      if (folder) body.mimeType = FOLDER;
      const r = await this._f(API + 'files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return (await r.json()).id;
    }

    // 親フォルダ ID の集合の直下をまとめて取得（40件ずつ、ページ送りあり）
    async _list(parentIds) {
      const out = [];
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)');
      for (let i = 0; i < parentIds.length; i += 40) {
        const q = '(' + parentIds.slice(i, i + 40).map((id) => "'" + id + "' in parents").join(' or ') + ') and trashed=false';
        let tok = '';
        do {
          const j = await (await this._f(API + 'files?pageSize=1000&fields=' + fields + '&q=' + encodeURIComponent(q) + (tok ? '&pageToken=' + tok : ''))).json();
          out.push(...j.files);
          tok = j.nextPageToken || '';
        } while (tok);
      }
      return out;
    }

    async buildIndex() {
      if (!this.rootId) {
        const q = encodeURIComponent("name='TrainOS' and mimeType='" + FOLDER + "' and 'root' in parents and trashed=false");
        const j = await (await this._f(API + 'files?fields=files(id)&q=' + q)).json();
        this.rootId = j.files.length ? j.files[0].id : await this._create('TrainOS', 'root', true);
      }
      this.ids.clear();
      this.ids.set('/', { id: this.rootId, dir: true, mtime: null });
      const root = { id: '/', name: 'TrainOS', isDirectory: true, mimeType: 'inode/directory', children: [] };
      let level = [[root, this.rootId]];
      while (level.length) {
        const kids = await this._list(level.map((l) => l[1]));
        const next = [];
        for (const [node, id] of level) {
          for (const f of kids) {
            if (!(f.parents || []).includes(id)) continue;
            const dir = f.mimeType === FOLDER;
            if (!dir && f.mimeType.startsWith('application/vnd.google-apps.')) continue; // Docs/Sheets などは対象外
            if (node.children.some((c) => c.name === f.name)) continue;                  // 同名は最初の1つだけ
            const p = (node.id === '/' ? '' : node.id) + '/' + f.name;
            node.children.push({
              id: p, name: f.name, isDirectory: dir, mimeType: dir ? 'inode/directory' : f.mimeType,
              size: f.size ? +f.size : 0, modifiedTime: f.modifiedTime, children: dir ? [] : null,
            });
            this.ids.set(p, { id: f.id, dir, mtime: f.modifiedTime || null });
            if (dir) next.push([node.children[node.children.length - 1], f.id]);
          }
        }
        level = next;
      }
      // 作成直後は Drive の一覧に出るまで遅れることがあるので、このタブで作ったものを補う
      for (const [p, e] of [...this.mine].sort((a, b) => a[0].length - b[0].length)) {
        if (this.ids.has(p)) continue;
        const i = p.lastIndexOf('/');
        let par = root;
        for (const s of parts(p.slice(0, i))) par = par && (par.children || []).find((c) => c.name === s);
        if (!par || !par.isDirectory || par.children.some((c) => c.name === p.slice(i + 1))) continue;
        par.children.push({
          id: p, name: p.slice(i + 1), isDirectory: e.dir, mimeType: e.dir ? 'inode/directory' : 'application/octet-stream',
          size: 0, modifiedTime: new Date().toISOString(), children: e.dir ? [] : null,
        });
        this.ids.set(p, e);
      }
      return root;
    }

    async readFile(path) {
      if (this.pending.has(path)) return this.pending.get(path);
      const e = this.ids.get(path);
      if (!e || e.dir) throw new Error('ファイルがありません: ' + path);
      try { return await (await this._f(API + 'files/' + e.id + '?alt=media')).blob(); }
      catch (err) {
        if (isNet(err)) throw new Error('オフラインです。つながってから開いてください: ' + path);
        throw err;
      }
    }

    async mkdir(path) {
      let p = '';
      for (const s of parts(path)) {
        const parent = this.ids.get(p || '/').id;
        p += '/' + s;
        if (!this.ids.has(p)) {
          const e = { id: await this._create(s, parent, true), dir: true, mtime: null };
          this.ids.set(p, e);
          this.mine.set(p, e);
        }
      }
    }

    // 内容の更新。v3 の PATCH は、ブラウザの CORS（プリフライト）で拒否される。
    // 通る方法を順に試し、通ったものを覚える。TypeError は CORS・通信エラー（HTTP エラーは別の Error）。
    // 戻り値は、更新後の Drive 側の更新時刻
    async _update(id, blob) {
      const type = blob.type || 'application/octet-stream';
      const ways = [
        async () => (await (await this._f(UPLOAD_V2 + id + '?uploadType=media&fields=modifiedDate', { method: 'PUT', headers: { 'Content-Type': type }, body: blob })).json()),
        async () => (await (await this._f(UPLOAD + id + '?uploadType=media&fields=modifiedTime', { method: 'POST', headers: { 'Content-Type': type, 'X-HTTP-Method-Override': 'PATCH' }, body: blob })).json()),
      ];
      let last;
      for (const i of this._way === undefined ? [0, 1] : [this._way]) {
        try {
          const j = await ways[i]();
          if (this._way === undefined) console.info('[drive] 更新方式:', i === 0 ? 'v2 PUT' : 'v3 POST + override');
          this._way = i;
          return (j && (j.modifiedDate || j.modifiedTime)) || null;
        } catch (err) {
          if (!isNet(err)) throw err;
          last = err;
        }
      }
      // どの方法も通信エラーだった。オフラインか、CORS の拒否かを、軽い読み取り（GET）で見分ける
      try { await this._f(API + 'files/' + id + '?fields=id'); }
      catch (probe) { if (isNet(probe)) throw probe; /* GET は通る = オフラインではない */ }
      throw Object.assign(new Error('Drive への更新がブラウザに拒否されました（CORS）: ' + (last && last.message)), { code: 'cors' });
    }

    async _put(path, blob) {
      const ps = parts(path);
      const name = ps.pop();
      const dir = '/' + ps.join('/');
      await this.mkdir(dir);
      const make = async () => {
        const e = { id: await this._create(name, this.ids.get(dir).id, false), dir: false, mtime: null };
        this.ids.set(path, e);
        this.mine.set(path, e);
        return e;
      };
      let e = this.ids.get(path) || await make();
      try { e.mtime = await this._update(e.id, blob); }
      catch (err) {
        if (!/404/.test(String(err.message))) throw err;
        // 別の場所で消された。作り直して、内容を送る
        this.ids.delete(path); this.mine.delete(path);
        e = await make();
        e.mtime = await this._update(e.id, blob);
      }
    }

    // ---- 溜めて送る ----
    async writeFile(path, blob, opts) {
      if (opts && opts.immediate) return this._put(path, blob);
      const e = this.ids.get(path);
      if (!this.pending.has(path)) this.bases.set(path, (e && e.mtime) || null); // 溜め始めたときの Drive 側の版
      this.pending.set(path, blob);
      await this._persist(path);
      this._notify();
      this._schedule(this.delay);
    }

    async _persist(path) {
      if (!this.store || !this.user) return;
      try {
        await this.store.put(this.user + '\n' + path, { user: this.user, path, blob: this.pending.get(path), base: this.bases.get(path) || null, at: Date.now() });
      } catch (e) { console.warn('[drive] 未送信の保存に失敗（このタブの中には残っています）', e); }
    }

    async _drop(path) {
      this.pending.delete(path);
      this.bases.delete(path);
      if (this.store && this.user) { try { await this.store.del(this.user + '\n' + path); } catch (e) { /* 次回また試す */ } }
      this._notify();
    }

    _schedule(ms) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._auto(), ms);
    }

    // 時間が来たときの送信。失敗したら、少しずつ間隔をあけて再送する（再ログイン待ちのときは止める）
    async _auto() {
      try { await this.flush(); }
      catch (e) { if (this.status !== 'login') this._schedule(Math.min(300000, 30000 * 2 ** Math.min(this.fails++, 4))); }
    }

    // 送る前に、Drive 側が溜めたときから変わっていないか確かめる。変わっていたら、選ばせる
    async _check(path) {
      const e = this.ids.get(path), base = this.bases.get(path);
      if (!e || e.dir || !base || !this.onConflict) return 'local';
      let cur;
      try { cur = (await (await this._f(API + 'files/' + e.id + '?fields=modifiedTime')).json()).modifiedTime; }
      catch (err) { if (/404/.test(String(err.message))) return 'local'; throw err; }
      if (!cur || same(cur, base)) return 'local';
      return (await this.onConflict({ path, blob: this.pending.get(path), driveModified: cur, base })) === 'drive' ? 'drive' : 'local';
    }

    async flush() {
      clearTimeout(this.timer);
      for (const [p, b] of [...this.pending]) {
        try {
          const act = await this._check(p);
          if (act === 'drive') { await this._drop(p); continue; }
          await this._put(p, b);
          if (this.pending.get(p) === b) await this._drop(p);
          else this.bases.set(p, (this.ids.get(p) || {}).mtime || null); // 送っている間に、また編集された
        } catch (e) { this._classify(e); throw this._friendly(e); }
      }
      this.status = 'ok';
      this.fails = 0;
      this._notify();
    }

    // 前のタブで送れなかった分を、IndexedDB から取り出す。conflict: 溜めたあとに Drive 側も変わっている
    async recover() {
      if (!this.store || !this.user) return [];
      const rows = (await this.store.all()).filter((r) => r && r.user === this.user);
      return rows.map((r) => {
        const e = this.ids.get(r.path);
        return {
          path: r.path, blob: r.blob, base: r.base || null, driveModified: (e && e.mtime) || null,
          conflict: !!(e && !e.dir && r.base && e.mtime && !same(e.mtime, r.base)),
        };
      });
    }

    discard(path) { return this._drop(path); }

    async remove(path) {
      for (const k of [...this.pending.keys()]) if (k === path || k.startsWith(path + '/')) await this._drop(k);
      const e = this.ids.get(path);
      if (e) {
        await this._f(API + 'files/' + e.id, { method: 'DELETE' });
        for (const k of [...this.ids.keys()]) {
          if (k === path || k.startsWith(path + '/')) { this.ids.delete(k); this.mine.delete(k); }
        }
      }
      this._notify();
    }
  }

  window.TrainOSDriveBackend = DriveBackend;
})();
