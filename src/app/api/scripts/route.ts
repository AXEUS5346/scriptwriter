import { headers } from 'next/headers';
import { listScripts, createScript } from '@/lib/script-store';

export async function GET() {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  return Response.json({ scripts: listScripts() });
}

export async function POST(req: Request) {
  let title: string | undefined;
  try {
    const body = (await req.json()) as { title?: string };
    title = body?.title;
  } catch { /* empty body is fine */ }
  const s = createScript(title);
  return Response.json({ id: s.id, script: s }, { status: 201 });
}
