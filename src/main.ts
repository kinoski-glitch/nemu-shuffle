import './style.css';
import {
  clearLog,
  environmentSummary,
  loadSession,
  localTime,
  log,
  logText,
  onLog,
  saveSession,
  type SessionRecord,
} from './diag';
import { loadLibrary, requestPlaybackSession, Session, type Ambient, type Library, type Output, type PlayOptions } from './engine';

// ---------- 設定(端末内に保存) ----------

interface Settings {
  timer: string; // 分
  ambient: Ambient;
  ambVol: string; // 環境音の大きさ(%)
  output: Output;
}

const SETTINGS_KEY = 'nemu.v0.settings';
const DEFAULTS: Settings = { timer: '30', ambient: 'brown', ambVol: '20', output: 'direct' };

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 保存できなくても動かす */
  }
}

const settings = loadSettings();

function playOptions(): PlayOptions {
  const min = Number(settings.timer);
  return {
    durationSec: min * 60,
    fadeInSec: 10,
    fadeOutSec: min >= 15 ? 5 * 60 : 60, // お試し(3分)のときは最後の1分
    intervalSec: 8,
    jitterSec: 1,
    slowdown: true,
    voiceVol: 0.8,
    // 40%・32% では声が埋もれたため、既定は 20%。試作では端末で聞きながら選べる
    ambientVol: (Number(settings.ambVol) || 20) / 100,
    soften: false, // 声に引っかかりを感じたため既定はオフ(改善課題: docs/design.md 12章)
    ambient: settings.ambient,
    output: settings.output,
  };
}

// ---------- 画面 ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>('start');
const pauseBtn = $<HTMLButtonElement>('pause');

function show(id: string): void {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
  if (id === 'log') renderLog();
  window.scrollTo(0, 0);
}

document.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
  b.addEventListener('click', () => show(b.dataset.go!));
});

document.querySelectorAll<HTMLElement>('.chips').forEach((group) => {
  const key = group.dataset.key as keyof Settings;
  const buttons = group.querySelectorAll<HTMLButtonElement>('button');
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings[key])));
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      (settings[key] as string) = b.dataset.v!;
      saveSettings();
      sync();
    }),
  );
  sync();
});

