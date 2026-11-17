'use client';

// Caret helpers for contenteditable line editors. The model text and the
// rendered innerText are 1:1 (emotion chips display exactly "[tag]"), so caret
// positions can be converted to/from plain text indexes via Range.toString().

export function getCaretTextIndex(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return -1;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(r.startContainer, r.startOffset);
  return probe.toString().length;
}

/** Plain-text [start, end) of the current selection within the model text of
 *  `el`. Selection bounds that land inside an emotion chip are clamped to the
 *  chip's edges, so slicing line.text with these indexes never cuts a tag. */
export function getSelectionTextRange(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;

  const owningChip = (node: Node): HTMLElement | null => {
    let n: Node | null = node;
    while (n && n !== el) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as HTMLElement;
        if (e.dataset?.tag) return e;
      }
      n = n.parentNode;
    }
    return null;
  };
  const indexBefore = (container: Node, offset: number): number => {
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.setEnd(container, offset);
    return probe.toString().length;
  };

  const startChip = owningChip(r.startContainer);
  const endChip = owningChip(r.endContainer);
  const start = startChip ? indexBefore(startChip, 0) : indexBefore(r.startContainer, r.startOffset);
  const end = endChip ? indexBefore(endChip, 0) + (endChip.textContent ?? '').length : indexBefore(r.endContainer, r.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function setCaretAtTextIndex(el: HTMLElement, index: number): boolean {
  // walk top-level pieces; emotion chips are contenteditable=false, so the caret
  // must never land inside one — indexes within a chip resolve to after it
  const pieces: Array<{ kind: 'text' | 'chip'; node: Text | HTMLElement; len: number }> = [];
  const walk = (parent: HTMLElement) => {
    parent.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        pieces.push({ kind: 'text', node: n as Text, len: (n as Text).data.length });
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const child = n as HTMLElement;
        if (child.dataset?.tag) {
          pieces.push({ kind: 'chip', node: child, len: (child.textContent ?? '').length });
        } else {
          walk(child); // wrappers browsers sometimes add (<b>, <span>)
        }
      }
    });
  };
  walk(el);

  const sel = window.getSelection();
  if (!sel) return false;
  const r = document.createRange();

  const collapseTo = (mode: 'start' | 'end') => {
    r.selectNodeContents(el);
    r.collapse(mode === 'start');
  };
  const chipBoundary = (chip: HTMLElement, after: boolean) => {
    if (after) r.setStartAfter(chip);
    else r.setStartBefore(chip);
  };

  let remaining = Math.max(0, index);
  let placed = false;
  for (const p of pieces) {
    if (remaining <= p.len) {
      if (p.kind === 'text') {
        r.setStart(p.node as Text, remaining);
      } else {
        chipBoundary(p.node as HTMLElement, remaining > 0);
      }
      placed = true;
      break;
    }
    remaining -= p.len;
  }
  if (!placed) {
    const last = pieces[pieces.length - 1];
    if (!last) collapseTo('start');
    else if (last.kind === 'text') r.setStart(last.node as Text, (last.node as Text).data.length);
    else chipBoundary(last.node as HTMLElement, true);
  }

  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

export function caretRect(el: HTMLElement): { top: number; left: number } {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).cloneRange();
    let rect = r.getBoundingClientRect();
    if (rect.top === 0 && rect.left === 0) {
      // collapsed range in an empty node: widen to contents briefly
      r.selectNodeContents(el);
      rect = r.getBoundingClientRect();
    }
    if (rect.top !== 0 || rect.left !== 0) {
      return { top: rect.bottom, left: rect.left };
    }
  }
  const host = el.getBoundingClientRect();
  return { top: host.bottom, left: host.left + 16 };
}

export function focusElement(el: HTMLElement | null, at: 'start' | 'end'): void {
  if (!el) return;
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(at === 'start');
  sel.removeAllRanges();
  sel.addRange(r);
}
