"""単語リスト(CSV)から、アプリ用の音声ファイルと目録(manifest.json)を作る。

使い方(VOICEVOX Engine が動いている PC で実行):
    python scripts/gen_audio.py --list-speakers
    python scripts/gen_audio.py --speaker 3 --credit "VOICEVOX:ずんだもん"

VOICEVOX がない PC で動作確認だけしたいとき(声の代わりに短い音を作る):
    python scripts/gen_audio.py --placeholder

声の聞き比べ用(公開しないフォルダに出す。npm run dev の /audition.html で聞ける):
    python scripts/gen_audio.py --speaker 36 --voice-id s36 --credit "VOICEVOX:四国めたん" --out audition

必要なもの: Python 3.10 以上(標準ライブラリのみ)、ffmpeg(PATH に通す)
手順は設計書 7章のとおり: チェック → 合成 → 整音 → AAC 変換 → 目録の出力。
"""

from __future__ import annotations

import argparse
import array
import csv
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "public" / "audio"

SAMPLE_RATE = 24000
TARGET_RMS_DB = -20.0  # 平均音量(RMS)をこの値に揃える
PEAK_LIMIT_DB = -1.0  # ただしピークはこれを超えないようにする
SILENCE_DB = -45.0  # その語のピークよりこれだけ小さい音を「無音」とみなして前後を削る
KEEP_MS = 20  # 無音を削るとき、声の前後に残す余白
FADE_MS = 10  # 両端のフェード(再生時の「プツッ」を防ぐ)


# ---------- 1. チェック ----------