function fmt(sec: number): string {
  const s = Math.ceil(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function renderLog(): void {
  $('env').textContent = environmentSummary().join('\n');
  const el = $('logtext');
  el.textContent = logText() || '(まだ記録はありません)';
  el.scrollTop = el.scrollHeight;
}
onLog(() => {
  if ($('log').classList.contains('active')) renderLog();
});

$('copylog').addEventListener('click', async () => {
  const text = `${environmentSummary().join('\n')}\n\n${logText()}`;
  try {
    await navigator.clipboard.writeText(text);
    $('copylog').textContent = 'コピーしました';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('logtext'));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    $('copylog').textContent = '選択しました(長押しでコピー)';
  }
  setTimeout(() => ($('copylog').textContent = '記録をコピー'), 2500);
});

$('clearlog').addEventListener('click', () => {
  if (confirm('試験の記録を消しますか?')) clearLog();
});

// 再生中の画面は5秒触らないとさらに暗くする
let dimTimer = 0;
function wake(): void {
  $('playing').classList.remove('dim');
  clearTimeout(dimTimer);
  dimTimer = window.setTimeout(() => $('playing').classList.add('dim'), 5000);
}
$('playing').addEventListener('pointerdown', wake);

// ---------- 前回の試験結果 ----------

function judge(rec: SessionRecord): string {
  const start = localTime(new Date(rec.startedWall));
  const head = `前回の試験: ${start} 開始・${Math.round(rec.durationSec / 60)}分\n${rec.settings}`;
  const lag = `ロック中のずれ(最大): ${rec.maxLagSec.toFixed(1)}秒${extSummary(rec)}`;
  if (!rec.ended) {
    const alive = Math.round((rec.lastBeatWall - rec.startedWall) / 60000);
    return `${head}\n⚠ 終了処理の前にページが閉じられました(開始から約${alive}分後まで動作を確認)\n${lag}`;
  }
  if (rec.ended === 'stopped') return `${head}\n途中で停止ボタンが押されました\n${lag}`;
  const ok = rec.maxLagSec < 3;
  return `${head}\n${ok ? '✓ 予約した終了時刻まで音声処理が進みました' : '⚠ 音声処理が途中で止まっていた時間があります'}\n${lag}`;
}

function extSummary(r: SessionRecord): string {
  return r.extPauses ? `\n外からの一時停止: ${r.extPauses}回・計 ${(r.extPausedSec ?? 0).toFixed(1)}秒` : '';
}

function showBanner(rec: SessionRecord | null): void {
  const el = $('banner');
  el.hidden = !rec;
  if (rec) el.textContent = judge(rec);
}

// ---------- 再生の管理 ----------

let lib: Library | null = null;
let session: Session | null = null;
let rec: SessionRecord | null = null;
let baseline: { wall: number; ctx: number } | null = null; // ずれの計測の起点
let lagBefore = 0; // 一時停止より前に計測したずれ
let lastTick = 0;
let paused = false;
let pausedAt = 0;
// iPhone のロック画面のボタンは、アプリの処理を通さずブラウザが直接音声を止める・再開する。
// そうした「外からの一時停止」もアプリの一時停止と同じに扱い、止まっていた時間をずれに数えない
let extPaused = false;

/** 壁の時計に対して、音声の時計がどれだけ遅れているか(秒)。ロック中に音声処理が止まると増える */
function measureLag(): number {
  if (!session || !baseline) return lagBefore;
  const wall = (Date.now() - baseline.wall) / 1000;
  const ctx = session.ctx.currentTime - baseline.ctx;
  return lagBefore + Math.max(0, wall - ctx);
}

function updateRecord(): void {
  if (!session || !rec) return;
  rec.lastBeatWall = Date.now();
  rec.lastBeatCtx = session.ctx.currentTime;
  // 終了時刻を過ぎた後のずれ(音が止まった後に iOS が処理を休ませる等)は数えない
  if (session.ctx.currentTime < session.tEnd) rec.maxLagSec = Math.max(rec.maxLagSec, measureLag());
  saveSession(rec);
}

function onCtxState(state: string): void {
  log(session ? `音声の状態: ${state}(音声の時計 ${session.ctx.currentTime.toFixed(1)}秒)` : `音声の状態: ${state}`);
  if (!session) return;
  if ((state === 'suspended' || state === 'interrupted') && !paused) {
    // アプリが止めていないのに止まった
    markPaused(true);
    extPaused = true;
    log('外から一時停止されました(ロック画面のボタン・着信・他のアプリの音など)');
  } else if (state === 'running' && extPaused) {
    const sec = (Date.now() - pausedAt) / 1000;
    if (rec) {
      rec.extPauses = (rec.extPauses ?? 0) + 1;
      rec.extPausedSec = (rec.extPausedSec ?? 0) + sec;
    }
    markPaused(false);
    log(`外から再開されました(止まっていた時間 ${sec.toFixed(1)}秒)`);
    watchClock();
  } else if (state === 'running' && !baseline && !paused) {
    baseline = { wall: Date.now(), ctx: session.ctx.currentTime };
  }
}

/** 一時停止・再開に伴う記録と表示の切り替え(音声そのものの停止・再開は呼び出し側で行う) */
function markPaused(on: boolean): void {
  if (!session) return;
  extPaused = false;
  if (on) {
    lagBefore = measureLag();
    baseline = null;
    paused = true;
    pausedAt = Date.now();
    pauseBtn.textContent = '再開';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  } else {
    paused = false;
    if (rec) rec.pausedMs += Date.now() - pausedAt;
    baseline = { wall: Date.now(), ctx: session.ctx.currentTime };
    pauseBtn.textContent = '一時停止';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }
  updateRecord();
}

function setupMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'ねむシャッフル', artist: 'フェーズ0 試作' });
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setActionHandler('pause', () => {
      log('ロック画面の操作: 一時停止');
      void togglePause(true);
    });
    navigator.mediaSession.setActionHandler('play', () => {
      log('ロック画面の操作: 再生');
      void togglePause(false);
    });
    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        log('ロック画面の操作: 停止');
        void stop();
      });
    } catch {
      /* stop に対応していない端末 */
    }
  } catch (e) {
    log(`mediaSession の設定に失敗: ${String(e)}`);
  }
}

function start(): void {
  if (!lib || session) return;
  const opts = playOptions();
  const t = performance.now();
  try {
    session = new Session(lib, opts, $<HTMLAudioElement>('sink'), onCtxState);
  } catch (e) {
    log(`⚠ 開始できませんでした: ${String(e)}`);
    alert(`開始できませんでした: ${String(e)}`);
    return;
  }
  const setupMs = Math.round(performance.now() - t);
  const ctx = session.ctx;
  const label = `タイマー${settings.timer}分・環境音 ${settings.ambient}${settings.ambient === 'brown' ? `(${settings.ambVol}%)` : ''}・出力 ${settings.output}`;
  baseline = ctx.state === 'running' ? { wall: Date.now(), ctx: ctx.currentTime } : null;
  lagBefore = 0;
  paused = false;
  extPaused = false;
  rec = {
    id: String(Date.now()),
    startedWall: Date.now(),
    t0: session.t0,
    tEnd: session.tEnd,
    durationSec: opts.durationSec,
    pausedMs: 0,
    lastBeatWall: Date.now(),
    lastBeatCtx: ctx.currentTime,
    maxLagSec: 0,
    settings: label,
  };
  saveSession(rec);

  const nav = navigator as Navigator & { audioSession?: { type: string } };
  log(`▶ 開始: ${label}`);
  log(
    `サンプリング周波数 ${ctx.sampleRate}Hz(指定 ${session.requestedRate}Hz)・予約した単語 ${session.scheduledWords}語・準備 ${setupMs}ms・audioSession ${nav.audioSession?.type ?? 'なし'}`,
  );
  if (lib.placeholder) log('声は仮の音です(VOICEVOX 未生成)');

  setupMediaSession();
  pauseBtn.textContent = '一時停止';
  $('playinfo').textContent = '';
  show('playing');
  wake();
  lastTick = Date.now();
}

