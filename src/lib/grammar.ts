// Grammar fix / writing improvement through the LLM provider. Server-only: the
// API key never leaves the server process (checked into .env.local, gitignored).

export type RewriteMode = 'grammar' | 'improve';
export type GrammarResult = { ok: true; text: string } | { ok: false; error: string };

const GRAMMAR_PROMPT = `You fix grammar, spelling and punctuation in single lines of dialogue that will be voiced by a text-to-speech engine.

Rules:
- Correct ONLY grammar, spelling and punctuation.
- Preserve the author's meaning, wording, word order and style. Do not rewrite, improve or shorten phrasing.
- The input is plain spoken prose with no markup. Never add tags, brackets, stage directions, emojis, markdown or conventions of any kind.
- Keep proper nouns, numbers, interjections and the capitalization of names untouched.
- Output ONLY the corrected line. No quotes, no explanations, no markdown.`;

const IMPROVE_PROMPT = `You improve the writing of single lines of spoken dialogue that will be voiced by a text-to-speech engine.

Rules:
- Keep the author's meaning, facts, names and numbers exactly.
- Keep the casual spoken register: contractions, plain words, natural rhythm. Never formalize or lecture.
- Tighten clunky phrasing, fix run-ons, strengthen weak verbs, smooth the flow.
- Stay close to the original length (within a few words). It must still feel like the same person talking.
- The input is plain spoken prose with no markup. Never add tags, brackets, stage directions, emojis, markdown or conventions of any kind.
- Output ONLY the improved line. No quotes, no explanations, no markdown.`;

const PROMPTS: Record<RewriteMode, string> = {
  grammar: GRAMMAR_PROMPT,
  improve: IMPROVE_PROMPT,
};

/** Only raw spoken words ever reach the model: any [tag] markup is removed
 *  before the request, and the caller (route) already strips too. */
function stripMarkup(text: string): string {
  return text.replace(/\[[a-z]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripFences(s: string): string {
  const t = s.trim();
  const fenced = t.match(/^```(?:[a-z]*)\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : t).trim();
}

export async function rewriteText(text: string, mode: RewriteMode): Promise<GrammarResult> {
  const spoken = stripMarkup(text);
  if (!spoken) return { ok: false, error: 'Nothing speakable to fix after removing markup' };
  const key = process.env.LLM_API_KEY;
  if (!key) return { ok: false, error: 'LLM_API_KEY is not configured on the server' };
  const baseURL = process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1';
  const model = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b';

  let res: Response;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: mode === 'improve' ? 0.6 : 0.2,
        max_completion_tokens: 2048,
        messages: [
          { role: 'system', content: PROMPTS[mode] },
          { role: 'user', content: spoken },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { ok: false, error: `LLM request failed: ${String(e)}` };
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message.slice(0, 300);
    } catch { /* keep status code */ }
    return { ok: false, error: `LLM provider error (${detail})` };
  }

  try {
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = stripFences(j.choices?.[0]?.message?.content ?? '');
    if (!out) return { ok: false, error: 'LLM returned an empty correction' };
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: `Could not parse LLM response: ${String(e)}` };
  }
}
