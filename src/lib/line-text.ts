// Line text model shared by the client (chips rendering, hash) and server (hash,
// zip naming). A line's text is a plain string; emotion tags appear inline as
// [tag] and render as chips. The speaker is a separate field, never spoken.

export const EMOTION_TAGS = ['excited', 'sad', 'whispers', 'sighs', 'laughs'] as const;
export type EmotionTag = (typeof EMOTION_TAGS)[number];

const TAG_SPLIT_RE = /(\[(?:excited|sad|whispers|sighs|laughs)\])/gi;

/** Text with emotion tags stripped — the actually-spoken words. */
export function spokenText(text: string): string {
  return text.replace(TAG_SPLIT_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function spokenWords(text: string): string[] {
  return spokenText(text).split(/\s+/).filter(Boolean);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16) + '_' + s.length.toString(36);
}

/** What determines a clip's freshness: the speaker AND the exact text (tags included). */
export function lineHash(speaker: string | null, text: string): string {
  return djb2(`${speaker ?? ''}\u0000${text}`);
}

/** Windows-illegal filename characters (and control chars) removed. */
export function sanitizeFileName(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\s.]+$/g, '') // no trailing dots/spaces on Windows
    .trim();
}

/** Zip member name: "4 - Ahana - Hey! AXEUS, glad to..." */
export function zipNameForLine(position: number, speaker: string, text: string): string {
  const w = spokenWords(text);
  const head = w.slice(0, 4).join(' ');
  const ellipsis = w.length > 4 ? '...' : '';
  // sanitize the whole name, then append the ellipsis (sanitizing strips
  // trailing dots by Windows rules, which would eat it)
  return sanitizeFileName(`${position} - ${speaker} - ${head}`) + ellipsis + '.wav';
}
