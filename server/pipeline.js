import fs from 'node:fs';
import path from 'node:path';
import { db, save, uid, projectDir, dirs } from './store.js';
import { probe, extractWav, energyPerSecond, makeProxy, grabFrame } from './ffmpeg.js';
import { transcribe } from './transcribe.js';
import { findHighlights } from './highlights.js';
import { addUsage, blankUsage, tokenLimits } from './usage.js';
import { downloadYouTube, youtubeDuration } from './youtube.js';
import { renderQueue } from './queue.js';
import { renderClip } from './render.js';

export const maxDurationSec = () => Number(process.env.MAX_DURATION_MIN || 120) * 60;

function tooLong(seconds) {
  const max = maxDurationSec();
  if (seconds > max) {
    throw new Error(`This video is ${Math.ceil(seconds / 60)} minutes. The limit is ${Math.round(max / 60)} minutes (set MAX_DURATION_MIN to change it).`);
  }
}

export const defaultSettings = () => ({
  bg: 'blur', // blur | crop | smart | fit
  cropX: 0.5,
  fitColor: '#000000',
  filter: 'none',
  captions: {
    enabled: true,
    style: 'highlight', // highlight | pop | karaoke | plain
    font: 'Arial',
    size: 0.045,
    color: '#FFFFFF',
    accent: '#FFD23F',
    position: 'bottom',
    upper: true,
    maxWords: 3,
    textOverride: '',
  },
  title: { enabled: true, text: '', seconds: 3, upper: false },
  music: { track: '', volume: 0.18 },
  voice: { mode: 'duck', volume: 1.3 },
  originalVolume: 1,
  logo: { enabled: false, pos: 'tr', size: 0.14 },
  bubble: { x: 0.88, y: 0.12, size: 0.28 },
});

function step(p, stage, progress) {
  p.stage = stage;
  p.progress = Math.round(progress);
  save();
}

