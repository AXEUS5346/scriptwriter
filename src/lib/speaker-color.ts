// Each speaker owns a distinct color within a script: line chips, row margins,
// the player label and the "/" menu all use it. Colors are assigned by order
// of first appearance in the script's lines, so every distinct speaker gets
// its own hue (cycles only past the palette size).
//
// The palette avoids the status hues (amber = stale, red = failed, emerald =
// downloads) so a speaker color never reads as a generation state.

export type SpeakerColor = {
  chip: string; // pill background + text
  text: string; // bare text tint (player label, menu)
  dot: string; // solid swatch (menu + elsewhere)
  border: string; // row left-margin tint
};

export const SPEAKER_PALETTE: SpeakerColor[] = [
  { chip: 'bg-sky-500/10 text-sky-300', text: 'text-sky-300', dot: 'bg-sky-400', border: 'border-l-sky-500/40' },
  { chip: 'bg-rose-500/10 text-rose-300', text: 'text-rose-300', dot: 'bg-rose-400', border: 'border-l-rose-500/40' },
  { chip: 'bg-teal-500/10 text-teal-300', text: 'text-teal-300', dot: 'bg-teal-400', border: 'border-l-teal-500/40' },
  { chip: 'bg-indigo-500/10 text-indigo-300', text: 'text-indigo-300', dot: 'bg-indigo-400', border: 'border-l-indigo-500/40' },
  { chip: 'bg-orange-500/10 text-orange-300', text: 'text-orange-300', dot: 'bg-orange-400', border: 'border-l-orange-500/40' },
  { chip: 'bg-lime-500/10 text-lime-300', text: 'text-lime-300', dot: 'bg-lime-400', border: 'border-l-lime-500/40' },
  { chip: 'bg-pink-500/10 text-pink-300', text: 'text-pink-300', dot: 'bg-pink-400', border: 'border-l-pink-500/40' },
  { chip: 'bg-cyan-500/10 text-cyan-300', text: 'text-cyan-300', dot: 'bg-cyan-400', border: 'border-l-cyan-500/40' },
  { chip: 'bg-purple-500/10 text-purple-300', text: 'text-purple-300', dot: 'bg-purple-400', border: 'border-l-purple-500/40' },
];

/** Assign one color per distinct speaker, in order of first appearance. */
export function assignSpeakerColors(names: Array<string | null>): Map<string, SpeakerColor> {
  const seen: string[] = [];
  for (const n of names) {
    if (n && !seen.includes(n)) seen.push(n);
  }
  return new Map(seen.map((n, i) => [n, SPEAKER_PALETTE[i % SPEAKER_PALETTE.length]!]));
}
