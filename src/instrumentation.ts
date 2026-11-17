// The resident TTS daemon is owned by the MAIN ROUTE-SERVER process only.
// register() runs in a separate instrumentation worker (handover trap B), so
// spawning it from here would leave the model under a process whose exit hooks
// we do not control - the model would not reliably leave VRAM when the
// scriptwriter closes. Warm-up is driven by the /api/preflight poller, by
// /api/scripts/[id]/generate-line, and by /api/restart instead.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // intentionally empty (see comment above)
  }
}
