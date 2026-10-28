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

/** 曲線のうち、位置 pos より後ろの部分だけを予約する(曲線は位置 start から dur 秒かけて動く) */
function curveFrom(param: AudioParam, curve: Float32Array, start: number, dur: number, pos: number, t0: number): void {
  if (pos >= start + dur) return;
  if (pos <= start) {
    param.setValueCurveAtTime(curve, t0 + start, dur);
    return;
  }
  const i = Math.min(curve.length - 2, Math.floor(((pos - start) / dur) * (curve.length - 1)));
  param.value = curve[i];
  param.setValueCurveAtTime(curve.slice(i), t0 + pos, start + dur - pos);
}

interface PlannedWord {
  buf: AudioBuffer;
  p: number; // 開始からの秒
}

export class Session {
  /** いま使っている AudioContext。再開のたびに作り直すので入れ替わる */
  ctx!: AudioContext;
  /** 開始位置(0秒)にあたる音声の時計の時刻。作り直すと変わる */
  t0 = 0;
  tEnd = 0;
  /** 音声を作り直した回数 */
  rebuilds = 0;
  readonly scheduledWords: number;
  readonly requestedRate = SAMPLE_RATE;
  private master!: GainNode;
  private readonly lib: Library;
  private readonly opts: PlayOptions;
  private readonly audioEl: HTMLAudioElement;
  private readonly onState: (s: string) => void;
  private readonly plan: PlannedWord[] = [];
  private readonly fadeIn: number;
  private readonly fadeOut: number;
  private closed = false;

  /** ユーザーのタップの中で呼ぶこと(iOS は操作の中でしか音を出し始められない) */
  constructor(lib: Library, opts: PlayOptions, audioEl: HTMLAudioElement, onState: (s: string) => void) {
    this.lib = lib;
    this.opts = opts;
    this.audioEl = audioEl;
    this.onState = onState;
    const D = opts.durationSec;
    this.fadeIn = Math.min(opts.fadeInSec, D / 4);
    this.fadeOut = Math.min(opts.fadeOutSec, D / 2);

    // 単語の予定を先に決めておく(作り直しても同じ順番・同じ時刻で続ける)。
    // 間隔は「基本間隔 ×(1 + 0.5 × 経過の割合)± ゆらぎ」
    const shuffler = new Shuffler(lib.words);
    let p = Math.min(4, this.fadeIn);
    for (;;) {
      const w = shuffler.next();
      const buf = lib.buffers.get(w.id)!;
      if (p + buf.duration > D - 0.5) break;
      this.plan.push({ buf, p });
      const base = opts.intervalSec * (opts.slowdown ? 1 + 0.5 * (p / D) : 1);
      const jitter = (Math.random() * 2 - 1) * opts.jitterSec;
      p += Math.max(buf.duration + 1, base + jitter);
    }
    this.scheduledWords = this.plan.length;
    void this.build(0);
  }

  /**
   * 新しい AudioContext を作り、位置 pos(開始からの秒)から終了までの音をすべて予約する。
   * ユーザーのタップの中で呼ぶこと。
   */
  private build(pos: number): Promise<void> {
    requestPlaybackSession();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (this.ctx === ctx) this.onState(ctx.state);
    };
    const resumed = ctx.resume();

    const { opts, lib } = this;
    const D = opts.durationSec;
    const now = ctx.currentTime + 0.3;
    this.t0 = now - pos;
    this.tEnd = this.t0 + D;

    // 音の通り道
    this.master = ctx.createGain();
    const entry = ctx.createGain(); // 途中から再開するときだけ、1.5秒かけて音量を戻す
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = opts.voiceVol;
    const soften = ctx.createBiquadFilter();
    soften.type = 'highshelf';
    soften.frequency.value = 3500;
    soften.gain.value = opts.soften ? -6 : 0;
    voiceGain.connect(soften).connect(this.master);
    this.master.connect(entry);

    if (opts.output === 'element') {
      // 予備の方式: Web Audio の出力を <audio> 要素に流す(ロック中に止まる端末向け)
      const dest = ctx.createMediaStreamDestination();
      entry.connect(dest);
      this.audioEl.srcObject = dest.stream;
      void this.audioEl.play();
    } else {
      entry.connect(ctx.destination);
    }

    // 全体の音量: 最初に上げ、終了前に下げる(予約)。途中から始めるときは、その位置の続きから
    const g = this.master.gain;
    g.value = pos < this.fadeIn ? 0 : 1;
    curveFrom(g, fadeInCurve(), 0, this.fadeIn, pos, this.t0);
    curveFrom(g, fadeOutCurve(), D - this.fadeOut, this.fadeOut, pos, this.t0);
    if (pos > 0) entry.gain.setValueCurveAtTime(fadeInCurve(), now, 1.5);

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
      amb.start(now);
      amb.stop(this.tEnd + 0.1);
    }

    // 単語: 位置 pos より後の全語を時刻つきで予約する。読み上げ途中の語はその続きから
    for (const { buf, p } of this.plan) {
      if (p + buf.duration <= pos) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(voiceGain);
      if (p >= pos) src.start(this.t0 + p);
      else src.start(now, pos - p);
    }
    return resumed;
  }

  get state(): string {
    return this.closed ? 'closed' : this.ctx.state;
  }

  /** 開始からの位置(秒) */
  position(): number {
    return Math.min(this.opts.durationSec, Math.max(0, this.ctx.currentTime - this.t0));
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
    if (this.opts.output === 'element') this.audioEl.pause();
  }

  /**
   * 再開。iPhone では、止まった AudioContext を再開しても時計が進まず鳴らないことがあるため、
   * 毎回作り直して止まった位置から予約し直す。ユーザーのタップの中で呼ぶこと。
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    const old = this.ctx;
    const pos = this.position();
    old.onstatechange = null;
    const resumed = this.build(pos);
    this.rebuilds++;
    try {
      await old.close();
    } catch {
      /* すでに閉じている */
    }
    await resumed;
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
    if (this.opts.output === 'element') {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    try {
      await this.ctx.close();
    } catch {
      /* すでに閉じている */
    }
  }
}
