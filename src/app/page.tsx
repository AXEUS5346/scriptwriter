'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileTextIcon, PlusIcon, Mic2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { cn } from 'cn';

type Summary = { id: string; title: string; updatedAt: string; lineCount: number };

function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const mins = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function Home() {
  const router = useRouter();
  const [scripts, setScripts] = useState<Summary[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/scripts', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ scripts: Summary[] }>)
      .then((j) => { if (alive) setScripts(j.scripts ?? []); })
      .catch(() => { if (alive) setScripts([]); });
    return () => { alive = false; };
  }, []);

  const newScript = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const r = await fetch('/api/scripts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = (await r.json()) as { id?: string };
      if (j.id) router.push(`/editor/${j.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Scripts</h1>
          <p className="mt-1 text-sm text-muted-foreground">Multi-speaker dialogue, voiced line by line.</p>
        </div>
        <Button onClick={newScript} size="sm" className="gap-1.5">
          <PlusIcon size={14} /> New script
        </Button>
      </header>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        <button
          type="button"
          onClick={newScript}
          disabled={creating}
          className={cn(
            'flex h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 bg-card/40 text-muted-foreground transition hover:border-border hover:bg-card/70 hover:text-foreground',
            creating && 'opacity-60',
          )}
        >
          <span className="flex size-9 items-center justify-center rounded-full border border-border/70">
            <PlusIcon size={16} />
          </span>
          <span className="text-sm font-medium">New script</span>
        </button>

        {scripts?.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => router.push(`/editor/${s.id}`)}
            className="group flex h-36 flex-col rounded-2xl border border-border/60 bg-card/40 p-4 text-left transition hover:border-border hover:bg-card/70"
          >
            <FileTextIcon size={16} className="mb-2 text-muted-foreground" />
            <span className="line-clamp-2 text-sm font-medium leading-snug">{s.title}</span>
            <span className="mt-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Mic2Icon size={11} /> {s.lineCount} {s.lineCount === 1 ? 'line' : 'lines'}
              <span className="mx-0.5">·</span> last edited {relTime(s.updatedAt)}
            </span>
          </button>
        ))}
      </div>

      {scripts != null && scripts.length === 0 && (
        <Empty className="mt-10 bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
            <EmptyTitle>No scripts yet</EmptyTitle>
            <EmptyDescription>
              Create your first script — type the dialogue, tag emotions inline,
              and voice each line with one click.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </main>
  );
}
