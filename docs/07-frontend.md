# Frontend

## Files

| File | Role |
|---|---|
| `public/index.html` | Shell: new project form, project list, main area, editor section, toast |
| `public/app.js` | State, API helpers, list/main/editor rendering, recording, polling |
| `public/style.css` | Layout, cards, editor drawer, reaction dialog |

No framework and no build step. Load `/app.js` as an ES module.

## State (`app.js`)

Rough shape:

- `config`, `music`, `projects`, `pid`, `project`
- `draft` — deep copy of the clip being edited
- `origText` — transcript for caption override comparison
- `previewMode` — `original` \| `rendered`
- `recorder` — active MediaRecorder session

## Screens

1. **Home** — upload / YouTube tabs, options, rights checkbox, project list.
2. **Project** — clip grid with score, duration, Edit / React / Download.
3. **Editor drawer** — sticky header, scrollable fieldsets, fixed render footer.
4. **Play and react dialog** — video + voice-over controls side by side.

## Important behaviours

- Polls busy projects until analysis settles; refreshes clip cards during render.
- Caption proofread may switch font to **Nirmala UI** when Devanagari is detected.
- Multi-segment preview seeks each segment in order (no single `#t=` fragment).
- Recording stops when the last preview segment ends.
- Escape closes the editor unless the reaction dialog is open (dialog handles Escape first).
- Static assets are no-cache: refresh the browser after UI changes; restart the Node process after API/server changes.

## IDs to keep unique

`#pv`, `#rec-voice`, `#rec-face`, `#voice-file`, `#bubble-pos`, `#react-place`, `#tts-text`, `#react-pop`, `#open-react`.

## Related docs

- [Editor and render](05-editor-and-render.md)
- [API reference](06-api-reference.md)
