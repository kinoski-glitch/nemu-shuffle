// 再生エンジン(設計書 8章)
// 開始ボタンを押した時点で、終了までに鳴る音(全単語・環境音・フェード)をすべて
// 音声処理側に予約する。その後は JavaScript が止まっても予定どおり鳴って止まる。
//
//   単語 × 多数 → 声の音量 → やわらかフィルタ ┐
//   環境音(ループ)→ 環境音の音量 ─────────┴→ 全体の音量(フェード)→ 出力

import { makeBrownNoise } from './noise';
import { Shuffler, type Word } from './shuffle';

export const SAMPLE_RATE = 24000;

export type Ambient = 'brown' | 'faint' | 'none';
export type Output = 'direct' | 'element';

export interface PlayOptions {
  durationSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  intervalSec: number;
  jitterSec: number;
  slowdown: boolean;
  voiceVol: number; // 0〜1
  ambientVol: number; // 0〜1
  soften: boolean;
  ambient: Ambient;
  output: Output;
}

export interface Library {
  words: Word[];
  buffers: Map<string, AudioBuffer>;
  noise: AudioBuffer;
  credit: string;
  placeholder: boolean;
}

interface Manifest {
  version: number;
  voices: { id: string; credit: string; placeholder?: boolean; files: Record<string, { dur: number; hash: string }> }[];
  words: Word[];
}

type AudioSessionNav = Navigator & { audioSession?: { type: string; state?: string } };

/** 対応端末(iOS 16.4 以降の Safari など)で、音声の扱いを「再生用」にする。消音スイッチ・画面ロック対策 */
export function requestPlaybackSession(): string {
  const s = (navigator as AudioSessionNav).audioSession;
  if (!s) return 'なし';
  try {
    s.type = 'playback';
  } catch {
    /* 一部の端末では設定できない */
  }
  return s.type;
}

