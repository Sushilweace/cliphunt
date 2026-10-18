// End-to-end check: generates a video, runs the whole pipeline with fake transcription, renders a clip.
// Run: npm test   (needs ffmpeg on PATH)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJSON } from '../server/llm.js';
import { cropFraction } from '../server/crop.js';

const parsed = parseJSON('note\n```json\n{"clips":[{"start":1}]}\n```\ntrailing {not json}');
if (parsed.clips[0].start !== 1) throw new Error('parseJSON missed the fenced object');
const frac = cropFraction(0.3, 1920, 1080, 1080, 1920, 'x');
if (frac < 0.15 || frac > 0.25) throw new Error(`cropFraction expected ~0.21, got ${frac}`);

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliphunt-'));
const video = path.join(tmp, 'in.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60',
  '-f', 'lavfi', '-i', 'sine=f=300:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video]);

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT, DATA_DIR: path.join(tmp, 'data'), TRANSCRIBE_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', LLM_PROVIDER: 'none' },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => {
  const r = await fetch(BASE + p, o);
  const b = await r.json();
  if (!r.ok) throw new Error(`${p}: ${b.error}`);
  return b;
};
const post = (p, body, method = 'POST') => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function waitFor(fn, label, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await waitFor(() => fetch(BASE + '/api/config').then((r) => r.ok).catch(() => false), 'server');
  const up = await j('/api/uploads?name=in.mp4', { method: 'PUT', body: fs.readFileSync(video) });
  const p = await post('/api/projects', { uploadId: up.uploadId, rightsConfirmed: true, options: { count: 2, minLen: 10, maxLen: 25 } });
  const ready = await waitFor(async () => {
    const x = await j(`/api/projects/${p.id}`);
    if (x.status === 'error') throw new Error(x.error);
    return x.status === 'ready' && x;
  }, 'analysis');
  console.log(`analysis ok: ${ready.clips.length} clips`);
  const c = ready.clips[0];
  await post(`/api/clips/${c.id}`, { settings: { filter: 'cinematic', music: { track: 'calm-pad.m4a' }, captions: { style: 'pop' } } }, 'PATCH');
  await post(`/api/clips/${c.id}/render`, {});
  const done = await waitFor(async () => {
    const x = (await j(`/api/projects/${p.id}`)).clips.find((k) => k.id === c.id);
    if (x.status === 'error') throw new Error(x.error);
    return x.status === 'done' && x;
  }, 'render');
  const out = path.join(tmp, 'data/projects', p.id, done.outputFile);
  if (!fs.existsSync(out) || fs.statSync(out).size < 10000) throw new Error('Rendered file missing or empty');
  console.log('render ok:', out);
  console.log('PASS');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
