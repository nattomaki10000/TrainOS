// プログレスバー + 読み込み中のファイル名を表示する起動画面
TrainOSBoot.register({
  name: 'example',
  start(el) {
    el.innerHTML =
      '<div style="display:grid;place-items:center;height:100%;gap:8px;font:14px system-ui">' +
      '<b>TrainOS</b>' +
      '<progress id="bp" max="100" value="0" style="width:240px"></progress>' +
      '<span id="bl">起動中…</span></div>';
  },
  progress({ value, label }) {
    const p = document.getElementById('bp');
    const l = document.getElementById('bl');
    if (p && value != null) p.value = value;
    if (l && label) l.textContent = label;
  },
});
