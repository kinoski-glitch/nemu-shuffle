// フェーズ0の試験記録。端末内(localStorage)に保存し、朝に見返したりコピーしたりできる。
// ロック中は JavaScript が止まるため、戻ってきた時に「壁の時計」と「音声の時計」の進み方を比べ、
// ロック中も音声処理が動いていたかを判定する。

const LOG_KEY = 'nemu.v0.log';
const SESSION_KEY = 'nemu.v0.session';
const MAX_ENTRIES = 600;

export interface LogEntry {
  at: string; // 端末の時刻(ISO)
  msg: string;
}

export interface SessionRecord {
  id: string;
  startedWall: number; // Date.now()
  t0: number; // 予約の起点(音声の時計)
  tEnd: number; // 予定の終了時刻(音声の時計)
  durationSec: number;
  pausedMs: number; // 一時停止していた合計
  lastBeatWall: number; // JavaScript が最後に動いた時刻
  lastBeatCtx: number;
  maxLagSec: number; // 観測した最大のずれ(音声の時計の遅れ)
  hiddenSince?: number;
  ended?: 'timer' | 'stopped' | 'error';
  endedWall?: number;
  settings: string;
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても再生は続ける */
  }
}

let entries: LogEntry[] = readJSON<LogEntry[]>(LOG_KEY, []);
const listeners = new Set<() => void>();

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function localTime(d = new Date()): string {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(msg: string): void {
  entries.push({ at: new Date().toISOString(), msg });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  writeJSON(LOG_KEY, entries);
  listeners.forEach((f) => f());
}

export function getLog(): LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries = [];
  writeJSON(LOG_KEY, entries);
  listeners.forEach((f) => f());
}

export function onLog(f: () => void): void {
  listeners.add(f);
}

export function logText(): string {
  return entries.map((e) => `${localTime(new Date(e.at))}  ${e.msg}`).join('\n');
}

export function loadSession(): SessionRecord | null {
  return readJSON<SessionRecord | null>(SESSION_KEY, null);
}

export function saveSession(s: SessionRecord | null): void {
  if (s) writeJSON(SESSION_KEY, s);
  else {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* noop */
    }
  }
}

export function environmentSummary(): string[] {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  const lines = [
    `UA: ${navigator.userAgent}`,
    `ホーム画面から起動: ${matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone ? 'はい' : 'いいえ'}`,
    `HTTPS: ${location.protocol === 'https:' ? 'はい' : 'いいえ'}(${location.host})`,
    `audioSession 対応: ${nav.audioSession ? `あり(現在 ${nav.audioSession.type})` : 'なし'}`,
    `mediaSession 対応: ${'mediaSession' in navigator ? 'あり' : 'なし'}`,
  ];
  const ios = navigator.userAgent.match(/OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/);
  if (ios) lines.splice(1, 0, `iOS: ${ios[1]}.${ios[2]}${ios[3] ? '.' + ios[3] : ''}`);
  return lines;
}
