# Data and storage

## Root: `DATA_DIR` (default `./data`)

| Path | Contents |
|---|---|
| `data/db.json` | Projects, clips, uploads index |
| `data/projects/<id>/` | Source, proxy, transcript, energy, voices, rendered clips |
| `data/uploads/` | Temporary uploads before attach to a project |
| `data/music/` | Library tracks + generated pads |
| `data/brand/logo.png` | Optional logo |

`data/` is gitignored. Delete a project in the UI to free its folder.

## Database shape (`db.json`)

```text
{
  projects: { [id]: Project },
  clips:    { [id]: Clip },
  uploads:  { [id]: Upload }
}
```

Writes are debounced (`save`) then atomic rename via `saveNow` (`.tmp` → `db.json`).

### Project (selected fields)

- `id`, `title`, `status`, `stage`, `progress`, `error`
- `source` — `{ type: 'upload'|'youtube', …, file? }`
- `options` — count, minLen, maxLen, prompt, aspect
- `duration`, `width`, `height`, `hasAudio`, `proxy`
- `hasTranscript`, `language`, `method` (`llm` \| `heuristic` \| …)
- `usage` — `{ input, output, total, calls }`
- `createdAt`

Statuses include `queued`, `processing`, `ready`, `error`.

### Clip (selected fields)

- `id`, `projectId`, `title`, `hook`, `reason`, `score`, `aspect`
- `segments` — `[{ start, end }, …]`
- `settings` — see editor defaults
- `voice` — `{ file, kind, hasVideo, duration?, tts? }` or null
- `description`, `hashtags`, `usage`
- `status`, `progress`, `error`, `cancelled`
- `outputFile`, `renderedThumb`, `renderedAt`

### Upload

- `id`, `name`, `path`, `size` — removed after ingest moves the file into the project.

## Project directory files

| File | Role |
|---|---|
| `source.*` | Canonical media |
| `proxy.mp4` | Browser preview |
| `transcript.json` | Word timings |
| `energy.json` | Per-second loudness |
| `voice_<clipId>.*` | Uploaded / recorded / TTS voice |
| `clips/<clipId>.mp4` | Rendered output |
| `clips/<clipId>.jpg` | Thumbnail |

## Related docs

- [Architecture](02-architecture.md)
- [Analysis pipeline](04-analysis-pipeline.md)
