// ウィンドウマネージャー: タイル。ウィンドウを重ねず、画面いっぱいに並べる（左に大きく1つ、右に残りを縦に）。
// 最初のウィンドウが「メイン」。キー割り当てで nextWindow / prevWindow / toMaster が使える。
// 窓の間隔は、テーマの CSS で --wm-gap（例: 8px）を指定する。
TrainOSWM.register({
  name: 'tiling',
  buttons: ['close'],
  movable: false,
  resizable: false,
  open(w, ctx) { const a = ctx.area(); ctx.move(w, a.x, a.y, a.w, a.h); },
  layout(wins, ctx) {
    const vis = wins.filter((w) => w.state !== 'min');
    const a = ctx.area(), g = ctx.gap(), n = vis.length;
    if (!n) return;
    if (n === 1) { ctx.move(vis[0], a.x + g, a.y + g, a.w - 2 * g, a.h - 2 * g); return; }
    const mw = Math.round(a.w * 0.55);
    ctx.move(vis[0], a.x + g, a.y + g, mw - g * 1.5, a.h - 2 * g);
    const rest = vis.slice(1), h = (a.h - g) / rest.length;
    rest.forEach((w, i) => ctx.move(w, a.x + mw + g / 2, a.y + g + i * h, a.w - mw - g * 1.5, h - g));
  },
});
