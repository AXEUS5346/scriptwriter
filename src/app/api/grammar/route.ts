import { rewriteText, type RewriteMode } from '@/lib/grammar';

export async function POST(req: Request) {
  let body: { text?: unknown; mode?: unknown } = {};
  try {
    body = (await req.json()) as { text?: unknown; mode?: unknown };
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  const text = String(body.text ?? '');
  const mode: RewriteMode = body.mode === 'improve' ? 'improve' : 'grammar';

  // only raw spoken words are allowed past this point
  const spoken = text.replace(/\[[a-z]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!spoken) return Response.json({ error: 'Nothing to fix — the selection has no spoken words' }, { status: 400 });

  // Keep the send modest: worst case a 100-word line is a few hundred tokens.
  const r = await rewriteText(spoken.slice(0, 4000), mode);
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json({ text: r.text, mode });
}
