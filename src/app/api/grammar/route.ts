import { fixGrammar } from '@/lib/grammar';

export async function POST(req: Request) {
  let text = '';
  try {
    text = String(((await req.json()) as { text?: string }).text ?? '');
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  // only raw spoken words are allowed past this point
  const spoken = text.replace(/\[[a-z]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!spoken) return Response.json({ error: 'Nothing to fix — the selection has no spoken words' }, { status: 400 });

  // Keep the send modest: worst case a 100-word line is a few hundred tokens.
  const r = await fixGrammar(spoken.slice(0, 4000));
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json({ text: r.text });
}
