// TrainOS / sys/backend_drive.js
// Google Drive バックエンド。マイドライブ直下の TrainOS/ フォルダをルートにする。
// 認証: Firebase Auth（Google）。アクセストークンはこのクラスの内部（#token）にだけ置き、アプリには渡さない。
// 読み取り: buildIndex() が階層ごとにまとめて取得し、以後の一覧は kernel のメモリ上ツリーで通信なし。
// 書き込み: メモリ上に溜めて、delay（既定10分）ごと、または flush() でまとめて Drive へ送る。
//          { immediate: true } を渡すとその場で送る。
// 注意: 溜めた書き込みはタブを閉じると失われる（kernel が閉じる前に警告する）。永続化は今後の課題。

(function () {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files/';
  const UPLOAD_V2 = 'https://www.googleapis.com/upload/drive/v2/files/'; // v2 の更新は PUT（ブラウザの CORS を通る）
  const FOLDER = 'application/vnd.google-apps.folder';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const parts = (p) => p.split('/').filter(Boolean);

  const loadScript = (src) => new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ng(new Error('読み込めません: ' + src));
    document.head.appendChild(s);
  });

  class DriveBackend {
    #token = null;

    constructor() {
      this.user = null;
      this.ids = new Map();      // パス -> { id, dir }
      this.rootId = null;
      this.pending = new Map();  // パス -> Blob（Drive へ未送信）
      this.mine = new Map();     // このタブで作ったもの。一覧への反映が遅れても見えるようにする
      this.timer = null;
      this.delay = 600000;
      this.onPending = null;     // (件数) => void
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
      this.user = r.user.email;
    }

    async _f(url, init) {
      const go = () => fetch(url, Object.assign({}, init, {
        headers: Object.assign({}, init && init.headers, { Authorization: 'Bearer ' + this.#token }),
      }));
      let r = await go();
      if (r.status === 401) { await this.login(); r = await go(); } // 期限切れ（ポップアップは操作直後でないと開かない場合あり）
      if (!r.ok) throw new Error('Drive エラー ' + r.status);
      return r;
    }

    _notify() { if (this.onPending) this.onPending(this.pending.size); }

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
      this.ids.set('/', { id: this.rootId, dir: true });
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
            this.ids.set(p, { id: f.id, dir });
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
      return (await this._f(API + 'files/' + e.id + '?alt=media')).blob();
    }

    async mkdir(path) {
      let p = '';
      for (const s of parts(path)) {
        const parent = this.ids.get(p || '/').id;
        p += '/' + s;
        if (!this.ids.has(p)) {
          const e = { id: await this._create(s, parent, true), dir: true };
          this.ids.set(p, e);
          this.mine.set(p, e);
        }
      }
    }

    async _put(path, blob) {
      const ps = parts(path);
      const name = ps.pop();
      const dir = '/' + ps.join('/');
      await this.mkdir(dir);
      let e = this.ids.get(path);
      if (!e) { e = { id: await this._create(name, this.ids.get(dir).id, false), dir: false }; this.ids.set(path, e); this.mine.set(path, e); }
      await this._update(e.id, blob);
    }

    // 内容の更新。v3 の PATCH は、ブラウザの CORS（プリフライト）で拒否される。
    // 通る方法を順に試し、通ったものを覚える。TypeError は CORS・通信エラー（HTTP エラーは別の Error）。
    async _update(id, blob) {
      const type = blob.type || 'application/octet-stream';
      const ways = [
        () => this._f(UPLOAD_V2 + id + '?uploadType=media', { method: 'PUT', headers: { 'Content-Type': type }, body: blob }),
        () => this._f(UPLOAD + id + '?uploadType=media', { method: 'POST', headers: { 'Content-Type': type, 'X-HTTP-Method-Override': 'PATCH' }, body: blob }),
      ];
      let last;
      for (const i of this._way === undefined ? [0, 1] : [this._way]) {
        try {
          await ways[i]();
          if (this._way === undefined) console.info('[drive] 更新方式:', i === 0 ? 'v2 PUT' : 'v3 POST + override');
          this._way = i;
          return;
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          last = err;
        }
      }
      throw new Error('Drive への更新がブラウザに拒否されました（CORS）: ' + (last && last.message));
    }

    async writeFile(path, blob, opts) {
      if (opts && opts.immediate) return this._put(path, blob);
      this.pending.set(path, blob);
      this._notify();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush().catch((e) => console.warn('[drive] 自動保存に失敗', e)), this.delay);
    }

    async flush() {
      clearTimeout(this.timer);
      for (const [p, b] of [...this.pending]) {
        await this._put(p, b);
        if (this.pending.get(p) === b) this.pending.delete(p);
        this._notify();
      }
    }

    async remove(path) {
      for (const k of [...this.pending.keys()]) if (k === path || k.startsWith(path + '/')) this.pending.delete(k);
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
