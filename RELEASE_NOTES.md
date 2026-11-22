# v1.0.1 (Windows)

Fixes stale playback after a regeneration, adds per-clip downloads, and repairs
the stylesheet so the packaged app looks right.

## Fixed

- Pressing play after editing a line and regenerating now plays the new take on
  the first press. Previously the player kept the previous audio until the second
  press, because the loaded media only reloaded when the item id changed, not
  when the clip URL changed (every regeneration produces a new `?v=` stamp).
- Production CSS ships Tailwind utilities again. The stylesheet was compiled
  through a Turbopack-only loader, so alternate builds emitted preflight rules
  only and pages rendered unstyled.

## Added

- Download button beside the player controls: saves the loaded line as
  `<title>-<line>-<speaker>.wav` (`?download=1` on the clip route). Regular
  requests still stream inline into the player.

## Build

- Builds use the webpack builder; cold Turbopack builds stalled at
  "Creating an optimized production build".
- Staging accepts CSS wherever the builder emits it (`static/css` or
  `static/chunks`) and the type check skips packaged copies under `release*/`.

## Setup

- Grammar fix / improve writing need `LLM_API_KEY` (Groq) in
  `resources/app/.env.local`
- The release ships with no API keys and no user data
- The TTS model files (~2.7 GB) must sit next to the app's `resources/models`
  folder
- The exe is unsigned: SmartScreen may ask about an unknown publisher on first
  run
