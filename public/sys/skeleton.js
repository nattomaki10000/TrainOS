// TrainOS / sys/skeleton.js
// 初回起動時に sys/ と usr/ の雛形を作る。バックエンド共通（mkdir は既存でも成功すること）。
//
//   const r = await TrainOSSkeleton.ensureSkeleton(backend);
//   'created'       雛形を作った（空のフォルダ、または settings.json が無かった）。
//                   空のフォルダだったときは、標準アプリと起動画面もコピーする（updateDefaults）
//   'ok'            すでに TrainOS のフォルダ
//   'needs-confirm' 中身があるのに sys/ が無い。誤って普段使いのフォルダを選んだ可能性があるので、
//                   確認ダイアログを出し、OK なら ensureSkeleton(backend, { force: true })

(function () {
  'use strict';

  const DIRS = ['sys', 'sys/apps', 'sys/boot_loader', 'sys/desktops', 'sys/wm', 'sys/window_themes', 'sys/shell_themes', 'sys/cursors', 'sys/animations', 'sys/panels', 'sys/wallpapers', 'sys/fonts', 'sys/keymaps', 'sys/iconsets', 'sys/components', 'usr', 'usr/desktop', 'usr/documents'];

  const DEFAULT_SETTINGS = {
    desktopEnv: 'classic',
    windowManager: 'floating',
    windowTheme: 'light',
    shellTheme: 'light',
    cursor: null,
    animation: 'fade',
    panel: 'bottom',
    wallpaper: 'sky.svg',
    language: 'ja',
    syncMinutes: 10,
    disabledComponents: [],
    keymap: 'default',
    iconset: null,
    font: { ui: '', mono: '', size: 14 },
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

  // 版の比較（0.9.90 のような数字も扱える）
  const cmp = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  const sha = async (blob) => {
    const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // サイトの sys/defaults.json（各ファイルの最終変更バージョン v、内容のハッシュ h、過去のハッシュ p）と、
  // ユーザーのフォルダの sys/installed.json（入れた版とハッシュ）を見比べて、標準ファイルを反映する。
  // 各ファイルの「最新の版」だけを見るので、何バージョン離れていても、間の版で変わったファイルもまとめて反映される。
  //   無い                : コピー（以前入れたのに無い = ユーザーが削除したものは、force のときだけ戻す）
  //   手を加えていない    : 新しい版で上書き
  //   手を加えてある      : 上書きせず「名前.new」として横に置く
  async function updateDefaults(backend, opts) {
    opts = opts || {};
    const base = opts.base || '';
    const write = opts.write || ((p, b) => backend.writeFile(p, b, { immediate: true }));
    const read = opts.read || ((p) => backend.readFile(p));
    const res = await fetch(base + 'sys/defaults.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('defaults.json を取得できません: ' + res.status);
    const M = await res.json();
    // 一覧はすでにあるもの（opts.tree）を使う。ここで取り直すと、作成直後のフォルダが一覧に無くて重複作成される
    const have = flatten(opts.tree || await backend.buildIndex(), '', new Set());

    let R = {};
    if (have.has('/sys/installed.json')) {
      try { R = JSON.parse(await (await read('/sys/installed.json')).text()); } catch (e) { R = {}; }
    }
    R.version = R.version || '0.0.0';
    R.files = R.files || {};
    const out = { version: M.version, copied: [], updated: [], conflicts: [], deleted: [], errors: [] };
    const get = async (path) => {
      const r = await fetch(base + path, { cache: 'no-cache' });
      if (!r.ok) throw new Error('取得できません: ' + path);
      return r.blob();
    };

    for (const [path, e] of Object.entries(M.files || {})) {
      if (!/^(sys|usr)\/[\w./-]+$/.test(path) || path.includes('..')) continue;
      const p = '/' + path;
      try {
        if (!have.has(p)) {
          if (R.files[path] && !opts.force) { out.deleted.push(path); continue; }
          await write(p, await get(path));
          R.files[path] = e.h;
          out.copied.push(path);
          continue;
        }
        if (R.files[path] && cmp(e.v, R.version) <= 0) continue;   // 入れた版から変わっていない
        const mine = await sha(await read(p));
        if (mine === e.h) { R.files[path] = e.h; continue; }       // すでに最新と同じ中身
        if (mine === R.files[path] || (e.p || []).includes(mine)) { // 手を加えていない古い版
          await write(p, await get(path));
          R.files[path] = e.h;
          out.updated.push(path);
        } else {                                                    // 手を加えてある
          await write(p + '.new', await get(path));
          out.conflicts.push(path);
        }
      } catch (err) {
        out.errors.push(path + ': ' + ((err && err.message) || err));
      }
    }
    if (!out.errors.length) R.version = M.version;
    await write('/sys/installed.json', new Blob([JSON.stringify(R, null, 2)], { type: 'application/json' }));
    return out;
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
      try { await updateDefaults(backend, Object.assign({}, opts, { tree: root })); }
      catch (e) { console.warn('[skeleton] 標準ファイルのコピーに失敗（オフライン？）', e); }
    }
    return sys && hasSettings ? 'ok' : 'created';
  }

  window.TrainOSSkeleton = { ensureSkeleton, updateDefaults, DEFAULT_SETTINGS };
})();
