// 起動時に実行される components のサンプル。引数の kernel と component から OS の機能を使える。
// 不要なら、設定画面でオフにするか、このファイルを削除する。詳しくは docs.html の「components の API」。
console.info('[components] hello.js: TrainOS ' + kernel.version);

// イベント: 起こったことを知らせてくる（戻り値は見ない）
component.on('ready', () => console.info('[hello] デスクトップが開きました'));
// component.on('app:launch', ({ instance }) => console.info('[hello] 起動:', instance.appId));

// フック: 操作の前に呼ばれる。false を返すと中止。渡された ctx を書き換えると変更できる
// component.hook('openFile', (ctx) => { if (ctx.path.endsWith('.log')) ctx.appId = 'notepad'; });
// component.hook('fs.delete', (ctx) => { if (ctx.path.startsWith('/usr/documents/keep/')) return false; });
