# Cliphunt

Long video in, short vertical clips out. Upload a file or paste a YouTube link, the app finds the best moments,
and each one becomes a clip with captions, an opener, filters, music and optional voice-over.

Zero npm dependencies. You need Node 20+ and ffmpeg. A paid API key is optional.

**Full documentation** (product, architecture, setup, pipeline, editor, API, frontend, data, LLM, legal) lives in [`docs/`](docs/README.md).

## Run it with no paid key

Ollama does the clip picking on your own machine. faster-whisper does the transcript. Neither one needs an OpenAI or Anthropic account.

```bash
# one time. On a 4 GB GPU, llama3.2:3b is the model that fits. A 7B model runs half on the CPU and is slower.
pip install faster-whisper opencv-python

# .env
TRANSCRIBE_PROVIDER=local
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:3b
OLLAMA_NUM_CTX=8192
```

Then `npm start`. If Ollama is not running, clip picking falls back to a transcript heuristic, so the app still finishes. Text-to-speech still needs `OPENAI_API_KEY`; skip that and record your own voice instead. On this PC, `llama3.2:3b` is the local model to use: it fits the 4 GB GPU and returned valid clip JSON in about 14 seconds. `qwen2.5-coder:7b` also returned JSON, but took about 40 seconds because only part of it fits on the GPU.

## Gemini, when you want the highlight step to be fast

A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) works. A Gemini Advanced chat subscription does not; the app calls the API, not the website.

```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash
```

With `LLM_PROVIDER=auto`, a Gemini key is used ahead of Anthropic and Ollama. Flash answers a transcript window in a few seconds and three windows run at once. Local `llama3.2:3b` often takes a minute or more per window and runs one at a time. Paid API billing is what keeps that from stalling on the free rate limit. Rendering and local transcription do not get faster; those are ffmpeg and Whisper, not the chat model.

## Run it

```bash
cp .env.example .env        # then fill in the keys you have (all optional)
npm start                   # reads .env itself, http://localhost:3000
npm test                    # end-to-end check with fake transcription, no keys needed
```

Install: `ffmpeg` (with libx264, libass, libmp3lame). Optional: `yt-dlp` (YouTube links),
`pip install opencv-python` (face-aware crop), `pip install faster-whisper` (free local transcription).

## What works today

| Feature | How it is done |
|---|---|
| Upload or YouTube link | Raw upload with progress; yt-dlp for links (needs rights confirmation) |
| Speech to text with word timing | OpenAI Whisper API, local faster-whisper, or a mock for testing |
| Best-moment detection and ranking | Gemini Flash, Claude, or local Ollama. Scores hook/emotion/clarity/share, blended with audio loudness. If the model is down: a transcript heuristic. Without a transcript: loudness only |
| Custom "find me..." prompt | Added to the AI instruction |
| Titles and on-screen opener | AI title and hook per clip, editable, burned in with fade |
| Animated captions | Word-by-word ASS subtitles: highlight, pop, karaoke, plain. Font, size, colours, position, caps, words per line, text fixes |
| 9:16, 1:1, 16:9 | Per clip |
| Blurred background / crop / crop to face / solid bars | ffmpeg; face crop uses OpenCV on the clip's first segment |
| Filters | 8 looks (vivid, warm, cool, B&W, cinematic, punch, vintage) |
| Music with auto-ducking | Built-in synthetic pads, or drop your licensed files in `data/music` |
| Voice-over and react | Record mic or camera in the browser, upload, or AI voice (TTS). Original audio ducks under you. Camera shows as a round bubble |
| Supercuts | A clip is a list of segments, joined in order |
| Logo overlay | Upload a PNG once |
| Post description and hashtags | AI or keyword fallback, with copy button |
| Thumbnails, progress, download | Yes |

## Not built yet (honest list)

- Live per-speaker tracking and multi-person grid layouts. Crop-to-face is one position per clip (the position is now converted into the real crop window).
  Upgrade path: replace `tools/face_center.py` with a tracker that writes a per-second timeline, and drive the crop with ffmpeg `sendcmd`.
- Speaker labels (needs a diarization provider such as Deepgram, AssemblyAI or pyannote).
- Realtime livestream clipping.
- Direct posting and scheduling. Needs app review from TikTok, Meta and Google. Download and post manually until then.
- AI-generated music, scene transitions, intro/outro, brand preset library, accounts and payments.
- Login. Do not expose this to the internet as is.

## How it is organised

```
server/index.js      HTTP API, uploads, range streaming
server/pipeline.js   ingest -> proxy -> audio -> transcript -> highlights -> clips
server/transcribe.js Whisper API / local / mock, 15 minute chunks with overlap
server/highlights.js AI + heuristic ranking, snapping to sentence edges, description writer
server/captions.js   ASS builder (captions + title)
server/render.js     one ffmpeg filter graph per clip: cut, reframe, filter, logo, bubble, captions, audio mix
server/llm.js        Anthropic or local Ollama, strict JSON parsing
server/queue.js      in-process queue (swap for BullMQ/Redis when you scale)
server/store.js      JSON file database (swap for Postgres when you scale)
public/              the web app (plain JS, no build step)
tools/               python helpers
```

Data lives in `data/` (database, uploads, projects, music). Delete a project in the UI to free its disk.

## API

`GET /api/config` · `PUT /api/uploads?name=` · `POST /api/projects` · `GET /api/projects[/:id]` · `DELETE /api/projects/:id`
`PATCH /api/clips/:id` · `POST /api/clips/:id/render` · `PUT|DELETE /api/clips/:id/voice` · `POST /api/clips/:id/tts`
`POST /api/clips/:id/describe` · `GET /api/clips/:id/words` · `PUT /api/brand/logo` · `GET /api/music`

## Scaling path

1. Postgres instead of `db.json`, S3/R2 instead of local disk (presigned uploads).
2. BullMQ + Redis; run render workers as separate containers that autoscale on queue depth.
3. Auth (Clerk/Auth.js) and a credits ledger in Stripe.
4. GPU worker for local Whisper and face tracking.

## Legal

- Downloading YouTube videos is restricted by YouTube's Terms of Service unless you own the content or have
  permission. The app requires a rights confirmation, but that does not make a download lawful. Set
  `ENABLE_YOUTUBE=0` to switch YouTube links off and keep file upload only.
- Only use music you are licensed to use. The built-in pads are synthetic and free of third-party rights.
- Videos contain faces and voices: add a privacy policy and a deletion process before you offer this to others.
