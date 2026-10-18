# Editor and render

## Clip settings (defaults)

From `defaultSettings()` in `pipeline.js`, sanitized by `settings.js` before save and again at render:

| Group | Keys | Notes |
|---|---|---|
| Frame | `bg`, `cropX`, `fitColor` | `blur` \| `crop` \| `smart` \| `fit` |
| Look | `filter`, `logo`, `title` | Filters from `FILTERS` in `render.js` |
| Captions | style, font, size, colours, position, upper, maxWords, textOverride | ASS via `captions.js` |
| Music | `track`, `volume` | File basename under `data/music` |
| Voice | `mode`, `volume` | `duck` \| `mute` when a voice-over exists |
| Mix | `originalVolume` | Original video audio gain (default 1; not all controls exposed in UI) |
| Bubble | `x`, `y`, `size` | Reaction overlay; only when face+video recording |

Aspect is stored on the clip (`9:16`, `1:1`, `16:9`), not only in settings.

## Editor UI (high level)

Side drawer `#editor`:

- Title and on-screen opener
- Cut (segments / supercut)
- Captions + **Fix spelling and grammar** (LLM proofread, same language)
- Look (filter, logo)
- Music track + volume
- **Play video and record a reaction** → modal `#react-pop` with preview + voice/reaction controls
- Post copy (describe / hashtags)
- Footer: render progress, download, **Render clip**

Clip cards also have **React** to open the editor and show the reaction popup immediately.

## Reaction popup

Dialog shows:

- Video preview (`#pv`) with original range vs rendered
- Record voice / record with camera / upload
- Original sound duck or mute, voice volume
- Bubble corner + size after a camera take with video
- Optional TTS script (needs OpenAI TTS)

Recording plays the clip while capturing; take aligns to the start of the clip timeline.

## Render graph (`renderClip`)

One ffmpeg `-filter_complex` per clip:

1. **Cut** — lead-in seek then `trim` / `atrim` per segment; segments concatenated.
2. **Reframe** — blur background, hard crop, smart face crop (`cropFraction` + OpenCV sample), or pad with colour.
3. **Filter** — optional colour look.
4. **Logo** — optional PNG overlay.
5. **Reaction bubble** — circular crop overlay when `voice.kind === 'face'` and `hasVideo`.
6. **Captions / title** — ASS burned with `fontsdir` escaped for Windows.
7. **Audio** — original at `originalVolume` (0 if mute mode); voice-over with sidechain duck on original; music looped with sidechain duck under speech; fades on music.

Output: `data/projects/<id>/clips/<clipId>.mp4` plus a JPEG thumbnail. Progress is saved about once per second; cancel if clip deleted or `cancelled`.

## Face crop note

OpenCV returns a frame-relative centre. `cropFraction()` converts that into the leftover-strip fraction ffmpeg expects. Position is **static** for the clip (sampled from early frames of the first segment), not a moving timeline.

## Music

- Built-in synthetic pads (calm / bright / tense) if missing.
- User files in `data/music/` listed by `GET /api/music`.
- No in-app AI music generator yet.

## Related docs

- [Frontend](07-frontend.md)
- [API reference](06-api-reference.md)
- [Legal and limits](10-legal-and-limits.md)
