(() => {
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const pathInput = $('path');
  const status = $('status');
  let path = null;
  let dirty = false;

  function render(msg) {
    const name = path ? path.split('/').pop() : '無題';
    TrainOS.app.setTitle((dirty ? '● ' : '') + name + ' - メモ帳');
    status.textContent = msg || path || '未保存';
  }

  async function openFile(p) {
    try {
      editor.value = await TrainOS.fs.readText(p);
      path = p;
      pathInput.value = p;
      dirty = false;
      render();
    } catch (e) {
      render('開けません: ' + e.message);
    }
  }

  async function save() {
    const p = pathInput.value.trim();
    if (!p) return render('保存先パスを入力してください');
    try {
      await TrainOS.fs.writeFile(p, editor.value);
      path = p;
      dirty = false;
      render('保存しました');
    } catch (e) {
      render('保存失敗: ' + e.message);
    }
  }

  editor.addEventListener('input', () => {
    if (!dirty) { dirty = true; render(); }
  });
  $('open').addEventListener('click', () => {
    const p = pathInput.value.trim();
    if (p) openFile(p);
  });
  $('save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  // エクスプローラー等から開かれたときにパスが渡される
  TrainOS.app.onOpen(openFile);
  render();
})();
