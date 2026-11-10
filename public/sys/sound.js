// TrainOS / sys/sound.js
// 効果音。sys/sounds/<テーマ名>.json に「イベント名 -> 音」を書き、設定画面で選ぶ。
//   settings.sound        テーマ名（null でオフ。既定はオフ）
//   settings.soundVolume  音量 0-100（既定 60）
//
// テーマの中身（キーがイベント名。_ で始めるキーなど、不正なものは読み飛ばす）:
//   { "launch": [[660, 0.07], [880, 0.09]],       音の並び（シンセ。ファイル不要）
//     "close": "close.wav",                       sys/sounds/ にある音声ファイル（wav mp3 ogg m4a webm flac。2MB まで）
//     "error": [{ "f": 200, "d": 0.2, "t": "square", "g": 0.4 }] }
//   音の並び: [周波数 Hz, 秒] か { f, d, t: sine|square|triangle|sawtooth, g: 0-1, at: 開始までの秒 }。
//   at を省くと、前の音のあとに続ける。16 音まで、全体で 4 秒まで。
//
// OS が鳴らすイベント: startup launch close dialog error save。
// kernel.sound.play(名前) / アプリの TrainOS.sound.play(名前) は、テーマにある名前だけ鳴る（独自の名前も書ける）。
// ブラウザは、ページを操作する前の音を止めることがある。その場合は、最初の操作のあとから鳴る。

(function () {
  'use strict';

  const NAME = /^[\w-]+$/;
  const EVENT = /^[\w.:-]{1,40}$/;
  const FILE = /^[\w.-]+\.(wav|mp3|ogg|m4a|webm|flac)$/i;
  const WAVES = ['sine', 'square', 'triangle', 'sawtooth'];
  const MAX_FILE = 2 * 1024 * 1024;

  const clamp = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

  // 音の並びを検証して { f, d, t, g, at } の配列にする。不正なら null
  function notes(spec) {
    if (!Array.isArray(spec) || !spec.length || spec.length > 16) return null;
    const out = [];
    let next = 0, end = 0;
    for (const n of spec) {
      const o = Array.isArray(n) ? { f: n[0], d: n[1] } : n;
      if (!o || typeof o !== 'object') return null;
      const f = +o.f, d = +o.d;
      if (!(f >= 20 && f <= 20000) || !(d >= 0.01 && d <= 2)) return null;
      const at = o.at === undefined ? next : clamp(o.at, 0, 4, 0);
      out.push({ f, d, t: WAVES.includes(o.t) ? o.t : 'sine', g: clamp(o.g, 0, 1, 0.5), at });
      next = at + d;
      end = Math.max(end, next);
    }
    return end <= 4 ? out : null;
  }

  function create(kernel) {
    const S = { theme: null, volume: 0.6, events: Object.create(null), ctx: null, buffers: new Map() };

    const audio = () => {
      if (S.ctx) return S.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { S.ctx = new AC(); } catch (e) { return null; }
      return S.ctx;
    };

    // 鳴らせる状態にする。まだ許されていなければ、少しだけ待って、だめなら諦める
    const ready = (c) => {
      if (c.state === 'running') return Promise.resolve(true);
      return Promise.race([
        Promise.resolve(c.resume()).then(() => c.state === 'running'),
        new Promise((ok) => setTimeout(() => ok(false), 150)),
      ]).catch(() => false);
    };

    // 最初の操作のあとなら、音を出せる状態にしておく
    S.unlock = () => {
      if (!S.theme) return;
      const c = audio();
      if (c && c.state === 'suspended') Promise.resolve(c.resume()).catch(() => {});
    };
    document.addEventListener('pointerdown', S.unlock, true);
    document.addEventListener('keydown', S.unlock, true);

    // 設定（テーマ名と音量）と、テーマのファイルを読み直す。セーフモードでは鳴らさない
    S.load = async () => {
      const s = kernel.settings || {};
      S.volume = s.soundVolume === undefined ? 0.6 : clamp(s.soundVolume, 0, 100, 60) / 100;
      S.events = Object.create(null);
      S.buffers.clear();
      S.theme = !kernel.safe && s.sound && NAME.test(String(s.sound)) ? String(s.sound) : null;
      if (!S.theme) return;
      try {
        const j = await kernel.readJson('/sys/sounds/' + S.theme + '.json');
        for (const [k, v] of Object.entries(j && typeof j === 'object' && !Array.isArray(j) ? j : {})) {
          if (!EVENT.test(k)) continue;
          if (typeof v === 'string') { if (FILE.test(v)) S.events[k] = v; }
          else { const n = notes(v); if (n) S.events[k] = n; }
        }
      } catch (e) { console.warn('[sound] 効果音のテーマを読めません:', S.theme, e); }
    };

    const file = (fname) => {
      if (!S.buffers.has(fname)) {
        S.buffers.set(fname, (async () => {
          const blob = await kernel.readFile('/sys/sounds/' + fname);
          if (blob.size > MAX_FILE) throw new Error('音声ファイルが大きすぎます（2MB まで）');
          return audio().decodeAudioData(await blob.arrayBuffer());
        })().catch((e) => { console.warn('[sound] 読めません:', fname, e); return null; }));
      }
      return S.buffers.get(fname);
    };

    // 鳴らす（鳴らす予定にできたら true。テーマに無い名前・オフ・音量 0 は false）
    S.play = (name) => {
      name = String(name);
      const spec = EVENT.test(name) ? S.events[name] : null;
      if (!S.theme || !spec || !S.volume) return false;
      const c = audio();
      if (!c) return false;
      ready(c).then(async (ok) => {
        if (!ok) return;
        const out = c.createGain();
        out.gain.value = S.volume;
        out.connect(c.destination);
        if (typeof spec === 'string') {
          const buf = await file(spec);
          if (!buf) return;
          const src = c.createBufferSource();
          src.buffer = buf;
          src.connect(out);
          src.start();
          return;
        }
        const t0 = c.currentTime + 0.01;
        for (const n of spec) {
          const o = c.createOscillator(), g = c.createGain();
          const s = t0 + n.at, e = s + n.d;
          o.type = n.t;
          o.frequency.value = n.f;
          g.gain.setValueAtTime(0.0001, s);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0001, n.g), s + Math.min(0.01, n.d / 2));
          g.gain.exponentialRampToValueAtTime(0.0001, e);
          o.connect(g);
          g.connect(out);
          o.start(s);
          o.stop(e + 0.02);
        }
      }).catch((e) => console.warn('[sound]', e));
      return true;
    };

    // sys/sounds/ を編集したら読み直す
    let t;
    kernel.on('fs', (p) => {
      if (!String(p).startsWith('/sys/sounds')) return;
      clearTimeout(t);
      t = setTimeout(() => S.load(), 300);
    });

    return S;
  }

  window.TrainOSSound = { create, notes };
})();
