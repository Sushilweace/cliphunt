# Product overview

## What Cliphunt is

Cliphunt is a **local-first** web app: long video in, short vertical (or square / landscape) clips out. You upload a file or paste a YouTube link you have rights to. The server finds strong moments, then you edit and render each clip.

- Product name: **Cliphunt**
- Package name: `cliphunt`
- Default URL: `http://localhost:3000`
- No npm dependencies; Node 20+ and ffmpeg are required

## Who it is for

Creators and editors who want short-form clips from podcasts, interviews, or their own long recordings, without sending everything to a hosted SaaS if they prefer Ollama + local Whisper.

## Main user flow

1. Confirm rights to use the video.
2. Upload a file or paste a YouTube URL (if enabled).
3. Set how many clips, length range, aspect, and optional “find me…” prompt.
4. Wait for analysis (download/proxy → transcript → highlight picking).
5. Open a clip in the editor: cut, captions, look, music, voice/reaction, post copy.
6. Render and download the MP4.

## Feature map

| Area | Behaviour |
|---|---|
| Ingest | Upload (mp4/mov/mkv/webm/…) or yt-dlp YouTube download |
| Transcript | OpenAI Whisper API, local faster-whisper, mock, or none |
| Highlights | Gemini / Anthropic / Ollama JSON picks, or heuristic / energy fallback |
| Captions | ASS burn-in: highlight, pop, karaoke, plain; proofread in same language |
| Reframe | 9:16, 1:1, 16:9; blur / crop / face crop / colour bars |
| Look | Filters, logo PNG, on-screen opener title |
| Audio | Original voice kept by default; music with auto-duck; voice-over / camera bubble |
| Supercut | Up to 12 segments per clip, played in order |
| Post | AI or fallback description + hashtags |
| Limits | Project and clip analysis token caps; max source duration |

## Design principles

- **Local-first**: works with Ollama and faster-whisper; paid keys are optional and accelerate highlights / TTS.
- **Resumable**: restart resumes analysis/render from files already on disk.
- **Editable**: AI proposes clips; the person decides titles, cuts, captions, and mix.
- **Honest limits**: no auth, no social publish, no Content ID bypass tools.

## Related docs

- [Architecture](02-architecture.md)
- [Editor and render](05-editor-and-render.md)
- [Legal and limits](10-legal-and-limits.md)
