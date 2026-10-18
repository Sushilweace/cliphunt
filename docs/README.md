# Cliphunt documentation

Cliphunt turns a long video into short clips with captions, music, and optional voice-over. These pages describe how the product works, how it is built, and how to run it.

| Document | What it covers |
|---|---|
| [01 — Product overview](01-product-overview.md) | What Cliphunt does, who it is for, feature map |
| [02 — Architecture](02-architecture.md) | Stack, folders, process model, queues |
| [03 — Setup and configuration](03-setup-and-configuration.md) | Install, `.env`, tools (ffmpeg, yt-dlp, Python) |
| [04 — Analysis pipeline](04-analysis-pipeline.md) | Ingest → transcript → highlights → clips |
| [05 — Editor and render](05-editor-and-render.md) | Clip editing UI and ffmpeg render graph |
| [06 — API reference](06-api-reference.md) | HTTP endpoints and payloads |
| [07 — Frontend](07-frontend.md) | Browser UI, editor, reaction popup |
| [08 — Data and storage](08-data-and-storage.md) | `data/`, `db.json`, project files |
| [09 — LLM and tokens](09-llm-and-tokens.md) | Providers, usage caps, what spends tokens |
| [10 — Legal and limits](10-legal-and-limits.md) | Rights, YouTube, music, what is not built |

Start with the product overview, then setup. Use the API and architecture docs when changing code.
