// 制約つきシャッフル(設計書 6章「シャッフル規則」)
// 連想がつながらないよう、同じカテゴリ・同じ頭の音・しりとりになる語を後回しにする。

export interface Word {
  id: string;
  text: string;
  yomi: string; // ひらがなの読み
  cat: string;
}

const SMALL_TO_BIG: Record<string, string> = {
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ', っ: 'つ',
};

export function headSound(yomi: string): string {
  return yomi.charAt(0);
}

export function tailSound(yomi: string): string {
  const s = yomi.replace(/ー+$/, '');
  const c = s.charAt(s.length - 1);
  return SMALL_TO_BIG[c] ?? c;
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Rule = (w: Word, recent: Word[]) => boolean;

// 上から順に厳しい条件。満たす語がなければ一段ゆるめる
const RULE_LEVELS: Rule[][] = [
  [
    (w, r) => !r.slice(-2).some((p) => p.cat === w.cat),
    (w, r) => !r.length || headSound(w.yomi) !== headSound(r[r.length - 1].yomi),
    (w, r) => !r.length || headSound(w.yomi) !== tailSound(r[r.length - 1].yomi),
  ],
  [
    (w, r) => !r.length || r[r.length - 1].cat !== w.cat,
    (w, r) => !r.length || headSound(w.yomi) !== tailSound(r[r.length - 1].yomi),
  ],
  [(w, r) => !r.length || r[r.length - 1].id !== w.id],
  [],
];

export class Shuffler {
  private deck: Word[] = [];
  private recent: Word[] = [];

  constructor(
    private readonly words: Word[],
    private readonly rand: () => number = Math.random,
  ) {
    if (!words.length) throw new Error('単語がありません');
  }

  next(): Word {
    if (!this.deck.length) this.deck = shuffled(this.words, this.rand);
    for (const rules of RULE_LEVELS) {
      const i = this.deck.findIndex((w) => rules.every((ok) => ok(w, this.recent)));
      if (i >= 0) {
        const [w] = this.deck.splice(i, 1);
        this.recent.push(w);
        if (this.recent.length > 2) this.recent.shift();
        return w;
      }
    }
    throw new Error('unreachable');
  }
}
