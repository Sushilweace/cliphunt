import fs from 'node:fs';
import path from 'node:path';
import { ffrun, exec } from './ffmpeg.js';
import { pythonCmd } from './python.js';

const CHUNK = Number(process.env.TRANSCRIBE_CHUNK_SEC || 900); // 15 min stays under the 25 MB API limit
const OVERLAP = 8; // seconds repeated so a word on the cut is not lost

export function transcribeProvider() {
  return process.env.TRANSCRIBE_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'none');
}

/**
 * Returns { language, segments:[{start,end,text,words:[{w,s,e}]}] } or null when disabled.
 */
export async function transcribe(wav, workDir, duration, onProgress = () => {}, opts = {}) {
  const provider = transcribeProvider();
  if (provider === 'none') return null;
  if (provider === 'mock') return mock(duration);
  if (provider === 'local') return local(wav, opts);
  if (provider === 'openai') return openai(wav, workDir, duration, onProgress, opts);
  throw new Error(`Unknown TRANSCRIBE_PROVIDER "${provider}"`);
}

async function openai(wav, workDir, duration, onProgress) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const offsets = [];
  const step = Math.max(30, CHUNK - OVERLAP);
  for (let o = 0; o < duration; o += step) offsets.push(o);
  const results = new Array(offsets.length);
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < offsets.length) {
      const i = next++;
      const off = offsets[i];
      const mp3 = path.join(workDir, `chunk_${i}.mp3`);
      await ffrun(['-ss', String(off), '-t', String(CHUNK), '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', mp3]);
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(mp3)]), 'chunk.mp3');
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      if (process.env.TRANSCRIBE_LANGUAGE) fd.append('language', process.env.TRANSCRIBE_LANGUAGE);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
      });
      if (!r.ok) throw new Error(`Transcription ${r.status}: ${(await r.text()).slice(0, 300)}`);
      results[i] = { off, data: await r.json() };
      fs.unlinkSync(mp3);
      onProgress(++done / offsets.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return mergeWhisper(results, OVERLAP);
}

function mergeWhisper(results, overlap) {
  const ordered = results.filter(Boolean).sort((a, b) => a.off - b.off);
  const segments = [];
  let language = 'en';
  ordered.forEach(({ off, data }, i) => {
    language = data.language || language;
    // Keep the earlier chunk's copy of the overlap so words are not doubled.
    const keepFrom = i === 0 ? -1 : off + overlap;
    const words = (data.words || [])
      .map((w) => ({ w: w.word.trim(), s: w.start + off, e: w.end + off }))
      .filter((w) => w.s >= keepFrom - 0.05);
    for (const s of data.segments || []) {
      const start = s.start + off;
      const end = s.end + off;
      if ((start + end) / 2 < keepFrom) continue;
      segments.push({
        start,
        end,
        text: s.text.trim(),
        words: words.filter((w) => (w.s + w.e) / 2 >= start - 0.05 && (w.s + w.e) / 2 < end + 0.05),
      });
    }
  });
  segments.sort((a, b) => a.start - b.start);
  return { language, segments };
}

async function local(wav, opts = {}) {
  const script = path.resolve('tools/transcribe_local.py');
  const { stdout } = await exec(pythonCmd(), [script, wav, process.env.LOCAL_WHISPER_MODEL || 'small'], opts);
  return JSON.parse(stdout);
}

// Fake speech for testing the rest of the pipeline without any API key.
function mock(duration) {
  const lorem = 'this is the part where everything changes and honestly nobody expected it to work like that but here we are talking about the big idea behind the whole thing why does it matter because it saves hours every single week'.split(' ');
  const segments = [];
  let t = 0;
  let k = 0;
  while (t < duration - 1) {
    const words = [];
    let s = t;
    for (let i = 0; i < 12 && s < duration - 0.5; i++) {
      const w = lorem[k++ % lorem.length];
      words.push({ w: i === 11 ? w + '.' : w, s, e: s + 0.38 });
      s += 0.42;
    }
    segments.push({ start: t, end: s, text: words.map((w) => w.w).join(' '), words });
    t = s + 0.6;
  }
  return { language: 'en', segments };
}
