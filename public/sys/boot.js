// TrainOS / sys/boot.js
// ログイン前に動くブートローダーのランナー。
// ログイン前は Drive を読めないので、選択中のローダーのコードを localStorage にキャッシュしておき、
// 次回起動時はそれを実行する。キャッシュが無い（初回・未設定）ときは内蔵の画面を使う。
//
// ローダー側: TrainOSBoot.register({ name, start(el), progress({value,label}), done() })
// 起動側:     TrainOSBoot.start({ safe })  ->  progress(...)  ->  done()
// 切り替え:   await TrainOSBoot.use(kernel, 'redver')

(function () {
  'use strict';

  const KEY = 'trainos.bootLoader';
  const DIR = '/sys/boot_loader/';

  const DEFAULT = {
    name: 'default',
    start(el) { el.textContent = 'TrainOS 起動中…'; },
    progress({ label }) { if (label && this.el) this.el.textContent = label; },
    done() {},
  };

  let active = DEFAULT;
  let el = null;

  const safeName = (n) => {
    if (!/^[\w-]+$/.test(n)) throw new Error('ブートローダー名が不正です: ' + n);
    return n;
  };

  const Boot = {
    register(loader) { active = Object.assign({}, DEFAULT, loader); },

    start(opts) {
      el = document.getElementById('boot-screen');
      active = DEFAULT;
      if (!(opts && opts.safe)) {
        try {
          const c = JSON.parse(localStorage.getItem(KEY) || 'null');
          if (c && c.code) new Function(c.code)(); // ローダーが register() を呼ぶ
        } catch (e) {
          console.warn('[boot] ローダーの実行に失敗。内蔵画面にします', e);
          active = DEFAULT;
        }
      }
      active.el = el;
      try { active.start(el); } catch (e) { console.warn('[boot] start 失敗', e); DEFAULT.start(el); }
    },

    progress(p) { try { active.progress(p || {}); } catch (e) { /* 起動を止めない */ } },

    done() {
      try { active.done(); } catch (e) { /* 起動を止めない */ }
      if (el) el.remove();
    },

    // sys/boot_loader/ にある名前の一覧
    async list(kernel) {
      const dir = await kernel.getFileTree(DIR.slice(0, -1));
      return ((dir && dir.children) || [])
        .filter((n) => !n.isDirectory && /\.js$/.test(n.name))
        .map((n) => n.name.replace(/\.js$/, ''));
    },

    // コードを読み直してキャッシュだけ更新（毎回のログイン後に呼ぶと、編集が反映される）
    async cache(kernel, name) {
      const code = await (await kernel.readFile(DIR + safeName(name) + '.js')).text();
      localStorage.setItem(KEY, JSON.stringify({ name, code }));
    },

    // 切り替え: キャッシュ更新 + settings.json に保存
    async use(kernel, name) {
      await Boot.cache(kernel, name);
      kernel.settings.bootLoader = name;
      await kernel.writeFile('/sys/settings.json', new Blob([JSON.stringify(kernel.settings, null, 2)]));
    },
  };

  window.TrainOSBoot = Boot;
})();
