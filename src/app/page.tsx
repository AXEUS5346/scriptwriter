'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileTextIcon, PlusIcon, Mic2Icon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { LogoTile } from '@/components/logo';
import { cn } from 'cn';

type Summary = { id: string; title: string; updatedAt: string; lineCount: number };
type CtxMenu = { id: string; title: string; x: number; y: number; confirm: boolean } | null;

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
  const [ctx, setCtx] = useState<CtxMenu>(null);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/scripts', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ scripts: Summary[] }>)
      .then((j) => { if (alive) setScripts(j.scripts ?? []); })
      .catch(() => { if (alive) setScripts([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-ctx-menu]')) return;
      setCtx(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [ctx]);

  const openCtx = (e: React.MouseEvent, s: Summary) => {
    e.preventDefault();
    setCtx({ id: s.id, title: s.title, x: e.clientX, y: e.clientY, confirm: false });
  };

  const deleteScript = async (id: string) => {
    setDeleting(true);
    setDelError(null);
    try {
      const r = await fetch(`/api/scripts/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(String(r.status));
      setScripts((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
      setCtx(null);
    } catch (err) {
      setDelError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

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
        <div className="flex items-center gap-3">
          <LogoTile size={36} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Scriptwriter</h1>
            <p className="mt-1 text-sm text-muted-foreground">Multi-speaker dialogue, voiced line by line.</p>
          </div>
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
            onContextMenu={(e) => openCtx(e, s)}
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

      {ctx && (
        <div
          data-ctx-menu
          className="fixed z-50 min-w-[11rem] overflow-hidden rounded-lg border border-white/10 bg-[#131316] shadow-xl shadow-black/50"
          style={{
            left: Math.min(ctx.x, (typeof window !== 'undefined' ? window.innerWidth : 0) - 190),
            top: Math.min(ctx.y, (typeof window !== 'undefined' ? window.innerHeight : 0) - 110),
          }}
        >
          {!ctx.confirm ? (
            <button
              type="button"
              onClick={() => setCtx({ ...ctx, confirm: true })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground transition hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2Icon size={13} /> Delete
            </button>
          ) : (
            <div className="p-2.5">
              <p className="mb-2 line-clamp-2 text-[12px] leading-snug text-foreground/90">
                Delete “{ctx.title}”? Audio goes with it.
              </p>
              {delError && <p className="mb-2 text-[11px] text-red-400">{delError}</p>}
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => deleteScript(ctx.id)}
                  className="h-6 flex-1 gap-1 px-2 text-[11px]"
                >
                  {deleting ? 'Deleting…' : <><Trash2Icon size={11} /> Delete</>}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => setCtx(null)}
                  className="h-6 flex-1 px-2 text-[11px]"
                >
                  Keep
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
