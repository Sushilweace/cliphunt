# LLM and tokens

## What uses the LLM

Only these jobs call `llm()` in `server/llm.js`:

1. **Find clips** — windowed highlight prompts during analysis  
2. **Proofread captions** — `POST /api/clips/:id/proofread`  
3. **Describe / hashtags** — `POST /api/clips/:id/describe`  

Download, Whisper, ffmpeg, music pads, and render **do not** spend LLM tokens.

## Provider selection

`LLM_PROVIDER`:

| Value | Behaviour |
|---|---|
| `auto` | Gemini if key → else Anthropic if key → else Ollama |
| `gemini` / `anthropic` / `ollama` | Force that path (or `none` if required key missing for hosted) |
| `none` | No LLM; heuristics only |

`llm()` returns `{ text, usage }`. Callers must use `.text` and `.usage`. JSON is extracted with a balanced parser (fence-aware).

## Usage accounting

- Provider metadata when available (Gemini `usageMetadata`, Anthropic `usage`, Ollama eval counts).
- Otherwise estimate ~`chars / 4`.
- Stored on `project.usage` and sometimes `clip.usage`.

## Caps

| Env | Default | Scope |
|---|---|---|
| `MAX_PROJECT_TOKENS` | `80000` | Sum of highlight windows + proofread + describe on that project |
| `MAX_CLIP_TOKENS` | `8000` | Limits highlight `maxTokens` and one post-copy style call |

- `0` disables that cap.
- Caps are **app limits**, not Gemini/Anthropic billing, and they do not expire by date.
- New project starts at 0; deleting a project removes its usage.
- Hitting the project cap during highlights stops further windows; describe/proofread return `429`.

UI shows used / cap in the project header and a note on the new-project form.

## Ollama vs Gemini (practical)

| | Ollama `llama3.2:3b` | Gemini Flash |
|---|---|---|
| Cost | Local compute | API billing |
| Speed | Often ~tens of seconds per window, serial | Seconds per window, parallel ×3 |
| Offline | Yes | No |

## Related docs

- [Setup and configuration](03-setup-and-configuration.md)
- [Analysis pipeline](04-analysis-pipeline.md)