export async function runAnalysis(projectId) {
  const p = db.projects[projectId];
  const dir = projectDir(projectId);
  try {
    p.status = 'processing';
    fs.mkdirSync(dir, { recursive: true });

    // 1. Ingest. A restart skips this when the source file is already in the project folder.
    const existingSrc = p.source.file && fs.existsSync(path.join(dir, p.source.file)) ? path.join(dir, p.source.file) : null;
    let src = existingSrc;
    if (!src) {
      step(p, 'Getting the video', 2);
      if (p.source.type === 'youtube') {
        const known = await youtubeDuration(p.source.url);
        if (known) tooLong(known);
        p.source.file = await downloadYouTube(p.source.url, dir);
      } else {
        const up = db.uploads[p.source.uploadId];
        if (!up || !fs.existsSync(up.path)) throw new Error('Uploaded file not found');
        const ext = path.extname(up.name).toLowerCase() || '.mp4';
        p.source.file = `source${ext}`;
        fs.renameSync(up.path, path.join(dir, p.source.file));
        delete db.uploads[p.source.uploadId];
      }
      src = path.join(dir, p.source.file);
    }
    const info = await probe(src);
    if (!info.hasVideo) throw new Error('This file has no video stream');
    tooLong(info.duration);
    p.duration = info.duration;
    p.width = info.width;
    p.height = info.height;
    p.hasAudio = info.hasAudio;
    if (!p.title) p.title = (p.source.name || 'Untitled').replace(/\.[^.]+$/, '');
    save();

    // 2. Browser preview copy
    const proxyPath = path.join(dir, 'proxy.mp4');
    if (!fs.existsSync(proxyPath)) {
      step(p, 'Making a preview copy', 8);
      await makeProxy(src, proxyPath, (x) => step(p, 'Making a preview copy', 8 + x * 12), info.duration);
    }
    p.proxy = 'proxy.mp4';

    // 3. Audio + transcript. transcript.json is kept so a failed highlight step does not re-transcribe.
    const transcriptPath = path.join(dir, 'transcript.json');
    const energyPath = path.join(dir, 'energy.json');
    let transcript = fs.existsSync(transcriptPath) ? JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) : null;
    let energy = fs.existsSync(energyPath) ? JSON.parse(fs.readFileSync(energyPath, 'utf8')) : [];
    if (info.hasAudio && (!transcript || !energy.length)) {
      step(p, 'Reading the audio', 22);
      const wav = path.join(dir, 'audio.wav');
      await extractWav(src, wav);
      if (!energy.length) {
        energy = await energyPerSecond(wav);
        fs.writeFileSync(energyPath, JSON.stringify(energy));
      }
      if (!transcript) {
        step(p, 'Transcribing speech', 30);
        transcript = await transcribe(wav, dir, info.duration, (x) => step(p, 'Transcribing speech', 30 + x * 35));
        if (transcript) fs.writeFileSync(transcriptPath, JSON.stringify(transcript));
      }
      fs.rmSync(wav, { force: true });
    }
    p.hasTranscript = !!transcript;
    p.language = transcript?.language || null;

    const already = Object.values(db.clips).some((c) => c.projectId === projectId);
    if (already) {
      p.status = 'ready';
      p.stage = 'Ready';
      p.progress = 100;
      p.error = null;
      save();
      return;
    }

    // 4. Find moments
    step(p, 'Finding the best moments', 68);
    p.usage = p.usage || blankUsage();
    const limits = tokenLimits();
    const { clips, method } = await findHighlights({
      transcript,
      energy,
      duration: info.duration,
      opts: p.options,
      tokenBudget: limits.project,
      onUsage: (usage) => {
        p.usage = addUsage(p.usage, usage);
        save();
        if (limits.project && p.usage.total >= limits.project) {
          console.warn(`[highlights] project token limit reached (${p.usage.total}/${limits.project})`);
          return false;
        }
      },
    });
    p.method = method;
    if (!clips.length) throw new Error('No usable moments were found in this video');

    // 5. Create clips + thumbnails
    step(p, 'Preparing clips', 85);
    fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
    let i = 0;
    for (const c of clips) {
      const id = uid();
      const thumb = `thumbs/${id}.jpg`;
      await grabFrame(src, c.start + Math.min(1.5, (c.end - c.start) / 2), path.join(dir, thumb)).catch(() => {});
      db.clips[id] = {
        id,
        projectId,
        title: c.title,
        hook: c.hook,
        reason: c.reason,
        score: c.score,
        scores: c.scores,
        segments: [{ start: round(c.start), end: round(c.end) }],
        aspect: p.options.aspect || '9:16',
        settings: defaultSettings(),
        status: 'idle',
        progress: 0,
        thumb,
        description: '',
        hashtags: [],
        voice: null,
        createdAt: Date.now(),
      };
      step(p, 'Preparing clips', 85 + (++i / clips.length) * 14);
    }
    p.status = 'ready';
    p.stage = 'Ready';
    p.progress = 100;
    p.error = null;
    save();
    if (process.env.AUTO_RENDER === '1') queueTopRender(projectId);
  } catch (e) {
    console.error('[analysis]', e);
    p.status = 'error';
    p.error = e.message;
    save();
  }
}

function queueTopRender(projectId) {
  const top = Object.values(db.clips)
    .filter((c) => c.projectId === projectId && c.status === 'idle')
    .sort((a, b) => b.score - a.score)[0];
  if (!top) return;
  top.status = 'queued';
  top.progress = 0;
  save();
  renderQueue(async () => {
    if (!db.clips[top.id] || top.cancelled) return;
    top.status = 'rendering';
    try {
      await renderClip(top.id);
    } catch (e) {
      if (!db.clips[top.id] || top.cancelled) return;
      top.status = 'error';
      top.error = e.message.slice(-600);
      save();
    }
  });
}

const round = (n) => Math.round(n * 100) / 100;

export function sourceTranscript(projectId) {
  const f = path.join(projectDir(projectId), 'transcript.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export { dirs };
