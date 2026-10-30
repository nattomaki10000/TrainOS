// 赤いくるくるだけの起動画面
TrainOSBoot.register({
  name: 'redver',
  start(el) {
    el.style.background = '#200';
    el.innerHTML =
      '<style>@keyframes r{to{transform:rotate(1turn)}}</style>' +
      '<div style="display:grid;place-items:center;height:100%">' +
      '<div style="width:48px;height:48px;border:5px solid #833;border-top-color:#f55;' +
      'border-radius:50%;animation:r 1s linear infinite"></div></div>';
  },
});