async function togglePause(wantPause = !paused): Promise<void> {
  if (!session || wantPause === paused) return;
  if (wantPause) {
    markPaused(true); // 先に paused にしておくと、続く suspended を「外から」と誤解しない
    await session.pause();
    log('一時停止');
  } else {
    if (extPaused && rec) {
      // 外から止められたものを、アプリの再開ボタンで戻した
      rec.extPauses = (rec.extPauses ?? 0) + 1;
      rec.extPausedSec = (rec.extPausedSec ?? 0) + (Date.now() - pausedAt) / 1000;
    }
    markPaused(false);
    baseline = null; // 音声を作り直している間は、ずれを計らない
    await session.resume();
    if (!session) return;
    baseline = { wall: Date.now(), ctx: session.ctx.currentTime };
    log(`再開(音声を作り直して ${fmt(session.position())} の位置から続けます)`);
    watchClock();
  }
}

/** 再開してから音声の時計が進まなければ、止まっている扱いに戻す(もう一度「再開」を押せば作り直す) */
function watchClock(): void {
  const s = session;
  if (!s) return;
  const ctx = s.ctx;
  const before = ctx.currentTime;
  setTimeout(() => {
    if (session !== s || paused || s.ctx !== ctx) return;
    if (ctx.currentTime - before < 0.5) {
      markPaused(true);
      extPaused = true;
      log('⚠ 再開したのに音声の時計が進みません。「再開」を押すと音声を作り直します');
    }
  }, 2500);
}

async function finish(reason: 'timer' | 'stopped'): Promise<void> {
  if (!session) return;
  const s = session;
  updateRecord();
  session = null;
  if (rec) {
    rec.ended = reason;
    rec.endedWall = Date.now();
    saveSession(rec);
    const ext = extSummary(rec).replace('\n', '・');
    log(
      reason === 'timer'
        ? `■ タイマーで終了(予約した終了時刻まで音声の時計が進みました)・ロック中のずれ 最大 ${rec.maxLagSec.toFixed(1)}秒${ext}`
        : `■ 停止ボタンで終了・ロック中のずれ 最大 ${rec.maxLagSec.toFixed(1)}秒${ext}`,
    );
  }
  if (reason === 'stopped') await s.stop();
  else await s.close();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  showBanner(rec);
  show('home');
}

async function stop(): Promise<void> {
  await finish('stopped');
}

startBtn.addEventListener('click', start);
pauseBtn.addEventListener('click', () => void togglePause());
$('stop').addEventListener('click', () => void stop());

// 1秒ごとの見回り。ロック中に JavaScript が止まると、この処理も止まる
setInterval(() => {
  if (!session) return;
  const now = Date.now();
  const gap = (now - lastTick) / 1000;
  lastTick = now;
  if (gap > 5) log(`JavaScript が約${Math.round(gap)}秒止まっていました(音声の状態 ${session.state}・ずれ ${measureLag().toFixed(1)}秒)`);
  if (session.isFinished()) {
    void finish('timer');
    return;
  }
  $('remain').textContent = fmt(session.remaining());
  if (now - (rec?.lastBeatWall ?? 0) > 5000 || gap > 5) updateRecord();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (!session) return;
  if (document.hidden) {
    log(`画面が隠れました(ロック等)・音声の状態 ${session.state}・残り ${fmt(session.remaining())}`);
    updateRecord();
  } else {
    const lag = measureLag();
    updateRecord();
    log(`画面に戻りました・音声の状態 ${session.state}・残り ${fmt(session.remaining())}・ずれ ${lag.toFixed(1)}秒`);
    $('playinfo').textContent = `ロック中のずれ: ${lag.toFixed(1)}秒`;
    wake();
  }
});

// ---------- 起動時 ----------

const previous = loadSession();
if (previous && !previous.ended) log('⚠ 前回の試験は終了処理の前にページが閉じられていました');
showBanner(previous);
log(`アプリを開きました・audioSession ${requestPlaybackSession()}`);

loadLibrary((done, total) => {
  $('prep').textContent = `音声を準備中 ${done}/${total}`;
})
  .then((l) => {
    lib = l;
    $('credit').textContent = l.credit;
    $('prep').textContent = `${l.words.length}語を準備しました${l.placeholder ? '(声は仮の音)' : ''}`;
    startBtn.disabled = false;
    startBtn.textContent = '開始';
  })
  .catch((e) => {
    $('prep').textContent = `準備に失敗しました: ${String(e)}`;
    log(`⚠ 準備に失敗: ${String(e)}`);
  });
