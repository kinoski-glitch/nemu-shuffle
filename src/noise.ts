// 環境音の合成(設計書 9章)。フェーズ0はブラウンノイズのみ。
// 60秒分を作り、末尾を先頭に重ねて(クロスフェード)継ぎ目なくループできるようにする。

const LOOP_SEC = 60;
const XFADE_SEC = 2;

export function makeBrownNoise(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const loopLen = LOOP_SEC * sr;
  const xLen = XFADE_SEC * sr;
  const raw = new Float32Array(loopLen + xLen);

  // ホワイトノイズを積み重ねる(低い音ほど強くなる)。少しずつ0へ戻して直流のずれを防ぐ
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    raw[i] = last;
  }

  const buf = ctx.createBuffer(1, loopLen, sr);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, loopLen));
  // 末尾の続き(xLen 分)を先頭に等パワーで重ねる → 最後のサンプルから先頭へ自然につながる
  for (let i = 0; i < xLen; i++) {
    const x = i / xLen;
    out[i] = raw[loopLen + i] * Math.cos((x * Math.PI) / 2) + raw[i] * Math.sin((x * Math.PI) / 2);
  }

  // 平均音量を -20dBFS 程度に揃える
  let sum = 0;
  for (let i = 0; i < loopLen; i++) sum += out[i] * out[i];
  const gain = 0.1 / Math.sqrt(sum / loopLen);
  for (let i = 0; i < loopLen; i++) out[i] *= gain;
  return buf;
}
