// TrainOS / sys/skeleton.js
// 初回起動時に sys/ と usr/ の雛形を作る。バックエンド共通（mkdir は既存でも成功すること）。
//
//   const r = await TrainOSSkeleton.ensureSkeleton(backend);
//   'created'       雛形を作った（空のフォルダ、または settings.json が無かった）。
//                   空のフォルダだったときは、標準アプリと起動画面もコピーする（seedDefaults）
//   'ok'            すでに TrainOS のフォルダ
//   'needs-confirm' 中身があるのに sys/ が無い。誤って普段使いのフォルダを選んだ可能性があるので、
//                   確認ダイアログを出し、OK なら ensureSkeleton(backend, { force: true })

(function () {
  'use strict';

  const DIRS = ['sys', 'sys/apps', 'sys/boot_loader', 'sys/components', 'usr', 'usr/desktop', 'usr/documents'];

  const DEFAULT_SETTINGS = {
    theme: 'light',
    wallpaper: null,
    language: 'ja',
    syncMinutes: 10,
    bootLoader: null,
    fileTypeHandlers: {},
    desktop: {
      shortcuts: [
        { name: 'エクスプローラー', app: 'explorer' },
        { name: 'ターミナル', app: 'terminal' },
        { name: 'メモ帳', app: 'notepad' },
        { name: '設定', app: 'settings' },
        { name: 'ドキュメント', path: '/usr/documents' },
      ],
    },
  };

  const flatten = (node, base, out) => {
    for (const c of node.children || []) {
      const p = base + '/' + c.name;
      if (c.isDirectory) flatten(c, p, out); else out.add(p);
    }
    return out;
  };

  // サイト側の sys/defaults.json に載っているファイルを、無いものだけコピーする（上書きしない）。
  // サイト上のパスとユーザーのフォルダ内のパスは同じ（例: sys/apps/notepad/main.js）。
  async function seedDefaults(backend, opts) {
    const base = (opts && opts.base) || '';
    const res = await fetch(base + 'sys/defaults.json');
    if (!res.ok) throw new Error('defaults.json を取得できません: ' + res.status);
    const list = (await res.json()).files || [];
    // すでにある一覧（opts.tree）を使う。ここで取り直すと、作成直後のフォルダが一覧に無くて重複作成される
    const have = flatten((opts && opts.tree) || await backend.buildIndex(), '', new Set());
    const put = (opts && opts.write) || ((p, b) => backend.writeFile(p, b, { immediate: true }));
    let copied = 0;
    for (const path of list) {
      if (!/^(sys|usr)\/[\w./-]+$/.test(path) || path.includes('..')) continue;
      if (have.has('/' + path)) continue;
      const r = await fetch(base + path);
      if (!r.ok) throw new Error('取得できません: ' + path);
      await put('/' + path, await r.blob());
      copied++;
    }
    return copied;
  }

  async function ensureSkeleton(backend, opts) {
    const force = !!(opts && opts.force);
    const root = await backend.buildIndex();
    const children = root.children || [];
    // .DS_Store などの隠しファイルは「空」の判定に含めない
    const visible = children.filter((c) => !c.name.startsWith('.'));
    const sys = children.find((c) => c.name === 'sys' && c.isDirectory);

    if (!sys && visible.length > 0 && !force) return 'needs-confirm';

    const hasSettings = !!(sys && (sys.children || []).some((c) => c.name === 'settings.json'));
    for (const d of DIRS) await backend.mkdir(d);
    if (!hasSettings) {
      await backend.writeFile(
        '/sys/settings.json',
        new Blob([JSON.stringify(DEFAULT_SETTINGS, null, 2)], { type: 'application/json' }),
        { immediate: true }
      );
    }
    if (!sys && !(opts && opts.seed === false)) {
      try { await seedDefaults(backend, Object.assign({}, opts, { tree: root })); }
      catch (e) { console.warn('[skeleton] 標準ファイルのコピーに失敗（オフライン？）', e); }
    }
    return sys && hasSettings ? 'ok' : 'created';
  }

  window.TrainOSSkeleton = { ensureSkeleton, seedDefaults, DEFAULT_SETTINGS };
})();
