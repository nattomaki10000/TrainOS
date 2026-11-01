// TrainOS / sys/desktop.js
// デスクトップ環境の本体。次のものを受け持つ。
//   ウィンドウ / ウィンドウマネージャー（sys/wm/<名前>.js）/ ウィンドウテーマ（sys/window_themes）/
//   シェルテーマ（sys/shell_themes）/ マウスカーソル（sys/cursors）/ 壁紙（sys/wallpapers）/
//   アニメーション（sys/animations）/ フォント / パネル（sys/panels。ドックにもタスクバーにもなる）/ デスクトップのアイコン
// 設定は kernel.settings から読む。セーフモードでは、ファイルのカスタマイズをすべて使わず、内蔵の見た目と最小の WM にする。
//
// WM は TrainOSWM.register({ name, buttons, movable, resizable, open(w, ctx), layout(wins, ctx), focus(w, wins, ctx) }) で登録する。
//   w   = { id, app, el, bar, title, content, state, size: { width, height } }
//   ctx = { area(), gap(), move(w, x, y, 幅, 高さ), raise(w), state(w, 'normal' | 'max' | 'min') }

(function () {
  'use strict';

  const I = (n) => window.TrainOSIcon(n);
  const NAME = /^[\w-]+$/;
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const pad2 = (n) => String(n).padStart(2, '0');

  const CURSORS = { default: 'auto', pointer: 'pointer', text: 'text', move: 'move', wait: 'wait' };
  const CURSOR_RULES = 'html{cursor:var(--cursor-default,auto)}\n' +
    'a,button,select,summary,label,[role=button],input[type=checkbox],input[type=radio],input[type=range],.ico,.pk,.pw{cursor:var(--cursor-pointer,pointer)}\n' +
    'input:not([type]),input[type=text],input[type=number],input[type=search],textarea{cursor:var(--cursor-text,text)}\n' +
    '.win .t{cursor:var(--cursor-move,move)}\n';

  const WM_ICON = { min: 'window-minimize', max: 'window-maximize', close: 'xmark' };
  const WM_TITLE = { min: '最小化', max: '最大化', close: '閉じる' };

  // 内蔵の最小の WM（セーフモードと、WM を読めなかったときに使う）
  const MIN_WM = {
    name: 'builtin', buttons: ['close'], movable: true, resizable: true,
    open(w, ctx) { const a = ctx.area(), n = (w.id - 1) % 8; ctx.move(w, a.x + 40 + n * 28, a.y + 30 + n * 28, w.size.width, w.size.height); },
    layout() {},
  };
  // 内蔵のパネル（セーフモードで使う）
  const BUILTIN_PANEL = { position: 'bottom', fill: true, size: 36, items: [{ type: 'launcher' }, { type: 'windows' }, { type: 'spacer' }, { type: 'save' }, { type: 'version' }] };

  function create(kernel) {
    const desk = document.getElementById('desktop');
    const root = document.documentElement;
    const mkStyle = () => { const s = document.createElement('style'); document.head.appendChild(s); return s; };
    const st = { win: mkStyle(), shell: mkStyle(), anim: mkStyle(), cursor: mkStyle() };
    const icons = el('div'); icons.id = 'icons'; desk.appendChild(icons);
    const panel = el('div'); panel.id = 'panel'; panel.hidden = true; document.body.appendChild(panel);
    const menu = el('div'); menu.id = 'menu'; menu.hidden = true; document.body.appendChild(menu);

    const wins = [];     // 作成順。タイルのメイン窓は先頭
    const timers = [];
    let serial = 0, z = 1, wm = MIN_WM;
    // いまの位置と大きさ。ctx.move・ドラッグ・大きさの変更はすべて style に px で入るので、それを読む（レイアウトを読まない）
    const rectOf = (w) => {
      const n = (v, d) => (parseFloat(v) || d);
      return { x: n(w.el.style.left, w.el.offsetLeft), y: n(w.el.style.top, w.el.offsetTop), w: n(w.el.style.width, w.el.offsetWidth), h: n(w.el.style.height, w.el.offsetHeight) };
    };
    const D = { wins, front: null, ready: false, pos: 'bottom', wlist: null, wmName: 'builtin' };

    // ---- WM に渡す道具 ----
    const ctx = {
      area: () => ({ x: 0, y: 0, w: desk.clientWidth, h: desk.clientHeight }),
      gap: () => parseFloat(getComputedStyle(root).getPropertyValue('--wm-gap')) || 0,
      move(w, x, y, width, height) {
        if (w.placed) { w.el.classList.add('snap'); clearTimeout(w.snapT); w.snapT = setTimeout(() => w.el.classList.remove('snap'), 400); }
        const s = w.el.style;
        s.left = Math.round(x) + 'px'; s.top = Math.round(y) + 'px';
        if (width != null) s.width = Math.max(0, Math.round(width)) + 'px';
        if (height != null) s.height = Math.max(0, Math.round(height)) + 'px';
        w.placed = true;
      },
      raise(w) {
        w.el.style.zIndex = ++z;
        for (const o of wins) o.el.classList.toggle('front', o === w);
        if (w.instance) D.front = w.instance;
        if (wm.focus) { try { wm.focus(w, wins, ctx); } catch (e) { console.warn('[desktop] WM focus', e); } }
        D.refreshPanel();
      },
      state(w, to) {
        if (to === 'min') {
          if (w.state !== 'min') { w.beforeMin = w.state; w.state = 'min'; w.el.classList.add('min'); }
        } else {
          if (w.state === 'min') { w.state = w.beforeMin || 'normal'; w.el.classList.remove('min'); }
          if (to === 'max' && w.state !== 'max') { w.prev = rectOf(w); w.state = 'max'; const a = ctx.area(); ctx.move(w, a.x, a.y, a.w, a.h); }
          else if (to === 'normal' && w.state === 'max') { w.state = 'normal'; if (w.prev) ctx.move(w, w.prev.x, w.prev.y, w.prev.w, w.prev.h); }
        }
        D.relayout();
        D.refreshPanel();
      },
    };

    // 窓が増減したとき・画面の大きさが変わったときに並べ直す
    D.relayout = () => {
      try { wm.layout(wins, ctx); } catch (e) { console.warn('[desktop] WM layout', e); }
      const a = ctx.area();
      for (const w of wins) if (w.state === 'max') ctx.move(w, a.x, a.y, a.w, a.h);
    };

    // タイトルバーのボタンを、いまの WM に合わせて作り直す
    const decorate = (w) => {
      w.btns.replaceChildren();
      for (const b of wm.buttons || ['close']) {
        const k = el('button', 'b-' + b);
        k.title = WM_TITLE[b] || b;
        k.innerHTML = I(WM_ICON[b] || 'xmark');
        k.onclick = () => {
          if (!w.instance) return;
          if (b === 'close') kernel.apps.close(w.instance.id);
          else if (b === 'max') ctx.state(w, w.state === 'max' ? 'normal' : 'max');
          else if (b === 'min') ctx.state(w, 'min');
        };
        w.btns.append(k);
      }
      w.el.classList.toggle('fixed', wm.resizable === false);
    };

    const closeWin = (w) => {
      wins.splice(wins.indexOf(w), 1);
      const ms = parseFloat(getComputedStyle(w.el).getPropertyValue('--anim-close-ms')) || 0;
      if (ms > 0) { w.el.classList.add('closing'); setTimeout(() => w.el.remove(), ms); } else w.el.remove();
      if (D.front === w.instance) {
        D.front = null;
        const last = wins.filter((o) => o.instance && o.state !== 'min').pop();
        if (last) ctx.raise(last);
      }
      D.relayout();
      D.refreshPanel();
    };

    // ---- ウィンドウ（app_loader から呼ばれる）----
    D.createWindow = (app) => {
      const w = { id: ++serial, app, el: el('div', 'win opening'), state: 'normal', size: app.manifest.window };
      w.bar = el('div', 't'); w.title = el('span'); w.btns = el('span', 'btns');
      w.content = el('div', 'c'); w.content._w = w;
      w.bar.append(w.title, w.btns);
      w.el.append(w.bar, w.content);
      w.el.style.zIndex = ++z;
      setTimeout(() => w.el.classList.remove('opening'), 700);
      decorate(w);
      desk.appendChild(w.el);
      wins.push(w);
      try { wm.open(w, ctx); } catch (e) { console.warn('[desktop] WM open', e); }
      if (!w.placed) MIN_WM.open(w, ctx); // WM が置かなかったときの保険
      D.relayout();
      return w.content;
    };

    D.attach = (instance, host) => {
      const w = host._w;
      w.instance = instance;
      w.title.textContent = instance.title;
      instance.onTitleChange = (s) => { w.title.textContent = s; D.refreshPanel(); };
      instance.focus = () => { if (w.state === 'min') ctx.state(w, 'normal'); ctx.raise(w); };
      instance.onClose = () => closeWin(w);
      w.el.addEventListener('pointerdown', () => ctx.raise(w), true);
      w.bar.ondblclick = (e) => { if (!e.target.closest('button') && w.btns.querySelector('.b-max')) ctx.state(w, w.state === 'max' ? 'normal' : 'max'); };
      w.bar.onpointerdown = (e) => {
        if (wm.movable === false || w.state === 'max' || e.target.closest('button')) return;
        const dx = e.clientX - w.el.offsetLeft, dy = e.clientY - w.el.offsetTop;
        w.bar.setPointerCapture(e.pointerId);
        desk.classList.add('drag');
        w.bar.onpointermove = (m) => { w.el.style.left = (m.clientX - dx) + 'px'; w.el.style.top = Math.max(0, m.clientY - dy) + 'px'; };
        w.bar.onpointerup = () => { w.bar.onpointermove = w.bar.onpointerup = null; desk.classList.remove('drag'); };
      };
      ctx.raise(w);
    };

    // キー割り当てから呼ばれる操作。扱えたら true
    D.act = (a) => {
      const cur = wins.find((w) => w.instance && w.instance === D.front);
      const can = (b) => (wm.buttons || []).includes(b);
      if (a === 'closeWindow') { if (D.front) kernel.apps.close(D.front.id); return true; }
      if (a === 'launcher') { D.toggleLauncher(); return true; }
      if (a === 'nextWindow' || a === 'prevWindow') {
        const list = wins.filter((w) => w.instance);
        if (list.length) list[(list.indexOf(cur) + (a === 'nextWindow' ? 1 : -1) + list.length) % list.length].instance.focus();
        return true;
      }
      if (a === 'toMaster') { if (cur) { wins.splice(wins.indexOf(cur), 1); wins.unshift(cur); D.relayout(); } return true; }
      if (a === 'maximize') { if (cur && can('max')) ctx.state(cur, cur.state === 'max' ? 'normal' : 'max'); return true; }
      if (a === 'minimize') { if (cur && can('min')) ctx.state(cur, 'min'); return true; }
      return false;
    };

    // ---- WM を読み込む ----
    D.loadWM = async (name) => {
      wm = MIN_WM; D.wmName = 'builtin';
      if (!kernel.safe && NAME.test(name || '')) {
        try {
          let got = null;
          window.TrainOSWM = { register: (d) => { got = d; } };
          new Function(await (await kernel.readFile('/sys/wm/' + name + '.js')).text())();
          if (got && (typeof got.open === 'function' || typeof got.layout === 'function')) { wm = Object.assign({}, MIN_WM, got); D.wmName = name; }
        } catch (e) { console.warn('[desktop] WM を読めません。内蔵の WM にします:', name, e); }
      }
      for (const w of wins) if (w.instance) decorate(w);
      D.relayout();
    };

    // ---- テーマ・カーソル・壁紙・フォント ----
    // テーマや動きの CSS を読んで <style> に入れる（名前が無い・読めないときは内蔵の見た目）
    const loadCss = async (dir, name, style) => {
      style.textContent = '';
      if (kernel.safe || !NAME.test(name || '')) return;
      try { style.textContent = await (await kernel.readFile('/sys/' + dir + '/' + name + '.css')).text(); } catch (e) { /* 無ければ内蔵 */ }
    };

    // カーソル: {種類: {svg, x, y}} を CSS 変数にする。アプリの中にも同じ CSS を渡す（kernel.cursorCss）
    D.applyCursor = async (name) => {
      let out = '';
      if (!kernel.safe && NAME.test(name || '')) {
        try {
          const set = await kernel.readJson('/sys/cursors/' + name + '.json');
          const vars = [];
          for (const [type, fallback] of Object.entries(CURSORS)) {
            const c = set[type];
            // svg は画像として使うので動かないが、念のため script と on...= を含むものは受け付けない
            if (!c || typeof c.svg !== 'string' || !/^<svg[\s>]/.test(c.svg) || c.svg.length > 6000 || /<script|\bon\w+\s*=/i.test(c.svg)) continue;
            const x = Math.min(128, Math.max(0, parseInt(c.x, 10) || 0)), y = Math.min(128, Math.max(0, parseInt(c.y, 10) || 0));
            vars.push('--cursor-' + type + ':url("data:image/svg+xml,' + encodeURIComponent(c.svg) + '") ' + x + ' ' + y + ',' + fallback);
          }
          if (vars.length) out = ':root{' + vars.join(';') + '}\n' + CURSOR_RULES;
        } catch (e) { console.warn('[desktop] カーソルを読めません', e); }
      }
      kernel.cursorCss = out;
      st.cursor.textContent = out;
    };

    // 壁紙: '#色' などの色 / '/パス' / sys/wallpapers 内のファイル名（画像、アニメーション SVG、.html は隔離して動かす）
    D.applyWallpaper = async (value) => {
      const w = kernel.safe ? '' : (value || '');
      desk.style.background = '';
      if (D.wpFrame) { D.wpFrame.remove(); D.wpFrame = null; }
      const html = /^[\w-]+\.html$/i.test(w);
      const file = html || /^[\w-]+\.(png|jpe?g|gif|webp|svg)$/i.test(w) ? '/sys/wallpapers/' + w : w.startsWith('/') ? w : null;
      if (!file) { if (w) desk.style.background = w; return; }
      try {
        const blob = await kernel.readFile(file);
        if (html) {
          const f = el('iframe'); f.id = 'wp';
          f.setAttribute('sandbox', 'allow-scripts'); // OS の機能には触れない
          f.srcdoc = await blob.text();
          desk.insertBefore(f, desk.firstChild);
          D.wpFrame = f;
        } else {
          const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[file.split('.').pop().toLowerCase()] || '';
          if (D.wpUrl) URL.revokeObjectURL(D.wpUrl);
          D.wpUrl = URL.createObjectURL(new Blob([blob], { type }));
          desk.style.background = 'center / cover url(' + D.wpUrl + ')';
        }
      } catch (e) { /* 読めなければ色のまま */ }
    };

    // フォント: sys/fonts のファイル名、またはシステムのフォント名
    D.applyFont = (f) => {
      f = f || {};
      const rs = root.style, sz = +f.size;
      if (!kernel.safe && sz >= 9 && sz <= 32) rs.setProperty('--font-size', sz + 'px'); else rs.removeProperty('--font-size');
      const set = async (key, name, id, rest) => {
        if (D.ff && D.ff[key]) { document.fonts.delete(D.ff[key]); D.ff[key] = null; }
        rs.removeProperty('--font-' + key);
        if (kernel.safe || !name) return;
        let fam = null;
        if (/^[\w-]+\.(woff2?|ttf|otf)$/i.test(name)) {
          try {
            const ff = new FontFace(id, await (await kernel.readFile('/sys/fonts/' + name)).arrayBuffer());
            await ff.load();
            document.fonts.add(ff);
            (D.ff = D.ff || {})[key] = ff;
            fam = '"' + id + '"';
          } catch (e) { console.warn('[desktop] フォントを読めません', e); }
        } else if (/^[\w \-]+$/.test(name)) {
          fam = '"' + name + '"';
        }
        if (fam) rs.setProperty('--font-' + key, fam + ', ' + rest);
      };
      set('ui', f.ui, 'TrainOS-UI', 'system-ui, sans-serif');
      set('mono', f.mono, 'TrainOS-Mono', 'ui-monospace, monospace');
    };

    // 設定をすべて反映する（起動時と、設定が変わったとき）
    D.apply = async () => {
      const s = kernel.settings, g = (k, legacy, d) => (s[k] !== undefined ? s[k] : (s[legacy] !== undefined ? s[legacy] : d));
      await Promise.all([
        loadCss('window_themes', g('windowTheme', 'theme', 'light'), st.win),
        loadCss('shell_themes', g('shellTheme', 'theme', 'light'), st.shell),
        loadCss('animations', s.animation === undefined ? null : s.animation, st.anim),
        D.applyCursor(s.cursor),
        D.applyWallpaper(s.wallpaper),
        D.loadWM(s.windowManager === undefined ? 'floating' : s.windowManager),
      ]);
      D.applyFont(s.font);
      if (D.ready) { D.renderIcons(); await D.renderPanel(); }
    };

    // ---- デスクトップのアイコン: settings の shortcuts と /usr/desktop の中身 ----
    D.renderIcons = () => {
      icons.replaceChildren();
      const add = (name, icon, open) => {
        const b = el('button', 'ico');
        b.innerHTML = I(icon) + '<span></span>';
        b.lastChild.textContent = name;
        b.ondblclick = () => open().catch((e) => alert(e.message));
        icons.appendChild(b);
      };
      const sc = (kernel.settings.desktop && kernel.settings.desktop.shortcuts) || [];
      for (const s of sc) {
        if (s.app) { const a = kernel.apps.registry.get(s.app); if (a) add(s.name, a.manifest.icon, () => kernel.launchApp(s.app)); }
        else if (s.path) add(s.name, 'folder', () => kernel.openFile(s.path));
      }
      const d = kernel.find('/usr/desktop');
      for (const c of (d && d.children) || []) add(c.name, c.isDirectory ? 'folder' : 'file', () => kernel.openFile('/usr/desktop/' + c.name));
    };

    // ---- ランチャーのメニュー ----
    D.toggleLauncher = () => {
      if (!menu.hidden) { menu.hidden = true; return; }
      menu.replaceChildren(...kernel.apps.list().map((a) => {
        const i = el('button');
        i.innerHTML = I(a.icon) + '<span></span>';
        i.lastChild.textContent = a.name;
        i.onclick = () => { menu.hidden = true; kernel.apps.launch(a.id).catch((err) => alert(err.message)); };
        return i;
      }));
      const b = panel.querySelector('[data-launcher]'), r = b && !panel.hidden && b.getBoundingClientRect(), s = menu.style;
      s.left = s.right = s.top = s.bottom = '';
      if (!r) { s.left = '8px'; s.bottom = '8px'; }
      else if (D.pos === 'bottom') { s.left = r.left + 'px'; s.bottom = (window.innerHeight - r.top + 4) + 'px'; }
      else if (D.pos === 'top') { s.left = r.left + 'px'; s.top = (r.bottom + 4) + 'px'; }
      else if (D.pos === 'left') { s.left = (r.right + 4) + 'px'; s.top = r.top + 'px'; }
      else { s.right = (window.innerWidth - r.left + 4) + 'px'; s.top = r.top + 'px'; }
      menu.hidden = false;
    };

    // ---- パネル: sys/panels/<名前>.json（位置、fill、大きさ、項目 など）。ドックにもタスクバーにもなる ----
    // 項目: "アプリid" / {app|path, name, icon} / {type: launcher | windows | save | clock | version | spacer}
    D.renderPanel = async () => {
      for (const t of timers.splice(0)) clearInterval(t);
      panel.replaceChildren(); panel.hidden = true; panel.className = ''; panel.removeAttribute('style'); D.wlist = null;
      for (const e of ['top', 'right', 'bottom', 'left']) root.style.removeProperty('--inset-' + e);
      const s = kernel.settings;
      const name = s.panel !== undefined ? s.panel : (s.dock !== undefined ? s.dock : 'bottom');
      let c = BUILTIN_PANEL;
      if (!kernel.safe) {
        if (!name || !NAME.test(name)) return; // 設定で「なし」
        c = null;
        for (const p of ['/sys/panels/', '/sys/docks/']) { // docks は v0.3.1 の古い置き場所
          try { c = await kernel.readJson(p + name + '.json'); break; } catch (e) { /* 次へ */ }
        }
        if (!c) return;
      }
      const pos = ['bottom', 'top', 'left', 'right'].includes(c.position) ? c.position : 'bottom';
      const fill = !!c.fill, size = +c.size || 36;
      D.pos = pos;
      panel.className = 'p-' + pos + (fill ? ' fill' : '') + (c.autoHide ? ' auto' : '');
      panel.style.setProperty('--panel-icon', (+c.iconSize || (fill ? 28 : 44)) + 'px');
      panel.style.setProperty('--panel-size', size + 'px');
      if (c.gap !== undefined) panel.style.setProperty('--panel-gap', (+c.gap || 0) + 'px');
      if (c.radius !== undefined) panel.style.setProperty('--panel-radius', (+c.radius || 0) + 'px');
      if (c.margin !== undefined) panel.style.setProperty('--panel-margin', (+c.margin || 0) + 'px');
      if (c.opacity !== undefined) panel.style.opacity = String(Math.min(1, Math.max(0.1, +c.opacity || 1)));
      if (fill && !c.autoHide) root.style.setProperty('--inset-' + pos, size + 'px'); // 窓がパネルの下に隠れないように

      for (const it of c.items || []) {
        const o = typeof it === 'string' ? { app: it } : (it || {});
        if (o.type === 'spacer') { panel.append(el('span', 'sp')); continue; }
        if (o.type === 'windows') { D.wlist = el('span', 'wl'); panel.append(D.wlist); continue; }
        if (o.type === 'clock') {
          const t = el('span', 'pt');
          const tick = () => { const d = new Date(); t.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
          tick(); timers.push(setInterval(tick, 20000)); panel.append(t); continue;
        }
        if (o.type === 'version') { const t = el('span', 'pt'); t.textContent = 'v' + kernel.version + (kernel.safe ? '（セーフモード）' : ''); panel.append(t); continue; }
        if (o.type === 'save') {
          if (!kernel.backend || !kernel.backend.flush) continue;
          const b = el('button', 'pk'); b.title = 'Google Drive に保存';
          const upd = (n) => { b.innerHTML = I('floppy-disk') + (n ? '<span>' + (+n) + '</span>' : ''); b.disabled = !n; };
          upd(kernel.backend.pending ? kernel.backend.pending.size : 0);
          kernel.backend.onPending = upd;
          b.onclick = () => kernel.flush().catch((e) => alert(e.message));
          panel.append(b); continue;
        }
        if (o.type === 'launcher') {
          const b = el('button', 'pk' + (fill || c.labels ? ' lbl' : '')); b.dataset.launcher = '1';
          b.innerHTML = I('train') + (fill || c.labels ? '<span>TrainOS</span>' : '');
          b.title = 'アプリの一覧'; b.onclick = D.toggleLauncher; panel.append(b); continue;
        }
        const a = o.app && kernel.apps.registry.get(o.app);
        if (o.app ? !a : !o.path) continue;
        const label = o.name || (a ? a.manifest.name : o.path.split('/').pop());
        const b = el('button', 'pk'); b.dataset.app = o.app || ''; b.title = label;
        b.innerHTML = I(o.icon || (a ? a.manifest.icon : 'folder'));
        if (c.labels) { const t = el('span'); t.textContent = label; b.append(t); }
        b.onclick = () => {
          if (o.app) {
            const run = wins.filter((w) => w.instance && w.instance.appId === o.app).pop();
            if (run) run.instance.focus(); else kernel.apps.launch(o.app).catch((e) => alert(e.message));
          } else kernel.openFile(o.path).catch((e) => alert(e.message));
        };
        panel.append(b);
      }
      panel.hidden = !panel.children.length;
      D.refreshPanel();
    };

    // 起動中の点と、ウィンドウの一覧を更新する
    D.refreshPanel = () => {
      const on = new Set(wins.filter((w) => w.instance).map((w) => w.instance.appId));
      for (const b of panel.querySelectorAll('.pk[data-app]')) b.classList.toggle('run', on.has(b.dataset.app));
      const l = D.wlist;
      if (!l) return;
      l.replaceChildren();
      for (const w of wins) {
        if (!w.instance) continue;
        const b = el('button', 'pw' + (D.front === w.instance && w.state !== 'min' ? ' on' : '') + (w.state === 'min' ? ' dim' : ''));
        b.innerHTML = I(w.instance.app.manifest.icon) + '<span></span>';
        b.lastChild.textContent = w.title.textContent;
        b.onclick = () => {
          if (w.state === 'min' || D.front !== w.instance) w.instance.focus();
          else if ((wm.buttons || []).includes('min')) ctx.state(w, 'min');
        };
        l.append(b);
      }
    };

    D.start = async () => {
      await D.apply();
      D.renderIcons();
      await D.renderPanel();
      D.ready = true;
      kernel.on('fs', (p) => { if (p.startsWith('/usr/desktop')) D.renderIcons(); });
      kernel.on('apps', () => D.refreshPanel());
      window.addEventListener('resize', () => D.relayout());
      document.addEventListener('pointerdown', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-launcher]')) menu.hidden = true;
      });
    };

    return D;
  }

  window.TrainOSDesktop = { create };
})();
