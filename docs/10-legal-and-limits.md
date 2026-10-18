# Legal and limits

## Rights and YouTube

- YouTube downloads are restricted by YouTube’s Terms of Service unless you own the content or have permission.
- The app requires a **rights confirmation** checkbox. That does not by itself make a download lawful.
- Set `ENABLE_YOUTUBE=0` to disable links and keep upload only.
- Prefer uploading files you own when in doubt.

## Music

- Only use tracks you are licensed to use.
- Built-in pads in `data/music/` are **synthetic** (generated sine mixes) and free of third-party music rights.
- Dropping random songs from the internet into `data/music/` does not grant a license.

## Content ID and “bypass” transforms

- Platforms can fingerprint **video and original audio**. Keeping the original voice in a render can still match the source.
- Pitch-shifting, mirroring, and speeding up are **not** features in Cliphunt. They do not reliably avoid detection and do not create a legal right to use someone else’s work.
- Cliphunt will not add tools whose purpose is to evade copyright detection.

## Privacy

Videos contain faces and voices. Before offering Cliphunt to others, add authentication, a privacy policy, and a deletion process. **Do not expose this server to the public internet as-is** (no login).

## Not built yet

- Auth, multi-user accounts, payments  
- Postgres / BullMQ / object storage  
- Speaker diarization and live speaker tracking  
- Multi-person grids, livestream clipping  
- Direct social publish / scheduling  
- AI-generated music, Remotion pipelines, intro/outro preset library  
- Moving face crop timeline (current smart crop is one static sample)

## Related docs

- [Product overview](01-product-overview.md)
- [Setup and configuration](03-setup-and-configuration.md)
