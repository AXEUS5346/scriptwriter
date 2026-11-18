// Line text model shared by the client (chips rendering, hash) and server (hash,
// zip naming). A line's text is a plain string; emotion tags appear inline as
// [tag] and render as chips. The speaker is a separate field, never spoken.

export const EMOTION_TAGS = ['excited', 'sad', 'whispers', 'sighs', 'laughs'] as const;
export type EmotionTag = (typeof EMOTION_TAGS)[number];

const TAG_SPLIT_RE = /(\[(?:excited|sad|whispers|sighs|laughs)\])/gi;

/** Text with emotion tags stripped — the actually-spoken words. */
export function spokenText(text: string): string {
  return text.replace(TAG_SPLIT_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function spokenWords(text: string): string[] {
  return spokenText(text).split(/\s+/).filter(Boolean);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16) + '_' + s.length.toString(36);
}

/** What determines a clip's freshness: the speaker AND the exact text (tags included). */
export function lineHash(speaker: string | null, text: string): string {
  return djb2(`${speaker ?? ''}\u0000${text}`);
}

/** Windows-illegal filename characters (and control chars) removed. */
export function sanitizeFileName(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\s.]+$/g, '') // no trailing dots/spaces on Windows
    .trim();
}

/** Zip member name: "4 - Ahana - Hey! AXEUS, glad to..." */
export function zipNameForLine(position: number, speaker: string, text: string): string {
  const w = spokenWords(text);
  const head = w.slice(0, 4).join(' ');
  const ellipsis = w.length > 4 ? '...' : '';
  // sanitize the whole name, then append the ellipsis (sanitizing strips
  // trailing dots by Windows rules, which would eat it)
  return sanitizeFileName(`${position} - ${speaker} - ${head}`) + ellipsis + '.wav';
}

// ---- number-to-speech expansion (TTS boundary only) --------------------------
// The Maya2 model card is explicit: long digit sequences are unreliable "even
// with normalization" - the reference engine normalizes written forms before
// synthesis, but our daemon path feeds raw text. So digits are expanded to
// spoken words right before chunking. RENDER-TIME ONLY: editor text and the
// line hash always stay exactly as the user wrote them.

const NUM_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const NUM_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function intToWords(n: number): string {
  if (n < 20) return NUM_ONES[n];
  if (n < 100) {
    const t = NUM_TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r ? `${t}-${NUM_ONES[r]}` : t;
  }
  if (n < 1000) {
    const h = `${NUM_ONES[Math.floor(n / 100)]} hundred`;
    const r = n % 100;
    return r ? `${h} ${intToWords(r)}` : h;
  }
  const scales: Array<[number, string]> = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  for (const [scale, name] of scales) {
    if (n >= scale) {
      const hi = intToWords(Math.floor(n / scale));
      const lo = n % scale;
      if (lo === 0) return `${hi} ${name}`;
      const joiner = lo < 100 ? ' and' : ''; // "one thousand and five" reads naturally
      return `${hi} ${name}${joiner} ${intToWords(lo)}`;
    }
  }
  return String(n);
}

function digitsToWords(s: string): string {
  return s
    .replace(/,/g, '')
    .split('.')
    .filter((p) => p.length > 0)
    .map((p, i) => {
      if (i === 0) return intToWords(parseInt(p, 10) || 0);
      return p.split('').map((d) => NUM_ONES[Number(d)] ?? d).join(' ');
    })
    .join(' point ');
}

/** Render-time number expansion: "11 PM", "4,800", "3.14", "50%", "$5.99" -> words. */
export function expandNumbersForTts(text: string): string {
  return text
    .replace(/(?<![\w.])\d{1,2}:\d{2}(?![\w.])/g, (m) => {
      // clock time "11:30" -> "eleven thirty" (leave any am/pm suffix as-is)
      const [h, mi] = m.split(':');
      return `${NUM_ONES[+h % 24]} ${intToWords(+mi)}`;
    })
    .replace(/(?<!\w)\$(\d[\d,]*(?:\.\d+)?)/g, (m, v: string) => {
      const [int, frac] = v.split('.');
      let out = `${intToWords(parseInt(int.replace(/,/g, '') || '0', 10))} dollar${int === '1' ? '' : 's'}`;
      if (frac) out += ` ${digitsToWords(frac)} cents`;
      return out;
    })
    .replace(/(?<!\w)(\d[\d,]*(?:\.\d+)?)\s?%/g, (m, v: string) => `${digitsToWords(v)} percent`)
    .replace(/(?<![\w])\d[\d,]*(?:\.\d+)?(?![\w])/g, (m) => digitsToWords(m))
    .replace(/\s{2,}/g, ' ');
}
