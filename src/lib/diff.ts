// Minimal word-level diff (LCS) for showing add/remove highlights after an
// AI rewrite. Selections are short (<= ~200 words), so the DP table is cheap.

export type DiffPart = { type: 'same' | 'add' | 'del'; text: string };

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
      else dp[i * w + j] = Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  return dp;
}

export function wordDiff(prev: string, next: string): DiffPart[] {
  const a = tokenize(prev);
  const b = tokenize(next);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ type: 'add', text: next.trim() }];
  if (b.length === 0) return [{ type: 'del', text: prev.trim() }];

  const w = b.length + 1;
  const dp = lcsTable(a, b);
  const parts: DiffPart[] = [];

  const push = (type: DiffPart['type'], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };

  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', b[j]);
      i++; j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      push('del', a[i]);
      i++;
    } else {
      push('add', b[j]);
      j++;
    }
  }
  while (i < a.length) { push('del', a[i]); i++; }
  while (j < b.length) { push('add', b[j]); j++; }
  return parts;
}

/** True when the two texts are equivalent after collapsing whitespace. */
export function diffIsNoop(prev: string, next: string): boolean {
  return prev.replace(/\s+/g, ' ').trim() === next.replace(/\s+/g, ' ').trim();
}
