# ねむシャッフル(試作)

画面を消したスマホで、脈絡のない単語をランダムに読み上げ続け、環境音と一緒に寝つきを助けるブラウザアプリ。
設計は [docs/design.md](docs/design.md) を参照。

## いまの段階: フェーズ0(技術検証)

単語10語+ブラウンノイズだけの試作。iPhone 実機で「画面ロック・消音スイッチ ON のまま30分鳴り続け、予約したフェードで止まるか」を確かめる。

試作に入っているもの:

- 開始時に終了までの全単語・環境音・フェードを Web Audio にまとめて予約する再生エンジン(`src/engine.ts`)
- `navigator.audioSession.type = "playback"`(対応端末のみ)、24kHz の AudioContext
- 制約つきシャッフル(同じカテゴリ・同じ頭の音・しりとりを避ける)(`src/shuffle.ts`)
- ブラウンノイズの合成(60秒・継ぎ目なしループ)(`src/noise.ts`)
- ロック画面の操作ボタン(Media Session)の設定
- 試験の記録(`src/diag.ts`): ロック中に音声処理が止まっていたかを「ずれ」として記録し、コピーできる
- 確認用の切り替え: 環境音「なし」「ごく小さいノイズ」、出力方式「audio要素経由(予備)」

## 音声ファイルを作る

VOICEVOX Engine が動いている PC(ノートPC)で実行する。Python 3.10 以上と ffmpeg が必要。

```bash
python scripts/gen_audio.py --list-speakers
python scripts/gen_audio.py --speaker <スタイルID> --credit "VOICEVOX:<キャラクター名>"
```

声を選ぶときは、候補を公開しないフォルダ `audition/` に作り、`npm run dev` で開いた `/audition.html` で聞き比べる。

```bash
python scripts/gen_audio.py --speaker 36 --voice-id s36 --credit "VOICEVOX:四国めたん(ささやき)" --out audition
```

VOICEVOX なしで動作確認だけしたいときは `--placeholder`(声の代わりに短い音を作る)。いま `public/audio/` に入っているのはこの仮の音。

単語は `data/words.csv`、カテゴリは `data/categories.csv`、外す語の辞書は `data/ng_words.txt` を編集する。

## 開発

```bash
npm install
npm run dev
```

`npm run dev` は LAN にも公開するので、同じ Wi-Fi のスマホから `http://<PCのIP>:5173` で画面は開ける。ただしロック中の再生の検証は HTTPS で行う(設計書 11章)。

## 公開(GitHub Pages)

GitHub に push すると `.github/workflows/deploy.yml` が `dist/` を GitHub Pages に公開する。初回だけ、リポジトリの Settings → Pages → Source を「GitHub Actions」にする。
