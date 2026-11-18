'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeftIcon,
  DownloadIcon,
  Loader2Icon,
  Volume2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LogoTile } from '@/components/logo';
import { FixPopup, DiffPopup } from '@/components/editor/fix-popup';
import type { RewriteMode } from '@/lib/grammar';
import { diffIsNoop } from '@/lib/diff';
import {
  AudioPlayerProvider,
  useAudioPlayer,
} from '@/components/ui/audio-player';
import { SlashMenu, defaultMenu, menuItems, type SlashMenuState } from '@/components/editor/slash-menu';
import { LineRow } from '@/components/editor/line-row';
import { PlayerBar } from '@/components/editor/player-bar';
import { NotificationCenter, type NotificationItem } from '@/components/arc/notification-center/notification-center';
import { statusOf, type ClientLine, type ClientScript } from '@/components/editor/types';
import { lineHash, spokenText } from '@/lib/line-text';
import { assignSpeakerColors, SPEAKER_PALETTE, type SpeakerColor } from '@/lib/speaker-color';
import { caretRect, getCaretTextIndex, getSelectionTextRange } from '@/lib/caret';
import { cn } from 'cn';

type Preflight = { state: 'loading' | 'ready' | 'failed'; reason?: string };
type FixBar = { lineId: string; top: number; bottom: number; left: number; start: number; end: number } | null;
type FixResultPopup = {
  lineId: string;
  start: number;
  rect: { top: number; bottom: number; left: number };
  prevFull: string; // whole line text before the rewrite (for revert)
  prev: string;     // spoken words before (tags stripped) — diff side
  next: string;     // spoken words after (tags stripped) — diff side
  mode: RewriteMode;
} | null;

// outer shell: the ElevenLabs AudioPlayerProvider owns the single <audio> element
export default function EditorClient() {
  const params = useParams<{ id: string }>();
  return (
    <AudioPlayerProvider>
      <EditorLoaded scriptId={params.id!} />
    </AudioPlayerProvider>
  );
}

