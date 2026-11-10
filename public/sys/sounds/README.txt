効果音のテーマを置くフォルダです。設定画面の「効果音」で選びます（既定はオフ）。

テーマは JSON です。キーがイベント名、値が音です。
  { "launch": [[660, 0.06], [880, 0.09]], "close": "close.wav" }

- 音の並び（シンセ。ファイル不要）: [周波数Hz, 秒] か { "f": 周波数, "d": 秒, "t": "sine|square|triangle|sawtooth", "g": 0〜1, "at": 開始までの秒 }
  16 音まで、全体で 4 秒まで。
- 音声ファイル: このフォルダの wav / mp3 / ogg / m4a / webm / flac（2MB まで）の名前を書く。
- OS が鳴らすイベント: startup launch close dialog error save
- アプリは TrainOS.sound.play('名前')、components は kernel.sound.play('名前') で、テーマにある名前を鳴らせます。
- "_" で始まるキー（_comment など）は無視されます。

詳しくは docs.html の「効果音」を見てください。
