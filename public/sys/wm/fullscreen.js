// ウィンドウマネージャー: フルスクリーン。ウィンドウはすべて画面いっぱい。最後に触ったものが手前に出る。
TrainOSWM.register({
  name: 'fullscreen',
  buttons: ['close'],
  movable: false,
  resizable: false,
  open(w, ctx) { const a = ctx.area(); ctx.move(w, a.x, a.y, a.w, a.h); },
  layout(wins, ctx) { const a = ctx.area(); for (const w of wins) ctx.move(w, a.x, a.y, a.w, a.h); },
});