function EditorLoaded({ scriptId }: { scriptId: string }) {
  const router = useRouter();
  const player = useAudioPlayer<ClientLine | null>();

  const [script, setScript] = useState<ClientScript | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<ClientLine[]>([]);
  const [preflight, setPreflight] = useState<Preflight>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [genSet, setGenSet] = useState<Record<string, boolean>>({});
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [notifs, setNotifs] = useState<NotificationItem[]>([]);  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const [fix, setFix] = useState<FixBar>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixBusyMode, setFixBusyMode] = useState<RewriteMode>('grammar');
  const [fixResult, setFixResult] = useState<FixResultPopup>(null);
  const [pendingCaret, setPendingCaret] = useState<{ lineId: string; index: number } | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [fillers, setFillers] = useState(12);

  const linesRef = useRef<ClientLine[]>([]);
  // merged-episode blob in the bottom player; bumped per fetch so the provider
  // treats every refresh as a new item ("same id" would never reload the file)
  const episodeUrlRef = useRef<string | null>(null);
  const episodeNumRef = useRef(0);

  // one distinct color per distinct speaker, assigned by order of first
  // appearance in the script (stable while the speaker set is stable)
  const speakerColors = useMemo(
    () => assignSpeakerColors(lines.map((l) => l.speaker)),
    [lines],
  );
  const speakerColorOf = useMemo(
    () => (name: string | null): SpeakerColor => (name ? speakerColors.get(name) ?? SPEAKER_PALETTE[0]! : SPEAKER_PALETTE[0]!),
    [speakerColors],
  );
  const genSetRef = useRef(genSet);
  const fixBusyRef = useRef(fixBusy);
  const fixResultRef = useRef(fixResult);
  const payloadRef = useRef<string | null>(null);
  const rowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const savedPayloadRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const undoRef = useRef<Array<{ lineId: string; text: string }>>([]);
  const noteSeqRef = useRef(0);

  // keep "latest value" refs in sync inside effects (never during render)
  const payload = useMemo(() => JSON.stringify(payloadOf(title, lines)), [title, lines]);
  useEffect(() => {
    linesRef.current = lines;
    genSetRef.current = genSet;
    fixBusyRef.current = fixBusy;
    fixResultRef.current = fixResult;
    payloadRef.current = payload;
  }, [lines, genSet, fixBusy, fixResult, payload]);

  // review card: Escape or a click outside keeps the edit and dismisses the card
  useEffect(() => {
    if (!fixResult) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keepFixResult();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-diff-popup]')) keepFixResult();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixResult]);

  // ruled sheet: enough empty stripes to fill the screen below the written lines
  useEffect(() => {
    const calc = () => setFillers(Math.min(80, Math.max(6, Math.ceil((window.innerHeight - 200) / 27))));
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, []);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    fetch(`/api/scripts/${scriptId}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) { if (alive) setNotFound(true); return; }
        const j = (await r.json()) as { script: ClientScript };
        if (!alive) return;
        setScript(j.script);
        setTitle(j.script.title);
        setLines(j.script.lines);
        savedPayloadRef.current = JSON.stringify(payloadOf(j.script.title, j.script.lines));
        loadedRef.current = true;
      })
      .catch(() => { if (alive) setNotFound(true); });
    return () => { alive = false; };
  }, [scriptId]);

  // ---------- preflight poll ----------
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/preflight', { cache: 'no-store' });
        const j = (await r.json()) as Preflight;
        if (alive) setPreflight(j);
      } catch { /* keep last */ }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // ---------- autosave ----------
  useEffect(() => {
    if (!loadedRef.current) return;
    if (payload === savedPayloadRef.current) return;
    setSaving(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/scripts/${scriptId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: payloadRef.current,
        });
        if (r.ok) {
          savedPayloadRef.current = payloadRef.current;
          setSavedTick((n) => n + 1);
        }
      } catch { /* retried on next change */ } finally {
        setSaving(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [payload, scriptId]);

  useEffect(() => {
    const onUnload = () => {
      if (savedPayloadRef.current === payloadRef.current) return;
      fetch(`/api/scripts/${scriptId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payloadRef.current,
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [scriptId]);

  // ---------- playback (ElevenLabs AudioPlayerProvider owns the <audio> element) ----------
  // item ids carry the GENERATION stamp (bumped on every successful render):
  // regenerating the same text must change the id, or the provider would keep
  // playing the previous take ("same id" branches never reload the file).
  // The hash is NOT part of the id - it only marks stale/ready state.
  const itemIdOf = (line: ClientLine) => `${line.id}@${line.audio?.gen ?? 'live'}`;
  const srcOf = (line: ClientLine) => `/api/scripts/${scriptId}/audio/${line.id}?v=${line.audio?.gen ?? 'live'}`;
  const rawActiveId = player.activeItem?.id ?? null;
  const episodeMode = typeof rawActiveId === 'string' && rawActiveId.startsWith('episode@');
  const activeLineId = typeof rawActiveId === 'string' && !episodeMode && rawActiveId.includes('@') ? rawActiveId.split('@')[0] : null;
  const activeLine = activeLineId ? lines.find((l) => l.id === activeLineId) ?? null : null;
  const activePosition = activeLine ? lines.findIndex((l) => l.id === activeLine.id) + 1 : null;

  const startClip = (line: ClientLine) => {
    const id = itemIdOf(line);
    if (player.isItemActive(id)) {
      const el = player.ref.current;
      if (el && el.ended) player.seek(0);
      void player.play();
    } else {
      void player.play({ id, src: srcOf(line), data: null });
    }
  };

  /** Fetch the merged episode (server merges current clips on the fly; gated on
   *  every line being up to date) and load it into the bottom player, ready to
   *  play. Pressing play on any row switches the player back to that line. */
  const refreshEpisode = async (): Promise<boolean> => {
    try {
      const r = await fetch(`/api/scripts/${scriptId}/download/merged`);
      if (!r.ok) return false;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (episodeUrlRef.current) URL.revokeObjectURL(episodeUrlRef.current);
      episodeUrlRef.current = url;
      episodeNumRef.current += 1;
      void player.setActiveItem({ id: `episode@${episodeNumRef.current}`, src: url, data: null });
      return true;
    } catch {
      return false;
    }
  };

  // ---------- notification feed (uiarc notification center) ----------
  const pushNote = (n: {
    title: string;
    description?: string;
    tone?: NotificationItem['tone'];
    unread?: boolean;
    action?: NotificationItem['action'];
  }): string => {
    const id = `n-${Date.now().toString(36)}-${++noteSeqRef.current}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setNotifs((cur) => {
      // a fresh identical unread note replaces the previous one instead of stacking
      const first = cur[0];
      if (
        first &&
        !first.read &&
        first.title === n.title &&
        (first.description ?? '') === (n.description ?? '') &&
        !n.action
      ) {
        const updated = cur.map((x, i) => (i === 0 ? { ...first, time } : x));
        return updated;
      }
      return [{ id, title: n.title, description: n.description, time, tone: n.tone ?? 'info', read: n.unread ? false : true, action: n.action }, ...cur];
    });
    return id;
  };
  const dismissNote = (id: string) => {
    setNotifs((cur) => cur.filter((x) => x.id !== id));
  };

  // ---------- fix grammar floating option ----------
  // Any non-trivial selection inside ONE line's text pops the button; the fix
  // applies to the selected words only (whole line works the same way).
  useEffect(() => {
    const onSel = () => {
      if (fixBusyRef.current) return;
      if (fixResultRef.current) return; // review card stays put while open
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setFix(null); return; }
      const r = sel.getRangeAt(0);
      const startEl = elementOf(sel.anchorNode);
      const endEl = elementOf(sel.focusNode);
      const rowEl = elementOf(r.commonAncestorContainer)?.closest('[data-row-id]') as HTMLElement | null;
      if (!rowEl || startEl?.closest('[data-row-id]') !== rowEl || endEl?.closest('[data-row-id]') !== rowEl) {
        setFix(null); return;
      }
      const lineId = rowEl.dataset.rowId!;
      const el = rowElsRef.current.get(lineId);
      if (!el) { setFix(null); return; }
      const line = linesRef.current.find((l) => l.id === lineId);
      if (!line || !line.text.trim()) { setFix(null); return; }
      const bounds = getSelectionTextRange(el);
      if (!bounds || bounds.end <= bounds.start) { setFix(null); return; }
      const picked = line.text.slice(bounds.start, bounds.end);
      // selections that carry no speakable words (emotion chips only) get no button
      if (picked.replace(/\[[a-z]+\]/gi, ' ').replace(/\s/g, '').length < 2) { setFix(null); return; }
      const rect = r.getBoundingClientRect();
      setFix({ lineId, top: Math.max(8, rect.top), bottom: rect.bottom, left: Math.max(8, rect.left), start: bounds.start, end: bounds.end });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const applyFix = async (mode: RewriteMode) => {
    if (!fix) return;
    const line = linesRef.current.find((l) => l.id === fix.lineId);
    if (!line) return;
    setFixResult(null);
    setFixBusyMode(mode);
    const { lineId, top, bottom, left, start, end } = fix;
    const orig = line.text.slice(start, end);
    // only raw spoken words go to the AI: emotion tags are stripped from every
    // segment; the tags themselves stay in the line afterwards, at their spots
    const isTag = (s: string) => /^\[[a-z]+\]$/i.test(s);
    const segments = orig.split(/(\[[a-z]+\])/gi);
    type FixSlot = { i: number; text: string };
    const fixables: FixSlot[] = segments
      .map((s, i) => ({ i, text: isTag(s) ? '' : s.replace(/\s{2,}/g, ' ').trim() }))
      .filter((s): s is FixSlot => s.text.length > 0);
    if (fixables.length === 0) {
      pushNote({ tone: 'warning', unread: true, title: 'Nothing to fix', description: 'The selection has no spoken words (emotion tags only).' });
      setFix(null);
      return;
    }
    setFixBusy(true);
    try {
      const fixedByIndex = new Map<number, string>();
      for (const s of fixables) {
        const r = await fetch('/api/grammar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: s.text, mode }),
        });
        const j = (await r.json()) as { text?: string; error?: string };
        if (!r.ok || !j.text) {
          pushNote({ tone: 'warning', unread: true, title: mode === 'improve' ? 'Improve writing failed' : 'Grammar fix failed', description: j.error ?? `HTTP ${r.status}` });
          setFix(null);
          return;
        }
        fixedByIndex.set(s.i, j.text);
      }
      // reassemble: tags back where they were, corrected text in between
      const prev = line.text;
      let replaced = segments
        .map((s, i) => (isTag(s) ? s : fixedByIndex.get(i) ?? s.replace(/\s{2,}/g, ' ').trim()))
        .join('');
      replaced = replaced.replace(/(\S)\[/g, '$1 [').replace(/\](\S)/g, '] $1').replace(/\s{2,}/g, ' ').trim();
      const spokenBefore = orig.replace(/\[[a-z]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
      const spokenAfter = replaced.replace(/\[[a-z]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
      setFix(null);
      window.getSelection()?.removeAllRanges();
      if (diffIsNoop(spokenBefore, spokenAfter)) {
        pushNote({
          tone: 'info',
          unread: true,
          title: mode === 'improve' ? 'Already at its best' : 'Nothing to correct',
          description: 'The AI found no changes for this text.',
        });
        return;
      }
      patchLine(lineId, { text: line.text.slice(0, start) + replaced + line.text.slice(end) });
      undoRef.current.push({ lineId, text: prev });
      setPendingCaret({ lineId, index: start + replaced.length });
      setFixResult({
        lineId, start,
        rect: { top, bottom, left },
        prevFull: prev, prev: spokenBefore, next: spokenAfter, mode,
      });
    } catch (e) {
      pushNote({ tone: 'warning', unread: true, title: mode === 'improve' ? 'Improve writing failed' : 'Grammar fix failed', description: String(e) });
      setFix(null);
    } finally {
      setFixBusy(false);
    }
  };

  const keepFixResult = () => setFixResult(null);

  const removeFixResult = () => {
    if (!fixResult) return;
    const { lineId, start, prevFull } = fixResult;
    patchLine(lineId, { text: prevFull });
    undoRef.current = undoRef.current.filter((u) => !(u.lineId === lineId && u.text === prevFull));
    setPendingCaret({ lineId, index: start });
    setFixResult(null);
    pushNote({ title: 'Reverted.' });
  };

  // ---------- line ops ----------
  const patchLine = (lineId: string, patch: Partial<ClientLine>) => {
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
  };

  const addLineAfter = (lineId: string) => {
    const idx = lines.findIndex((l) => l.id === lineId);
    const fresh: ClientLine = { id: newLocalId(), text: '', speaker: null, audio: null };
    setLines((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, fresh);
      return next;
    });
    setPendingCaret({ lineId: fresh.id, index: 0 });
  };

  const appendLine = () => {
    const fresh: ClientLine = { id: newLocalId(), text: '', speaker: null, audio: null };
    setLines((prev) => [...prev, fresh]);
    setPendingCaret({ lineId: fresh.id, index: 0 });
  };

  const removeLine = (lineId: string) => {
    const idx = lines.findIndex((l) => l.id === lineId);
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((l) => l.id !== lineId));
    const prevIdx = Math.max(0, idx - 1);
    const prevLine = lines[prevIdx];
    if (prevLine) setPendingCaret({ lineId: prevLine.id, index: 1e9 });
    if (activeLineId === lineId) {
      void player.pause();
      void player.setActiveItem(null);
    }
  };

  const undoLine = (lineId: string) => {
    for (let i = undoRef.current.length - 1; i >= 0; i--) {
      const u = undoRef.current[i];
      if (u.lineId === lineId) {
        undoRef.current.splice(i, 1);
        patchLine(lineId, { text: u.text });
        setPendingCaret({ lineId, index: 1e9 });
        return true;
      }
    }
    return false;
  };

  // ---------- generation ----------
  const postGenerate = async (lineId: string): Promise<{ ok: boolean; err?: string }> => {
    setGenSet((p) => ({ ...p, [lineId]: true }));
    try {
      const r = await fetch(`/api/scripts/${scriptId}/generate-line`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineId }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; line?: ClientLine; error?: string };
      if (j.line) {
        patchLine(lineId, { ...j.line });
      }
      if (r.ok && j.line) return { ok: true };
      return { ok: false, err: j.error ?? `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, err: String(e) };
    } finally {
      setGenSet((p) => {
        const q = { ...p };
        delete q[lineId];
        return q;
      });
    }
  };

  const playLine = async (lineId: string) => {
    const line = linesRef.current.find((l) => l.id === lineId);
    if (!line || !line.text.trim()) return;
    const pos = linesRef.current.findIndex((l) => l.id === lineId) + 1;
    const st = statusOf(line, !!genSetRef.current[lineId]);
    if (!spokenText(line.text).trim()) {
      // tag-only lines ([sighs] with no words) are legal silent lines
      pushNote({ tone: 'info', unread: true, title: `Line ${pos} has nothing to speak`, description: 'It only carries emotion tags - write some words and I will voice it.' });
      return;
    }
    if (st === 'nospeaker') {
      // speaker-less lines are legal silent lines: nothing to voice, stay calm
      pushNote({ tone: 'info', unread: true, title: `Line ${pos} has no speaker`, description: 'Nothing to voice - assign one any time with / if this line should speak.' });
      return;
    }
    if (preflight.state !== 'ready') {
      pushNote({ tone: 'warning', unread: true, title: `Voice engine is ${preflight.state}`, description: preflight.reason ?? 'Wait for the GPU engine to warm up.' });
      return;
    }
    if (st !== 'ready') {
      const r = await postGenerate(lineId);
      const after = linesRef.current.find((l) => l.id === lineId);
      if (!r.ok || !after) {
        pushNote({ tone: 'warning', unread: true, title: `Line ${pos} failed`, description: r.err ?? 'generation error' });
        return;
      }
    }
    const fresh = linesRef.current.find((l) => l.id === lineId);
    if (fresh) startClip(fresh);
  };

  const generateAll = async () => {
    if (batch) return;
    const all = linesRef.current;
    // lines without a speaker or with no words left after emotion tags are
    // legal silent lines: skipped quietly
    const speakable = all.filter((l) => l.speaker && spokenText(l.text).trim());
    // lines without a speaker are legal silent lines: skipped quietly
    const targets = speakable.filter((l) => l.speaker && statusOf(l, !!genSetRef.current[l.id]) !== 'ready');
    if (targets.length === 0) {
      if (speakable.some((l) => l.speaker)) {
        // nothing to render, but the user may still want the merged episode loaded
        const okEp = await refreshEpisode();
        pushNote({ tone: 'success', title: 'Audio already up to date', description: okEp ? 'Full episode loaded in the player below.' : 'Every line already has audio for its current text.' });
      }
      return;
    }
    setBatch({ done: 0, total: targets.length });
    let failed = 0;
    for (const l of targets) {
      const r = await postGenerate(l.id);
      if (!r.ok) failed++;
      setBatch((b) => (b ? { done: b.done + 1, total: b.total } : b));
    }
    setBatch(null);
    if (failed > 0) {
      pushNote({ tone: 'warning', unread: true, title: `${failed} clip${failed > 1 ? 's' : ''} failed`, description: 'Press Generate audios again to retry only those, or play a row to retry it alone.' });
      return;
    }
    const okEp = await refreshEpisode();
    pushNote({ tone: 'success', unread: true, title: 'Full episode ready', description: okEp ? `Loaded in the player below (${targets.length} line${targets.length > 1 ? 's' : ''} rendered).` : 'Clips are ready; the merged file will be available for download.' });
  };

  const regeneratePlayerLine = async () => {
    if (!activeLine || regenBusy) return;
    const line = linesRef.current.find((l) => l.id === activeLine.id);
    if (!line) return;
    if (!line.speaker) {
      pushNote({ tone: 'info', unread: true, title: `Line ${linesRef.current.indexOf(line) + 1} has no speaker`, description: 'Nothing to regenerate - assign one with / first if this line should speak.' });
      return;
    }
    if (!spokenText(line.text).trim()) {
      pushNote({ tone: 'info', unread: true, title: `Line ${linesRef.current.indexOf(line) + 1} has nothing to speak`, description: 'It only carries emotion tags - write some words and I will voice it.' });
      return;
    }
    setRegenBusy(true);
    const r = await postGenerate(line.id);
    setRegenBusy(false);
    const fresh = linesRef.current.find((l) => l.id === line.id);
    if (!r.ok || !fresh) {
      pushNote({ tone: 'warning', unread: true, title: 'Regenerate failed', description: r.err ?? 'error' });
      return;
    }
    startClip(fresh); // generation stamp changed → new item id → provider reloads and plays the new take
    pushNote({ tone: 'success', title: `Line ${linesRef.current.indexOf(fresh) + 1} re-generated` });
  };

  // ---------- slash menu ----------
  /** Speaker carried over from the closest line above that has one (new empty
   *  lines inherit it: space as the first letter assigns it directly, / and
   *  the mic button preselect it). */
  const inheritedSpeaker = (lineId: string): string | null => {
    const idx = linesRef.current.findIndex((l) => l.id === lineId);
    for (let i = idx - 1; i >= 0; i--) {
      const s = linesRef.current[i]?.speaker;
      if (s) return s;
    }
    return null;
  };

  const onSlash = (lineId: string) => {
    const line = linesRef.current.find((l) => l.id === lineId);
    const el = rowElsRef.current.get(lineId);
    if (!line || !el) return;
    const caret = getCaretTextIndex(el);
    if (caret < 1) return;
    // no speaker yet -> speaker picker; speaker set -> emotion tags
    const mode = line.speaker ? 'emotion' : 'speaker';
    const m = defaultMenu(mode, lineId, caretRect(el), caret - 1, caret);
    const inherited = inheritedSpeaker(lineId);
    if (mode !== 'emotion' && inherited) {
      m.active = Math.max(0, menuItems(m).findIndex((it) => it.value === `sp:${inherited}`));
    }
    setMenu(m);
  };

  const onCaretMoved = (lineId: string, caret: number) => {
    setMenu((prev) => {
      if (!prev || prev.lineId !== lineId || prev.mode === 'speaker-pick') return prev;
      if (caret <= prev.queryStart) return null; // caret moved before/at the slash
      const text = linesRef.current.find((l) => l.id === lineId)?.text ?? '';
      const q = text.slice(prev.queryStart + 1, Math.max(caret, prev.queryStart + 1));
      if (/\s/.test(q)) return null; // whitespace ends filtering; typed text stays
      if (q === prev.query && prev.caretEnd === caret) return prev;
      return { ...prev, query: q, caretEnd: caret, active: 0 };
    });
  };

  const commitMenu = (value: string) => {
    const m = menu;
    if (!m) return;
    const line = linesRef.current.find((l) => l.id === m.lineId);
    const el = rowElsRef.current.get(m.lineId);
    if (!line || !el) { setMenu(null); return; }
    const caret = getCaretTextIndex(el);

    if (m.mode === 'speaker-pick') {
      if (value.startsWith('sp:')) patchLine(line.id, { speaker: value.slice(3) });
      setMenu(null);
      return;
    }

    const before = line.text.slice(0, m.queryStart);
    const after = line.text.slice(Math.max(m.caretEnd, caret));

    if (value.startsWith('sp:')) {
      // speaker pick: consume the typed "/query", keep surrounding words
      const raw = before + after;
      const trimmed = raw.replace(/^\s+/, '');
      const shifted = raw.length - trimmed.length;
      patchLine(line.id, { speaker: value.slice(3), text: trimmed });
      setPendingCaret({ lineId: line.id, index: Math.max(0, before.length - shifted) });
      setMenu(null);
      return;
    }
    // emotion chip: drop the typed "/query", insert the tag token in place
    const tag = `[${value.slice(3)}]`;
    const padBefore = before && !/\s$/.test(before) ? ' ' : '';
    const padAfter = after && !/^\s/.test(after) ? ' ' : '';
    const nextText = `${before}${padBefore}${tag}${padAfter}${after}`;
    patchLine(line.id, { text: nextText });
    setPendingCaret({ lineId: line.id, index: (before + padBefore + tag).length });
    setMenu(null);
  };

  const menuNav = (e: React.KeyboardEvent, lineId: string): boolean => {
    if (!menu || menu.lineId !== lineId) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = menuItems(menu);
      if (items.length === 0) return true;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setMenu((prev) => prev && ({ ...prev, active: (prev.active + dir + items.length) % items.length }));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const items = menuItems(menu);
      if (items.length === 0) { setMenu(null); return true; }
      e.preventDefault();
      commitMenu(items[Math.min(menu.active, items.length - 1)].value);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenu(null); // typed '/' and query stay as plain characters
      return true;
    }
    return false;
  };

  // ---------- render ----------
  const allReady = useMemo(() => {
    const speakable = lines.filter((l) => spokenText(l.text).trim());
    // speaker-less lines are legal silent lines with no audio expectations
    return speakable.length > 0 && speakable.every((l) => !l.speaker || (l.audio && l.audio.hash === lineHash(l.speaker, l.text)));
  }, [lines]);

  const speakableCount = lines.filter((l) => spokenText(l.text).trim()).length;

  if (notFound) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 py-24">
        <p className="text-sm text-muted-foreground">This script doesn&apos;t exist (or was deleted from .data).</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/')}>Back to scripts</Button>
      </main>
    );
  }
  if (!script) {
    return <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading script…</main>;
  }

  return (
    <main className="flex h-dvh flex-col">
      {fix && !fixBusy && (
        <FixPopup
          rect={{ top: fix.top, bottom: fix.bottom, left: fix.left }}
          busy={false}
          busyMode={fixBusyMode}
          onRun={applyFix}
        />
      )}
      {fix && fixBusy && (
        <FixPopup
          rect={{ top: fix.top, bottom: fix.bottom, left: fix.left }}
          busy
          busyMode={fixBusyMode}
          onRun={applyFix}
        />
      )}
      {fixResult && (
        <DiffPopup
          rect={fixResult.rect}
          mode={fixResult.mode}
          prev={fixResult.prev}
          next={fixResult.next}
          onKeep={keepFixResult}
          onRemove={removeFixResult}
        />
      )}
      {menu && <SlashMenu menu={menu} onCommit={commitMenu} onClose={() => setMenu(null)} onHover={(i) => setMenu((p) => p && ({ ...p, active: i }))} speakerColorOf={speakerColorOf} />}

      {/* top bar */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-neutral-950/95 backdrop-blur">
        <div className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5">
          <Button variant="ghost" size="icon-sm" aria-label="Back to scripts" onClick={() => router.push('/')}>
            <ArrowLeftIcon size={15} />
          </Button>
          <LogoTile size={24} />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Script title"
            className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 text-sm font-semibold hover:border-border"
          />
          {batch && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300">
              <Loader2Icon size={11} className="animate-spin" /> Generating {batch.done}/{batch.total}
            </span>
          )}
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
              preflight.state === 'ready' && 'border-border/60 text-muted-foreground',
              preflight.state === 'loading' && 'border-amber-500/40 bg-amber-500/10 text-amber-300',
              preflight.state === 'failed' && 'border-red-500/40 bg-red-500/10 text-red-300',
            )}
            title={preflight.reason ?? 'GPU voice engine status'}
          >
            voice engine {preflight.state}
          </span>
          {allReady && (
            <>
              <a
                href={`/api/scripts/${scriptId}/download/merged`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-400 px-3 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300"
              >
                <DownloadIcon size={12} /> Merged audio
              </a>
              <a
                href={`/api/scripts/${scriptId}/download/zip`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium transition hover:bg-muted"
              >
                <DownloadIcon size={12} /> Clips (.zip)
              </a>
            </>
          )}
          <Button size="sm" onClick={generateAll} disabled={!!batch || preflight.state !== 'ready'} className="gap-1.5">
            {batch ? <Loader2Icon size={13} className="animate-spin" /> : <Volume2Icon size={13} />}
            {batch ? `Generating ${batch.done}/${batch.total}` : 'Generate audios'}
          </Button>
          <NotificationCenter
            notifications={notifs}
            onReadChange={(n, read) => setNotifs((cur) => cur.map((x) => (x.id === n.id ? { ...x, read } : x)))}
            onDismiss={(n) => dismissNote(n.id)}
          />
        </div>
      </header>

      {/* script editor — full-bleed ruled lines */}
      <div className="min-h-0 flex-1 overflow-y-auto" id="rows">
        <div className="w-full pb-28 pt-2">
          {lines.map((l, i) => (
            <LineRow
              key={l.id}
              line={l}
              position={i + 1}
              status={statusOf(l, !!genSet[l.id])}
              playing={activeLineId === l.id && player.isPlaying}
              pendingCaret={pendingCaret}
              clearPendingCaret={() => setPendingCaret(null)}
              registerEl={(id, el) => {
                if (el) rowElsRef.current.set(id, el);
                else rowElsRef.current.delete(id);
              }}
              onText={(id, text, caret) => {
                // space as the FIRST letter on a no-speaker line adopts the
                // previous line's speaker right away (the space itself is
                // swallowed; with nothing to inherit the space stays text)
                const target = linesRef.current.find((l) => l.id === id);
                if (target && !target.speaker && text === ' ') {
                  const inherited = inheritedSpeaker(id);
                  if (inherited) {
                    patchLine(id, { speaker: inherited, text: '' });
                    setPendingCaret({ lineId: id, index: 0 });
                    return;
                  }
                }
                patchLine(id, { text });
                onCaretMoved(id, caret);
              }}
              onSlash={onSlash}
              onCaretMoved={onCaretMoved}
              onMenuNav={menuNav}
              onEnter={addLineAfter}
              onBackspaceEmpty={removeLine}
              onUndo={undoLine}
              onPlay={playLine}
              onChipSpeaker={(lineId) => {
                const el = rowElsRef.current.get(lineId);
                const r = el?.getBoundingClientRect();
                const m = defaultMenu('speaker-pick', lineId, { top: r?.bottom ?? 200, left: r?.left ?? 200 }, -1, -1);
                const inherited = inheritedSpeaker(lineId);
                if (inherited) {
                  m.active = Math.max(0, menuItems(m).findIndex((it) => it.value === `sp:${inherited}`));
                }
                setMenu(m);
              }}
              speakerColorOf={speakerColorOf}
            />
          ))}
          {Array.from({ length: fillers }, (_, f) => {
            const p = lines.length + f + 1; // virtual position, continues the numbering + striping
            const claimable = f === 0;
            return (
              <div
                key={`filler-${p}`}
                aria-hidden={!claimable}
                onClick={claimable ? appendLine : undefined}
                className={cn(
                  'grid grid-cols-[2.25rem_1.75rem_0_minmax(0,1fr)_auto] items-baseline gap-x-1.5 border-l-2 border-l-transparent py-1 pl-1 pr-3',
                  p % 2 === 1 ? 'bg-zinc-950' : 'bg-white/[0.03]',
                  claimable ? 'cursor-text' : 'pointer-events-none select-none opacity-70',
                )}
              >
                <span />
                <span className="select-none text-right text-[11px] leading-5 text-muted-foreground/35 tabular-nums">{p}</span>
                <span />
                <span className="text-[13px] leading-5 text-transparent select-none">&nbsp;</span>
                <span />
              </div>
            );
          })}
          <p className="px-3 pt-2 text-[10px] leading-relaxed text-muted-foreground/80">
            {speakableCount} speakable {speakableCount === 1 ? 'line' : 'lines'} · Enter = new line · Backspace on an empty line deletes it ·
            / opens speakers + emotion tags on any line · select a whole line for Fix grammar · click the next ruled line to keep writing
            {saving ? ' · saving…' : savedTick > 0 ? ' · all changes saved' : ''}
          </p>
        </div>
      </div>

      <PlayerBar
        activeLineId={activeLineId}
        activePosition={activePosition}
        activeSpeaker={activeLine?.speaker ?? null}
        speakerColorOf={speakerColorOf}
        episodeMode={episodeMode}
        regenerating={regenBusy}
        onRegenerate={regeneratePlayerLine}
      />
    </main>
  );
}

function payloadOf(title: string, lines: ClientLine[]) {
  return {
    title: title.trim() || 'Untitled script',
    lines: lines.map((l) => ({ id: l.id, text: l.text, speaker: l.speaker })),
  };
}

function newLocalId(): string {
  return crypto.randomUUID();
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}
