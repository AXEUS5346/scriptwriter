// Prompt chunker for the TTS engine.
//
// This follows the reference engine's documented long-text behavior (Maya2
// engine docs): "Long text is split at sentence boundaries into pieces of
// about 20 s. The pieces are streamed back-to-back with 150 ms gaps."
// Concretely:
//   - a piece targets CHUNK_SECONDS of audio (~50 words at 2.5 words/s);
//   - cuts land ONLY on sentence marks, never mid-sentence (a slightly longer
//     piece always beats a mid-phrase cut);
//   - the caller merges the piece WAVs with GAP_MS of silence between them
//     (gap_s = 0.15 in the reference), so pieces play as natural sentences;
//   - emotion tags pass through inline in the text (docs: "tags such as
//     `[laughs]`, `[sighs]` and `[whispers]` are passed through").
//
// Additionally, following the script-writing spec the user chose ("a tag
// shapes the words after it, to the end of that line"), the tag that is
// "active" where a piece starts is carried onto that piece when it doesn't
// start with its own tag - otherwise a mid-line tag would color only the
// first piece of a multi-piece line. A piece never carries more than two
// tags (reliability finding from podcaster testing).
//
// Chunks of one line are merged byte-exact by the caller, so the player
// always receives ONE clip per line no matter how many pieces took to render.

export const CHUNK_SECONDS = 20; // reference engine chunk_s default
export const WORDS_PER_SECOND = 2.5; // ~150 words per minute of speech
export const GAP_MS = 150; // reference engine gap_s default (silence between pieces)
export const MAX_PROMPT_TAGS = 2; // reliability finding: no more than 2 tags per prompt

const PIECE_BUDGET_WORDS = Math.round(CHUNK_SECONDS * WORDS_PER_SECOND); // 50

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
 * word-run and every cut point is reviewed so no tag is orphaned.
 */
function splitOverlongSentence(s: Tok[], leadTag: string | null): Tok[][] {
  const parts: Tok[][] = [];
  const fresh = (): { cur: Tok[]; w: number; t: number } =>
    leadTag ? { cur: [tok(leadTag, true)], w: 0, t: 1 } : { cur: [], w: 0, t: 0 };
  let { cur, w: curW, t: curT } = fresh();

  const close = () => {
    if (cur.length > (leadTag ? 1 : 0)) parts.push(cur);
    ({ cur, w: curW, t: curT } = fresh());
  };

  let lastMark = -1; // strongest cut candidate inside the current chunk
  for (let i = 0; i < s.length; i++) {
    const t = s[i];

    if (t.isTag) {
      if (curT >= MAX_PROMPT_TAGS) close(); // a third emotion starts a fresh chunk
      cur.push(t);
      curT++;
      continue;
    }

    if (isMark(t)) lastMark = cur.length; // token stays; cut can happen after it

    if (curW + 1 > PIECE_BUDGET_WORDS * 2) {
      // far over budget: take the best mark hole we have, else hard-cut here
      if (lastMark >= 0 && lastMark < cur.length - 1) {
        const tail = cur.slice(lastMark + 1);
        parts.push(cur.slice(0, lastMark + 1));
        const n = countToks(tail);
        cur = leadTag ? [tok(leadTag, true), ...tail] : tail;
        curW = n.words;
        curT = n.tags + (leadTag ? 1 : 0);
      } else {
        close();
      }
    }

    cur.push(t);
    curW++;
  }
  close();

  return parts;
}

/**
 * Split a line's (already scrubbed) text into TTS prompts that each respect
 * the ~20 s piece budget and the two-tag ceiling, cutting only at sentence
 * marks. Lines within the budget pass through as ONE prompt regardless of
 * internal punctuation - periods never split a short line (docs: pieces are
 * only for LONG text).
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

  const raw: Tok[][] = []; // pieces BEFORE tag-carry normalization
  let cur: Tok[] | null = null;
  let curW = 0;
  let curT = 0;

  const closeCur = () => {
    if (cur && cur.length) raw.push(cur);
    cur = null;
    curW = 0;
    curT = 0;
  };

  for (const stoks of sents) {
    const n = countToks(stoks);
    if (
      cur !== null &&
      curW + n.words <= PIECE_BUDGET_WORDS &&
      curT + n.tags <= MAX_PROMPT_TAGS
    ) {
      // fits into the current piece: whole sentences never get punctured
      for (const t of stoks) {
        cur.push(t);
        if (t.isTag) curT++;
        else curW++;
      }
      continue;
    }
    closeCur();
    if (n.words <= PIECE_BUDGET_WORDS && n.tags <= MAX_PROMPT_TAGS) {
      cur = [...stoks];
      curW = n.words;
      curT = n.tags;
    } else {
      // one sentence alone exceeds a limit - split it, last piece stays open
      // so the next sentence can still merge into it if the budget allows
      const sLead = stoks[0]?.isTag ? stoks[0].text : leadTag;
      const sBody = sLead && stoks[0]?.isTag ? stoks.slice(1) : stoks;
      const pieces = splitOverlongSentence(sBody, sLead);
      for (let p = 0; p < pieces.length - 1; p++) raw.push(pieces[p]);
      cur = [...pieces[pieces.length - 1]];
      const nLast = countToks(cur);
      curW = nLast.words;
      curT = nLast.tags;
    }
  }
  closeCur();

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
