# API reference

Base URL: `http://localhost:3000`. JSON bodies unless noted. Errors: `{ "error": "message" }`.

## Config and assets

### `GET /api/config`

Returns runtime capabilities: `transcribe`, `llm`, `tts`, `youtube`, `llmProvider`, `maxDurationMin`, `aspects`, `filters`, `captionStyles`, `logo`, `tokenLimits`.

### `GET /api/music`

Array of `{ id, name }` for files in `data/music/`.

### `PUT /api/uploads?name=file.mp4`

Raw body = file bytes. Returns `{ uploadId, name, size }`.

### `PUT /api/brand/logo`

Raw PNG body (max 5 MB). Stored as `data/brand/logo.png`.

## Projects

### `POST /api/projects`

```json
{
  "rightsConfirmed": true,
  "title": "Optional",
  "uploadId": "...",
  "youtubeUrl": "https://...",
  "options": {
    "count": 5,
    "minLen": 20,
    "maxLen": 60,
    "prompt": "moments about money",
    "aspect": "9:16"
  }
}
```

Requires `rightsConfirmed`. Provide either `uploadId` or `youtubeUrl`. Enqueues analysis. Returns public project (clips may be empty).

### `GET /api/projects`

List with `clipCount`, newest first.

### `GET /api/projects/:id`

Project plus sorted clips (by score).

### `DELETE /api/projects/:id`

Cancels clips, deletes DB rows and project folder.

## Clips

### `GET /api/clips/:id/words`

`{ "text": "…" }` — transcript text for the clip’s segments.

### `PATCH /api/clips/:id`

Partial update: `segments`, `aspect`, `title`, `hook`, `description`, `hashtags`, `settings` (merged + sanitized).

### `POST /api/clips/:id/render`

Queues render. `409` if already queued/rendering.

### `PUT /api/clips/:id/voice?kind=voice|face&ext=webm`

Raw media body. Probes for audio; sets `clip.voice`.

### `DELETE /api/clips/:id/voice`

Removes voice file and clears `clip.voice`.

### `POST /api/clips/:id/tts`

```json
{ "text": "script", "voice": "optional" }
```

Needs OpenAI TTS. Writes `voice_<id>.mp3`.

### `POST /api/clips/:id/describe`

LLM post copy. Charges project/clip usage. `429` at project token cap. Updates `description` and `hashtags`.

### `POST /api/clips/:id/proofread`

```json
{ "text": "caption text" }
```

Same-language spelling/grammar fix. Returns `{ text, usage, projectUsage }`. `429` at project cap.

## Media

### `GET /media/:projectId/...`

Range-capable file serve under the project directory only (path-traversal checked).

### `GET /music/:filename`

Serve a music library file.

### Static

`GET /` and other paths under `public/` with `cache-control: no-cache`.

## Related docs

- [Analysis pipeline](04-analysis-pipeline.md)
- [Data and storage](08-data-and-storage.md)
