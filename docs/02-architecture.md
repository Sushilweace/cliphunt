# Architecture

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 20+ ESM (`"type": "module"`) |
| HTTP | Built-in `node:http` (no Express) |
| UI | Static HTML/CSS/JS in `public/` (no bundler) |
| Database | JSON file `data/db.json` |
| Jobs | In-process queues (`server/queue.js`) |
| Media | ffmpeg / ffprobe (discovered on PATH or WinGet) |
| YouTube | yt-dlp when `ENABLE_YOUTUBE=1` |
| Transcript | Whisper API or Python faster-whisper |
| LLM | Gemini / Anthropic / Ollama over HTTP |
| Face crop | `tools/face_center.py` + OpenCV |

Zero npm packages. Optional Python packages: `faster-whisper`, `opencv-python`.

## Folder layout

```
clipsmith/                 # workspace folder name (product is Cliphunt)
  public/                  # SPA: index.html, app.js, style.css
  server/
    index.js               # HTTP server, routes, static + media
    env.js                 # loads ../.env if vars unset
    store.js               # db.json, dirs, resume lists
    queue.js               # analysis + render queues
    pipeline.js            # analysis stages
    transcribe.js          # whisper providers + chunking
    highlights.js          # LLM + heuristic clip finding, describe, proofread
    captions.js            # ASS captions + title
    render.js              # per-clip ffmpeg filter graph
    ffmpeg.js              # tool discovery, probe, proxy, exec helpers
    youtube.js             # duration check + download
    llm.js                 # provider selection + chat
    music.js               # synthetic pads + listMusic
    tts.js                 # OpenAI TTS
    settings.js            # sanitize clip settings
    usage.js               # token buckets and caps
    crop.js                # face center → crop fraction
    python.js              # resolve Python that can import faster_whisper
  tools/
    transcribe_local.py
    face_center.py
  data/                    # runtime (gitignored): db, projects, uploads, music, brand
  docs/                    # this documentation
  test/smoke.js
```

## Process model

One Node process listens on `PORT` (default 3000).

- **Analysis queue**: one project at a time through `runAnalysis`.
- **Render queue**: clips render through `renderClip`.
- On startup, projects/clips stuck in `processing` / `rendering` / `queued` are re-queued; stages whose output files already exist are skipped.

```
Browser ──HTTP──► server/index.js
                    ├─ analysisQueue → pipeline.runAnalysis
                    ├─ renderQueue   → render.renderClip
                    ├─ LLM / Whisper / ffmpeg / yt-dlp (child processes)
                    └─ store.save → data/db.json
```

## Key modules

| Module | Responsibility |
|---|---|
| `pipeline.js` | Ingest, proxy, wav, transcript, energy, highlight → clip records |
| `render.js` | Cut segments, reframe, filter, logo, reaction bubble, ASS, audio mix |
| `highlights.js` | Windowed LLM prompts, scoring blend, snap to sentences, describe/proofread |
| `llm.js` | Returns `{ text, usage }`; never treat as a bare string |
| `ffmpeg.js` | Resolves binaries; prepends their dirs to child `PATH` so yt-dlp finds ffmpeg |

## Scaling path (not implemented)

1. Postgres instead of `db.json`; object storage instead of local `data/`.
2. BullMQ + Redis; separate render workers.
3. Auth and billing.
4. GPU workers for Whisper and tracking.

## Related docs

- [Analysis pipeline](04-analysis-pipeline.md)
- [Data and storage](08-data-and-storage.md)
- [API reference](06-api-reference.md)
