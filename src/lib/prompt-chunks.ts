// Prompt chunker for the TTS engine.
//
// Per the chunking contract (user-locked):
//   - EVERY sentence is its own TTS prompt - sentences are NEVER merged into
//     one bigger prompt. Delivery and emotion stay uniform no matter how long
//     the line is, because each sentence calls the engine on its own.
//   - Only a sentence that ALONE exceeds the piece budget (~48 s / ~120 words)
//     is chunked further: cuts land on the strongest available mark (clause
//     marks first), never mid-word. Numbers follow the engine docs (Maya2
//     model card + ROCmFPX tools/tts/README.md): 2048 KV tokens per seat, one
//     12.5 Hz frame per 80 ms, and the engine itself re-chunks any text over
//     its reference MAX_TOKEN_PER_CHUNK of 50 tokens at sentence/comma marks.
//   - The caller merges the piece WAVs back into ONE clip with GAP_MS of
//     silence between pieces (gap_s = 0.15 in the reference), so a line still
//     plays as a single continuous take in the player.
//   - Emotion tags pass through inline (docs: "tags such as `[laughs]`,
//     `[sighs]` and `[whispers]` are passed through"); per the script spec
//     ("a tag shapes the words after it, to the end of that line"), the tag
//     that is "active" where a prompt starts is carried onto that prompt when
//     it doesn't start with its own tag - otherwise a mid-line tag would
//     color only the first sentence of the line.
//   - A prompt never carries more than two tags (reliability finding from
//     podcaster testing).
//
// Prompts of one line are merged byte-exact by the caller, so the player
// always receives ONE clip per line no matter how many prompts it took.

export const CHUNK_SECONDS = 48; // per-prompt audio envelope (engine KV: 2048 tokens/seat at 12.5 Hz)
export const WORDS_PER_SECOND = 2.5; // ~150 words per minute of speech
export const GAP_MS = 150; // reference engine gap_s default (silence between pieces)
export const MAX_PROMPT_TAGS = 2; // reliability finding: no more than 2 tags per prompt

const PIECE_BUDGET_WORDS = Math.round(CHUNK_SECONDS * WORDS_PER_SECOND); // 120
// A completely mark-free stretch may approach but not pass the engine's
// reference MAX_TOKEN_PER_CHUNK of 50 tokens (~38 English words): past that
// the engine has nothing to re-chunk at and warns "generation may skip words".
const MARKLESS_BUDGET_WORDS = 38;
// absolute ceiling for a piece (mark-based cuts target PIECE_BUDGET)
const HARD_BUDGET_WORDS = 150;

type Tok = { text: string; isTag: boolean };

function tok(text: string, isTag: boolean): Tok {
  return { text, isTag };
}

function tokenize(text: string): Tok[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => tok(w, /^\[[a-z]+]$/i.test(w)));
}

