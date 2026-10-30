// TrainOS / sys/backend_local.js
// ローカルフォルダ用のストレージバックエンド（File System Access API。Chrome / Edge デスクトップ）。
// VFS 共通インターフェース: buildIndex / readFile / writeFile / mkdir / remove
// 選んだフォルダが TrainOS のルート（直下に sys/ と usr/）。ツリーの id にはパスを使う。

(function () {
  'use strict';

  const parts = (path) => path.split('/').filter(Boolean);

  class LocalBackend {
    constructor(root) { this.root = root; }

    // index.html で選んだフォルダのハンドルを IndexedDB から取り出す
    static async open() {
      const db = await new Promise((ok, ng) => {
        const r = indexedDB.open('trainos-boot', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ng(r.error);
      });
      const h = await new Promise((ok, ng) => {
        const q = db.transaction('kv').objectStore('kv').get('rootHandle');
        q.onsuccess = () => ok(q.result);
        q.onerror = () => ng(q.error);
      });
      if (!h) throw new Error('フォルダが未選択です。index.html から起動してください');
      if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('フォルダへのアクセス許可がありません。index.html から起動してください');
      }
      return new LocalBackend(h);
    }

    async _dir(path, create) {
      let d = this.root;
      for (const s of parts(path)) d = await d.getDirectoryHandle(s, { create: !!create });
      return d;
    }

    // 全ファイルのメタデータを一括取得して FileTreeNode を返す
    async buildIndex() {
      const walk = async (dir, path, name) => {
        const node = { id: path || '/', name, isDirectory: true, mimeType: 'inode/directory', children: [] };
        for await (const [n, h] of dir.entries()) {
          const p = path + '/' + n;
          if (h.kind === 'directory') {
            node.children.push(await walk(h, p, n));
          } else {
            const f = await h.getFile();
            node.children.push({
              id: p, name: n, isDirectory: false, mimeType: f.type, size: f.size,
              modifiedTime: new Date(f.lastModified).toISOString(), children: null,
            });
          }
        }
        return node;
      };
      return walk(this.root, '', this.root.name);
    }

    async readFile(path) {
      const p = parts(path);
      const name = p.pop();
      const d = await this._dir(p.join('/'), false);
      return (await d.getFileHandle(name)).getFile();
    }

    async writeFile(path, blob) {
      const p = parts(path);
      const name = p.pop();
      const d = await this._dir(p.join('/'), true);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
    }

    async mkdir(path) { await this._dir(path, true); }

    async remove(path) {
      const p = parts(path);
      const name = p.pop();
      const d = await this._dir(p.join('/'), false);
      await d.removeEntry(name, { recursive: true });
    }
  }

  window.TrainOSLocalBackend = LocalBackend;
})();