def load_words() -> list[dict]:
    with open(DATA / "words.csv", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    with open(DATA / "categories.csv", encoding="utf-8-sig", newline="") as f:
        cats = {r["id"] for r in csv.DictReader(f)}
    ng = set()
    for line in (DATA / "ng_words.txt").read_text(encoding="utf-8").splitlines():
        word = line.split("#", 1)[0].strip()
        if word:
            ng.add(word)

    errors: list[str] = []
    seen_id: set[str] = set()
    seen_text: set[str] = set()
    for i, r in enumerate(rows, start=2):  # 1行目は見出し
        wid, text = (r.get("id") or "").strip(), (r.get("text") or "").strip()
        kana, cat = (r.get("kana") or "").strip(), (r.get("category") or "").strip()
        r.update(id=wid, text=text, kana=kana, category=cat)
        if not wid or not text or not cat:
            errors.append(f"{i}行目: id・text・category のどれかが空です")
        if wid in seen_id:
            errors.append(f"{i}行目: id {wid} が重複しています")
        if text in seen_text:
            errors.append(f"{i}行目: 「{text}」が重複しています")
        if cat and cat not in cats:
            errors.append(f"{i}行目: カテゴリ {cat} は categories.csv にありません")
        if text in ng or (kana and kana in ng):
            errors.append(f"{i}行目: 「{text}」は外す語の辞書(ng_words.txt)に入っています")
        seen_id.add(wid)
        seen_text.add(text)
    if errors:
        print("単語リストに問題があります:", *errors, sep="\n  ", file=sys.stderr)
        sys.exit(1)
    return rows


def load_categories() -> list[dict]:
    with open(DATA / "categories.csv", encoding="utf-8-sig", newline="") as f:
        return [{"id": r["id"], "label": r["label"]} for r in csv.DictReader(f)]


def to_hiragana(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


# ---------- 2. 合成 ----------

def list_speakers(engine: str) -> None:
    with urllib.request.urlopen(f"{engine}/speakers", timeout=10) as res:
        speakers = json.loads(res.read())
    for sp in speakers:
        styles = ", ".join(f"{st['name']}={st['id']}" for st in sp["styles"])
        print(f"{sp['name']}: {styles}")


def synth_voicevox(engine: str, speaker: int, word: dict, speed: float, intonation: float) -> bytes:
    # kana 列があれば読みを固定する。「'」入り(AquesTalk 記法)ならアクセントも固定する
    reading = word["kana"] or word["text"]
    q = urllib.parse.urlencode({"text": reading, "speaker": speaker})
    query = _post(f"{engine}/audio_query?{q}")
    if "'" in word["kana"]:
        q2 = urllib.parse.urlencode({"text": word["kana"], "speaker": speaker, "is_kana": "true"})
        query["accent_phrases"] = _post(f"{engine}/accent_phrases?{q2}")
    query.update(
        speedScale=speed,
        intonationScale=intonation,
        prePhonemeLength=0.1,
        postPhonemeLength=0.1,
        outputSamplingRate=SAMPLE_RATE,
        outputStereo=False,
    )
    req = urllib.request.Request(
        f"{engine}/synthesis?speaker={speaker}",
        data=json.dumps(query).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def _post(url: str) -> dict:
    req = urllib.request.Request(url, data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def read_wav(data: bytes) -> list[float]:
    import io

    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("16bit モノラルの WAV を想定しています")
        if w.getframerate() != SAMPLE_RATE:
            raise ValueError(f"サンプリング周波数が {w.getframerate()}Hz です({SAMPLE_RATE}Hz を想定)")
        pcm = array.array("h", w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        pcm.byteswap()
    return [s / 32768 for s in pcm]


def synth_placeholder(index: int) -> list[float]:
    """VOICEVOX がないとき用の仮の音。語ごとに高さの違う、やわらかい「ポーン」"""
    notes = [262, 294, 330, 349, 392, 440, 494, 523, 587, 659]
    f0 = notes[index % len(notes)] * (1 + index // len(notes) * 0.03)
    n = int(SAMPLE_RATE * 0.8)
    out = []
    for i in range(n):
        t = i / SAMPLE_RATE
        env = min(1.0, t / 0.03) * math.exp(-t * 4.5)
        out.append(env * (math.sin(2 * math.pi * f0 * t) + 0.25 * math.sin(4 * math.pi * f0 * t)))
    return [0.0] * int(SAMPLE_RATE * 0.1) + out + [0.0] * int(SAMPLE_RATE * 0.1)


# ---------- 3. 整音 ----------

def db_to_amp(db: float) -> float:
    return 10 ** (db / 20)


def tidy(samples: list[float]) -> list[float]:
    # 前後の無音を削る
    th = max(abs(x) for x in samples) * db_to_amp(SILENCE_DB)
    loud = [i for i, s in enumerate(samples) if abs(s) > th]
    if not loud:
        raise ValueError("音が入っていません")
    keep = int(SAMPLE_RATE * KEEP_MS / 1000)
    s = samples[max(0, loud[0] - keep): loud[-1] + keep + 1]
    # 両端に短いフェード
    fade = int(SAMPLE_RATE * FADE_MS / 1000)
    for i in range(min(fade, len(s))):
        g = i / fade
        s[i] *= g
        s[-1 - i] *= g
    # 平均音量(RMS)を揃える。ただしピークが上限を超えない範囲で
    rms = math.sqrt(sum(x * x for x in s) / len(s))
    peak = max(abs(x) for x in s)
    gain = min(db_to_amp(TARGET_RMS_DB) / rms, db_to_amp(PEAK_LIMIT_DB) / peak)
    return [x * gain for x in s]


def write_wav(path: Path, samples: list[float]) -> None:
    pcm = array.array("h", (max(-32768, min(32767, round(x * 32767))) for x in samples))
    if sys.byteorder == "big":
        pcm.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())


# ---------- 4. 変換 ----------

def encode_m4a(src: Path, dst: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-c:a", "aac", "-b:a", "40k", "-ac", "1", "-ar", str(SAMPLE_RATE),
         "-movflags", "+faststart", str(dst)],
        check=True,
    )


# ---------- 本体 ----------

def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")  # Windows でも日本語が化けないように
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--engine", default="http://127.0.0.1:50021", help="VOICEVOX Engine の URL")
    p.add_argument("--list-speakers", action="store_true", help="使える声(スタイル ID)の一覧を出して終わる")
    p.add_argument("--speaker", type=int, help="VOICEVOX のスタイル ID")
    p.add_argument("--credit", help="クレジット表記(例: VOICEVOX:ずんだもん)")
    p.add_argument("--voice-id", default="a", help="アプリ内での声の ID(出力フォルダ名)")
    p.add_argument("--speed", type=float, default=0.85, help="話速(既定 0.85)")
    p.add_argument("--intonation", type=float, default=0.8, help="抑揚(既定 0.8 = やや控えめ)")
    p.add_argument("--placeholder", action="store_true", help="VOICEVOX を使わず仮の音で作る(動作確認用)")
    p.add_argument("--out", default=str(OUT), help="出力先(既定 public/audio。聞き比べ用は audition/ など公開しない場所に)")
    args = p.parse_args()

    if args.list_speakers:
        list_speakers(args.engine)
        return
    if not args.placeholder and (args.speaker is None or not args.credit):
        p.error("--speaker と --credit を指定してください(動作確認だけなら --placeholder)")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg が見つかりません。インストールして PATH に通してください")

    words = load_words()
    out_root = Path(args.out).resolve()
    out_dir = out_root / args.voice_id
    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict] = {}

    with tempfile.TemporaryDirectory() as tmp:
        for i, w in enumerate(words):
            label = w["text"] + (f"({w['kana']})" if w["kana"] else "")
            print(f"[{i + 1}/{len(words)}] {w['id']} {label}")
            if args.placeholder:
                raw = synth_placeholder(i)
            else:
                raw = read_wav(synth_voicevox(args.engine, args.speaker, w, args.speed, args.intonation))
            samples = tidy(raw)
            wav = Path(tmp) / f"{w['id']}.wav"
            write_wav(wav, samples)
            dst = out_dir / f"{w['id']}.m4a"
            encode_m4a(wav, dst)
            files[w["id"]] = {
                "dur": round(len(samples) / SAMPLE_RATE, 3),
                "hash": hashlib.sha256(dst.read_bytes()).hexdigest()[:12],
            }

    # 目録に載っていない古いファイルは消す
    for old in out_dir.glob("*.m4a"):
        if old.stem not in files:
            old.unlink()

    manifest_path = out_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    voices = [v for v in manifest.get("voices", []) if v["id"] != args.voice_id]
    voices.append({
        "id": args.voice_id,
        "credit": "仮の音(VOICEVOX 未生成)" if args.placeholder else args.credit,
        "placeholder": args.placeholder,
        "speaker": args.speaker,
        "speed": None if args.placeholder else args.speed,
        "intonation": None if args.placeholder else args.intonation,
        "files": files,
    })
    voices.sort(key=lambda v: v["id"])
    manifest = {
        "version": 1,
        "sampleRate": SAMPLE_RATE,
        "voices": voices,
        "categories": load_categories(),
        "words": [
            {"id": w["id"], "text": w["text"], "yomi": to_hiragana(w["kana"] or w["text"]), "cat": w["category"]}
            for w in words
        ],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum((out_dir / f"{k}.m4a").stat().st_size for k in files)
    print(f"完了: {len(files)}語、合計 {total / 1024:.1f}KB → {out_dir}")


if __name__ == "__main__":
    main()