// a non-tag word ending in sentence punctuation (trailing closing quotes allowed)
const SENT_END = /(.|^)[.!?…]+["')\]]*$/;
const INNER_END = /[,;:—]+["')\]]*$/;

function isSentEnd(t: Tok): boolean {
  return !t.isTag && SENT_END.test(t.text);
}
function isInnerEnd(t: Tok): boolean {
  return !t.isTag && INNER_END.test(t.text);
}
function isMark(t: Tok): boolean {
  return isSentEnd(t) || isInnerEnd(t);
}

function countToks(toks: Tok[]): { words: number; tags: number } {
  return {
    words: toks.filter((t) => !t.isTag).length,
    tags: toks.filter((t) => t.isTag).length,
  };
}

function assemble(toks: Tok[]): string {
  return toks.map((t) => t.text).join(' ');
}

/**
 * Split ONE sentence that on its own exceeds the budget (rare: only sentences
 * far beyond ~50 words hit this). Cuts land on the strongest available mark,
 * preferring sentence marks, then clause marks; an emotion tag never goes mid
 * word-run and every cut point is reviewed so no tag is orphaned. Every
 * returned piece is closed - the caller never appends to them.
 */
function splitOverlongSentence(s: Tok[], leadTag: string | null): Tok[][] {
  const parts: Tok[][] = [];
  const fresh = (): { cur: Tok[]; w: number; t: number } =>
    leadTag ? { cur: [tok(leadTag, true)], w: 0, t: 1 } : { cur: [], w: 0, t: 0 };
  let { cur, w: curW, t: curT } = fresh();
  let lastMark = -1; // strongest cut candidate inside the current piece

  const close = () => {
    if (cur.length > (leadTag ? 1 : 0)) parts.push(cur);
    ({ cur, w: curW, t: curT } = fresh());
    lastMark = -1;
  };

  for (let i = 0; i < s.length; i++) {
    const t = s[i];

    if (t.isTag) {
      if (curT >= MAX_PROMPT_TAGS) close(); // a third emotion starts a fresh piece
      cur.push(t);
      curT++;
      continue;
    }

    if (isMark(t)) lastMark = cur.length; // token stays; cut can happen after it

    if (lastMark < 0 && curW + 1 > MARKLESS_BUDGET_WORDS) {
      // no mark anywhere in this piece and the engine's 50-token ceiling is
      // reached: hard-cut here (the only structure-free cut we allow)
      close();
    }
    if (curW + 1 > PIECE_BUDGET_WORDS && lastMark >= 0) {
      // past the piece budget with a pending mark: flush there so the piece
      // ends on natural punctuation
      if (lastMark === cur.length - 1) {
        close(); // the pending mark ends the piece exactly
      } else {
        const tail = cur.slice(lastMark + 1);
        parts.push(cur.slice(0, lastMark + 1));
        const n = countToks(tail);
        cur = leadTag ? [tok(leadTag, true), ...tail] : tail;
        curW = n.words;
        curT = n.tags + (leadTag ? 1 : 0);
      }
      lastMark = -1;
    }
    if (curW + 1 > HARD_BUDGET_WORDS) {
      // absolute ceiling: close even without a mark - the engine's per-seat
      // KV budget must never be at risk
      close();
    }

    cur.push(t);
    curW++;
  }
  close();

  return parts;
}

/**
 * Split a line's (already scrubbed) text into TTS prompts. CONTRACT: every
 * sentence becomes its own prompt - sentences are NEVER merged together - so
 * delivery can never leak across a sentence boundary and a failure stays
 * contained to one sentence. Only a sentence that alone exceeds the ~20 s
 * piece budget (~48 s / ~120 words) or the two-tag ceiling is subdivided
 * (splitOverlongSentence).
 * Returns [] for empty text.
 */
export function splitLinePrompts(text: string): string[] {
  let leadTag: string | null = null;
  let body = text;
  const lead = text.match(/^\s*\[([a-z]+)]\s*/i);
  if (lead) {
    leadTag = `[${lead[1].toLowerCase()}]`;
    body = text.slice(lead[0].length);
  }

  const toks = tokenize(body);
  if (toks.length === 0) return [];

  // sentence units (marks stay attached to the word they close)
  const sents: Tok[][] = [];
  let sent: Tok[] = [];
  for (const t of toks) {
    sent.push(t);
    if (isSentEnd(t)) {
      sents.push(sent);
      sent = [];
    }
  }
  if (sent.length) sents.push(sent);

  const raw: Tok[][] = []; // prompts BEFORE tag-carry normalization
  for (const stoks of sents) {
    // tags alone are not speakable (same policy as the no-speakable-text guard
    // in the generate route): a sentence unit with zero words - e.g. a
    // trailing "[sighs]" - is dropped rather than sent to the engine alone
    if (countToks(stoks).words === 0) continue;
    const n = countToks(stoks);
    // a sentence with NO interior marks can't be re-chunked by the engine
    // (nothing to split on -> "generation may skip words"), so its safe
    // budget is the 50-token reference ceiling, not the full piece budget
    const markless = !stoks.some((t, i) => i > 0 && i < stoks.length - 1 && isMark(t));
    const budget = markless ? MARKLESS_BUDGET_WORDS : PIECE_BUDGET_WORDS;
    if (n.words <= budget && n.tags <= MAX_PROMPT_TAGS) {
      raw.push([...stoks]); // the whole sentence, exactly as written
    } else {
      // this sentence alone exceeds a limit - split only it, every piece closed
      const sLead = stoks[0]?.isTag ? stoks[0].text : leadTag;
      const sBody = sLead && stoks[0]?.isTag ? stoks.slice(1) : stoks;
      raw.push(...splitOverlongSentence(sBody, sLead));
    }
  }

  // Tag carry: per the script spec a tag shapes everything after it to the end
  // of the line, so a piece that starts tag-less inherits the last tag seen in
  // the line so far (budget permitting).
  const prompts: string[] = [];
  let activeTag: string | null = leadTag;
  for (const piece of raw) {
    let toks = piece;
    if (!toks[0]?.isTag && activeTag) {
      const n = countToks(toks);
      if (n.tags < MAX_PROMPT_TAGS) toks = [tok(activeTag, true), ...toks];
    }
    prompts.push(assemble(toks));
    const last = [...toks].reverse().find((t) => t.isTag);
    if (last) activeTag = last.text;
  }

  return prompts.filter((p) => p.trim());
}
