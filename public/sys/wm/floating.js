// ウィンドウマネージャー: フローティング（標準）。自由に動かす・大きさを変える・最小化・最大化ができる。
// w   = { id, app, el, bar, title, content, state, size: { width, height } }
// ctx = { area(), gap(), move(w, x, y, 幅, 高さ), raise(w), state(w, 'normal' | 'max' | 'min') }
TrainOSWM.register({
  name: 'floating',
  buttons: ['min', 'max', 'close'],  // タイトルバーに出すボタン
  movable: true,                      // タイトルバーのドラッグで動かせる
  resizable: true,                    // 右下をつかんで大きさを変えられる
  open(w, ctx) {                      // 新しいウィンドウを置く（少しずつずらして重ねる）
    const a = ctx.area(), n = (w.id - 1) % 8;
    ctx.move(w, a.x + 40 + n * 28, a.y + 30 + n * 28, w.size.width, w.size.height);
  },
});
