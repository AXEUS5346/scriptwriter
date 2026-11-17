# Scriptwriter

Write multi-speaker dialogue scripts and have them voiced by TTS, in the browser.
Web app: Next.js 16 + React 19 UI, a local llama.cpp TTS engine (Maya2-Native),
and an optional speech-enhancement stage (desert-ant-labs "clear", run
directly through ONNX Runtime).

## What it does

- Script editor where every line is one dialogue clip: pick a speaker with `/`,
  insert emotion tags inline (`[excited] [sad] [whispers] [sighs] [laughs]`),
  generate per-line audio or the whole script, then download a merged WAV or a
  zip of clips (`1 - Speaker - first four words....wav`).
- Long lines are chunked (max ~30 words / 2 emotion tags per prompt), voiced as
  segments back-to-back with 150 ms gaps, and merged into one clip.
- Every clip runs through the Clear speech enhancement (denoise / dereverb /
  loudness) before it reaches the player or any download; clips are stored as
  48 kHz mono.
- AI grammar fix (Groq) on any text selection; emotion tags survive the fix.
- Lines are autosaved into `.data/scripts/<id>/` with their audio.

## Running locally

```bash
npm install
# put clear-studio.onnx into models/ (see below)
npm run build
npm run start -- -p 3060
```

Then open http://localhost:3060.

## External dependencies (not in this repo)

| piece | where | env var |
|---|---|---|
| TTS engine | `llama-tts.exe` / `llama-ttsd.exe` build of llama.cpp with TTS support | `TTS_BIN`, `TTS_DAEMON` |
| TTS model | Maya2 Native GGUF (huggingface.co/maya-research/maya2-native) | `TTS_BACKBONE`, `TTS_MMPROJ` |
| Clear model | clear-studio.onnx (huggingface.co/desert-ant-labs/clear, v0.3.0 tag) | `CLEAR_MODEL_PATH` |
| Grammar fix | Groq API key in `.env.local` (`GROQ_API_KEY`) | - |

Defaults point at this project's sibling install (`S:\Code\podcaster`); override
with the env vars above for anything else. The Clear model is fetched from the
desert-ant-labs release tag and must exist at `models/clear-studio.onnx` unless
`CLEAR_MODEL_PATH` is set.

## Notes

- One TTS instance runs on the GPU at a time; the resident daemon
  (`llama-ttsd`) stays loaded between generations and is shut down when the
  app server exits.
- Clear enhancement is reimplemented here against the exported ONNX graph
  because the desert-ant-labs JS SDK does not ship a Windows native build.
  Preprocessing follows the DeepFilterNet3 reference (MIT).
- Never commit `.env.local`.
