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

  const K = {
    safe: false, settings: {}, index: null, backend: null, desktop: null, apps: null,

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
    },
    async createDirectory(path) {
      const np = norm(path);
      await this.backend.mkdir(np);
      this._mkdirIdx(np);
    },
    async deleteFile(path) {
      const np = norm(path);
      if (np === '/') throw new Error('ルートは削除できません');
      await this.backend.remove(np);
      const [dir, name] = split(np);
      const d = this.find(dir);
      if (d) d.children = d.children.filter((c) => c.name !== name);
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

    // ---- アプリ ----
    launchApp(id, opts) { return this.apps.launch(id, opts); },
    openFile(path) { return this.apps.openFile(path); },

    // ---- components（セーフモードでは読み込まない）----
    async loadComponents() {
      const dir = this.find('/sys/components');
      const files = ((dir && dir.children) || []).filter((c) => !c.isDirectory && /\.js$/.test(c.name))
        .map((c) => c.name).sort();
      for (const name of files) {
        try {
          const code = await (await this.readFile('/sys/components/' + name)).text();
          new Function('kernel', code)(this);
        } catch (e) {
          console.warn('[kernel] component 失敗:', name, e);
        }
      }
    },

    // ---- 起動 ----
    async boot() {
      const B = window.TrainOSBoot;
      this.safe = new URLSearchParams(location.search).get('mode') === 'safe';
      B.start({ safe: this.safe });
      try {
        B.progress({ value: 5, label: 'ストレージを開いています…' });
        const kind = localStorage.getItem('trainos.backend');
        if (kind === 'drive') throw new Error('Google Drive 版はまだ実装されていません。index.html でローカルフォルダを選んでください');
        if (kind !== 'local') throw new Error('保存先が未選択です。index.html から起動してください');
        this.backend = await window.TrainOSLocalBackend.open();

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

        if (!this.safe) {
          if (this.settings.bootLoader) await B.cache(this, this.settings.bootLoader).catch(() => {});
          B.progress({ value: 55, label: 'components を読み込み中…' });
          await this.loadComponents();
        }

        B.progress({ value: 75, label: 'アプリを走査中…' });
        this.desktop = makeDesktop(this);
        this.apps = new window.TrainOSAppLoader(this);
        await this.apps.scan();

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
    a.textContent = '← index.html に戻る';
    a.style.cssText = 'padding:0 24px;color:#8cf';
    el.append(p, a);
  }

  // 最小のデスクトップ: ランチャー + ドラッグできるウィンドウ。
  // app_loader が createWindow(app) で中身の要素をもらい、attach(instance, host) でつなぐ。
  function makeDesktop(kernel) {
    const desk = document.getElementById('desktop');
    const bar = document.getElementById('bar');
    let z = 1, n = 0;

    return {
      createWindow(app) {
        const w = document.createElement('div');
        w.className = 'win';
        const { width, height } = app.manifest.window;
        w.style.cssText = 'left:' + (40 + (n % 8) * 28) + 'px;top:' + (30 + (n % 8) * 28) + 'px;width:' + width + 'px;height:' + height + 'px;z-index:' + (++z);
        n++;
        w.innerHTML = '<div class="t"><span></span><button>×</button></div><div class="c"></div>';
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
          if (e.target.tagName === 'BUTTON') return;
          const dx = e.clientX - w.offsetLeft, dy = e.clientY - w.offsetTop;
          t.setPointerCapture(e.pointerId);
          desk.classList.add('drag');
          t.onpointermove = (m) => { w.style.left = (m.clientX - dx) + 'px'; w.style.top = Math.max(0, m.clientY - dy) + 'px'; };
          t.onpointerup = () => { t.onpointermove = t.onpointerup = null; desk.classList.remove('drag'); };
        };
      },

      render() {
        const b = document.createElement('button');
        b.textContent = '🚃 TrainOS';
        const m = document.createElement('div');
        m.id = 'menu';
        m.hidden = true;
        b.onclick = () => {
          m.replaceChildren(...kernel.apps.list().map((a) => {
            const i = document.createElement('button');
            i.textContent = a.name;
            i.onclick = () => { m.hidden = true; kernel.apps.launch(a.id).catch((err) => alert(err.message)); };
            return i;
          }));
          m.hidden = !m.hidden;
        };
        bar.append(b, m);
        if (kernel.safe) {
          const s = document.createElement('span');
          s.textContent = 'セーフモード（components 無効）';
          bar.append(s);
        }
      },
    };
  }

  window.TrainOSKernel = K;
})();
