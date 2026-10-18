# Analysis pipeline

Entry point: `runAnalysis(projectId)` in `server/pipeline.js`, enqueued from `POST /api/projects`.

## Stages

Progress and `stage` strings are written to the project record so the UI can poll.

| Step | What happens | Skip if present |
|---|---|---|
| 1. Ingest | YouTube: duration check then yt-dlp → `source.*`. Upload: move file into project folder | Existing `source.*` |
| 2. Probe | ffprobe: duration, size, audio flag; enforce `MAX_DURATION_MIN` | — |
| 3. Proxy | Browser-friendly `proxy.mp4` | `proxy.mp4` |
| 4. Audio | 16 kHz wav for Whisper; optional `energy.json` loudness curve | `transcript.json` / `energy.json` |
| 5. Transcribe | Word-timed transcript (chunked) | `transcript.json` |
| 6. Highlights | LLM windows and/or heuristic + energy → clip candidates | If clips already exist → mark ready and return |
| 7. Clip records | Create `db.clips` entries with default settings, titles, hooks | — |
| 8. Optional | `AUTO_RENDER=1` queues highest-scoring clip | — |

## Transcription details

`server/transcribe.js`:

- Chunk length default ~900s with ~8s overlap; later chunks drop words before `offset + overlap` so boundaries do not double-count.
- Providers: OpenAI Whisper API, local `tools/transcribe_local.py` (CPU int8 by default when CUDA libs are missing), mock for tests.
- Local script patches PyAV open for `metadata_errors` compatibility with some faster-whisper versions.

## Highlight details

`server/highlights.js`:

- LLM asked for JSON shaped like `{"clips":[...]}` (object required for Ollama JSON mode).
- Parallelism: 1 window when provider is Ollama, else up to 3.
- Scores blend model fields (hook / emotion / clarity / share) with audio energy.
- Custom project prompt is appended to the instruction.
- `onUsage` can stop further windows when the project token cap is hit.
- Fallbacks: transcript heuristic if LLM fails; energy-only peaks if there is no transcript.

## Resume behaviour

On process restart, `store.js` collects `resumeProjectIds` / `resumeRenderIds`. Finished file stages are not redone. Delete project cancels in-flight work (`cancelled` on clips) and removes the project directory.

## Errors you may see

| Symptom | Typical cause |
|---|---|
| `"yt-dlp" is not installed` | Binary missing, or only the exact ENOENT message is rewritten; merge failures need ffmpeg on child PATH |
| `import av` / faster_whisper missing | Wrong Python on PATH; fix via `python.js` / install into the resolved interpreter |
| No usable moments | LLM returned empty / invalid JSON and heuristic found nothing |
| Video too long | Raise `MAX_DURATION_MIN` |

## Related docs

- [Architecture](02-architecture.md)
- [LLM and tokens](09-llm-and-tokens.md)
- [Data and storage](08-data-and-storage.md)
