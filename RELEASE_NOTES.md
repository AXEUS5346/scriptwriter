First Windows release of Scriptwriter.

## Features

- Multi-speaker dialogue editor: ruled full-screen lines, per-speaker colors, Enter for new lines
- `/` picks a speaker on a new line; once a speaker is set, `/` inserts emotion tags
- Fix grammar + Improve writing with a Keep/Remove diff review; edits are undoable
- Line-by-line TTS (Maya2 Native, resident daemon stays loaded for fast regenerations)
- Sentences are chunked (max 2 emotion tags per chunk) and the clips are merged back into one final line audio
- A Clear audio pass (desert-ant-labs/clear model) runs on every clip before it reaches the player or a download
- Generate all stale lines with progress (4/12), per-line Regenerate in the bottom player
- Downloads: merged WAV, or a ZIP with one file per line named `1 - Ahana - Hey! AXEUS, glad to...`
- Right-click any card on the Home page to delete a script

## Setup

- Grammar fix / improve writing need `LLM_API_KEY` (Groq) in `resources/app/.env.local`
- The release ships with no API keys and no user data

## Notes

- The exe is unsigned: SmartScreen may ask about an unknown publisher on first run
- The TTS model files (downloaded separately, ~2.7 GB) must sit next to the app's `resources/models` folder