/** アプリを開いた時に、音声ファイルの展開と環境音の生成を済ませておく(タップ後の処理を軽くするため) */
export async function loadLibrary(onProgress: (done: number, total: number) => void): Promise<Library> {
  const manifestUrl = new URL('audio/manifest.json', document.baseURI);
  const res = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`目録を読めません(${res.status})`);
  const manifest = (await res.json()) as Manifest;
  const voice = manifest.voices[0];
  if (!voice) throw new Error('声がありません');

  // 展開だけなら、ユーザー操作なしで作れる OfflineAudioContext で足りる。AudioBuffer は別の AudioContext でも使える
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const words = manifest.words.filter((w) => voice.files[w.id]);
  const buffers = new Map<string, AudioBuffer>();
  let done = 0;
  onProgress(0, words.length);

  const queue = words.slice();
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const url = new URL(`audio/${voice.id}/${w.id}.m4a?h=${voice.files[w.id].hash}`, document.baseURI);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${w.text} の音声を読めません(${r.status})`);
      buffers.set(w.id, await decoder.decodeAudioData(await r.arrayBuffer()));
      onProgress(++done, words.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  return { words, buffers, noise: makeBrownNoise(decoder), credit: voice.credit, placeholder: !!voice.placeholder };
}

function fadeInCurve(n = 128): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.sin(((i / (n - 1)) * Math.PI) / 2) ** 2;
  return c;
}

/** 耳には音量の「比」で聞こえるので、dB で一定の速さで下げ(0 → -50dB)、最後の 5% で 0 へ落とす */
function fadeOutCurve(n = 256): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const tail = x > 0.95 ? (1 - x) / 0.05 : 1;
    c[i] = 10 ** ((-50 * x) / 20) * tail;
  }
  return c;
}

export class Session {
  readonly ctx: AudioContext;
  readonly t0: number;
  readonly tEnd: number;
  readonly scheduledWords: number;
  readonly requestedRate = SAMPLE_RATE;
  private readonly master: GainNode;
  private readonly audioEl?: HTMLAudioElement;
  private closed = false;

  /** ユーザーのタップの中で呼ぶこと(iOS は操作の中でしか音を出し始められない) */
  constructor(lib: Library, opts: PlayOptions, audioEl: HTMLAudioElement, onState: (s: string) => void) {
    requestPlaybackSession();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    this.ctx = ctx;
    ctx.onstatechange = () => onState(ctx.state);
    void ctx.resume();

    // 音の通り道
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = opts.voiceVol;
    const soften = ctx.createBiquadFilter();
    soften.type = 'highshelf';
    soften.frequency.value = 3500;
    soften.gain.value = opts.soften ? -6 : 0;
    voiceGain.connect(soften).connect(this.master);

    if (opts.output === 'element') {
      // 予備の方式: Web Audio の出力を <audio> 要素に流す(ロック中に止まる端末向け)
      const dest = ctx.createMediaStreamDestination();
      this.master.connect(dest);
      audioEl.srcObject = dest.stream;
      void audioEl.play();
      this.audioEl = audioEl;
    } else {
      this.master.connect(ctx.destination);
    }

    const D = opts.durationSec;
    const fadeIn = Math.min(opts.fadeInSec, D / 4);
    const fadeOut = Math.min(opts.fadeOutSec, D / 2);
    this.t0 = ctx.currentTime + 0.3;
    this.tEnd = this.t0 + D;

    // 全体の音量: 最初に上げ、終了前に下げる(予約)
    this.master.gain.setValueCurveAtTime(fadeInCurve(), this.t0, fadeIn);
    this.master.gain.setValueCurveAtTime(fadeOutCurve(), this.tEnd - fadeOut, fadeOut);

    // 環境音
    if (opts.ambient !== 'none') {
      const ambGain = ctx.createGain();
      // 「ごく小さいノイズ」は、無音が続いて iOS が再生終了とみなすのを防げるかの確認用(約 -60dB)
      ambGain.gain.value = opts.ambient === 'faint' ? 0.001 : opts.ambientVol;
      ambGain.connect(this.master);
      const amb = ctx.createBufferSource();
      amb.buffer = lib.noise;
      amb.loop = true;
      amb.connect(ambGain);
      amb.start(this.t0);
      amb.stop(this.tEnd + 0.1);
    }

    // 単語: 終了までの全語を時刻つきで予約する。間隔は「基本間隔 ×(1 + 0.5 × 経過の割合)± ゆらぎ」
    const shuffler = new Shuffler(lib.words);
    let t = this.t0 + Math.min(4, fadeIn);
    let count = 0;
    for (;;) {
      const w = shuffler.next();
      const buf = lib.buffers.get(w.id)!;
      if (t + buf.duration > this.tEnd - 0.5) break;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(voiceGain);
      src.start(t);
      count++;
      const progress = (t - this.t0) / D;
      const base = opts.intervalSec * (opts.slowdown ? 1 + 0.5 * progress : 1);
      const jitter = (Math.random() * 2 - 1) * opts.jitterSec;
      t += Math.max(buf.duration + 1, base + jitter);
    }
    this.scheduledWords = count;
  }

  get state(): string {
    return this.closed ? 'closed' : this.ctx.state;
  }

  /** 残り時間(秒)。一時停止中は音声の時計も止まるので、そのぶん自然に延びる */
  remaining(): number {
    return Math.max(0, this.tEnd - Math.max(this.t0, this.ctx.currentTime));
  }

  isFinished(): boolean {
    return this.ctx.currentTime >= this.tEnd + 0.5;
  }

  async pause(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend();
    this.audioEl?.pause();
  }

  async resume(): Promise<void> {
    await this.ctx.resume();
    if (this.audioEl) await this.audioEl.play();
  }

  /** 停止ボタン: 1秒かけて音量を下げてから閉じる(「ブツッ」と切らない) */
  async stop(): Promise<void> {
    if (this.closed) return;
    if (this.ctx.state === 'running') {
      const g = this.master.gain;
      const now = this.ctx.currentTime;
      const v = g.value;
      g.cancelScheduledValues(0);
      g.setValueAtTime(v, now);
      g.linearRampToValueAtTime(0, now + 1);
      await new Promise((r) => setTimeout(r, 1100));
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.audioEl?.pause();
    if (this.audioEl) this.audioEl.srcObject = null;
    try {
      await this.ctx.close();
    } catch {
      /* すでに閉じている */
    }
  }
}
