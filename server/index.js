import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { db, save, saveNow, uid, dirs, projectDir, resumeProjectIds, resumeRenderIds } from './store.js';
import { analysisQueue, renderQueue } from './queue.js';
import { runAnalysis, sourceTranscript, maxDurationSec } from './pipeline.js';
import { renderClip, FILTERS, SIZES } from './render.js';
import { clipWords, CAPTION_STYLES } from './captions.js';
import { describeClip, proofreadCaption } from './highlights.js';
import { ensureMusic, listMusic } from './music.js';
import { transcribeProvider } from './transcribe.js';
import { llmEnabled, llmProvider } from './llm.js';
import { sanitizeSettings } from './settings.js';
import { speak, ttsEnabled } from './tts.js';
import { tokenLimits, addUsage, blankUsage } from './usage.js';
import { youtubeEnabled, validateYouTubeUrl } from './youtube.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_GB || 4) * 1024 ** 3;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};

// ---------- helpers ----------
const send = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(s);
};
const fail = (res, code, msg) => send(res, code, { error: msg });

async function readJSON(req, limit = 1e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

const within = (base, target) => {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function receiveFile(req, dest, limit) {
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) req.destroy(new Error('File too large'));
  });
  await pipeline(req, fs.createWriteStream(dest));
  return size;
}

const publicClip = (c) => ({ ...c });
const publicProject = (p) => ({ ...p, clips: Object.values(db.clips).filter((c) => c.projectId === p.id).sort((a, b) => b.score - a.score).map(publicClip) });

function validSegments(segs, duration) {
  if (!Array.isArray(segs) || !segs.length || segs.length > 12) throw new Error('A clip needs 1 to 12 segments');
  let total = 0;
  const out = segs.map((g) => {
    const start = Number(g.start);
    const end = Number(g.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.5 || end - start < 1) {
      throw new Error('Each segment needs a start and end inside the video, at least 1 second long');
    }
    total += end - start;
    return { start: Math.round(start * 100) / 100, end: Math.min(duration, Math.round(end * 100) / 100) };
  });
  if (total > 600) throw new Error('Clips can be at most 10 minutes long');
  return out;
}

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const clipText = (clip) => {
  const t = sourceTranscript(clip.projectId);
  return clipWords(t, clip.segments).map((w) => w.w).join(' ');
};

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

route('GET', '/api/config', async (req, res) => {
  send(res, 200, {
    transcribe: transcribeProvider(),
    llm: llmEnabled(),
    tts: ttsEnabled(),
    youtube: youtubeEnabled(),
    llmProvider: llmProvider(),
    maxDurationMin: Math.round(maxDurationSec() / 60),
    aspects: Object.keys(SIZES),
    filters: Object.keys(FILTERS),
    captionStyles: CAPTION_STYLES,
    logo: fs.existsSync(path.join(dirs.brand, 'logo.png')),
    tokenLimits: tokenLimits(),
  });
});

route('GET', '/api/music', async (req, res) => send(res, 200, listMusic()));

route('PUT', '/api/uploads', async (req, res, m, url) => {
  const name = (url.searchParams.get('name') || 'video.mp4').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  if (!/\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a)$/i.test(name)) return fail(res, 400, 'Unsupported file type');
  const id = uid();
  const dest = path.join(dirs.uploads, `${id}${path.extname(name).toLowerCase()}`);
  try {
    const size = await receiveFile(req, dest, MAX_UPLOAD);
    db.uploads[id] = { id, name, path: dest, size };
    save();
    send(res, 200, { uploadId: id, name, size });
  } catch (e) {
    fs.rmSync(dest, { force: true });
    fail(res, 400, e.message);
  }
});

route('PUT', '/api/brand/logo', async (req, res) => {
  try {
    await receiveFile(req, path.join(dirs.brand, 'logo.png'), 5 * 1024 * 1024);
    send(res, 200, { ok: true });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

route('POST', '/api/projects', async (req, res) => {
  const b = await readJSON(req);
  if (!b.rightsConfirmed) return fail(res, 400, 'Confirm that you have the rights to use this video');
  const o = b.options || {};
  const options = {
    count: Math.min(20, Math.max(1, Number(o.count) || 5)),
    minLen: Math.min(120, Math.max(8, Number(o.minLen) || 20)),
    maxLen: Math.min(180, Math.max(15, Number(o.maxLen) || 60)),
    prompt: String(o.prompt || '').slice(0, 300),
    aspect: SIZES[o.aspect] ? o.aspect : '9:16',
  };
  if (options.maxLen <= options.minLen) options.maxLen = options.minLen + 15;
  const id = uid();
  let source;
  if (b.youtubeUrl) {
    if (!youtubeEnabled()) return fail(res, 400, 'YouTube links are turned off on this server');
    try {
      source = { type: 'youtube', url: validateYouTubeUrl(b.youtubeUrl), name: 'YouTube video' };
    } catch (e) {
      return fail(res, 400, e.message);
    }
  } else if (b.uploadId && db.uploads[b.uploadId]) {
    source = { type: 'upload', uploadId: b.uploadId, name: db.uploads[b.uploadId].name };
  } else return fail(res, 400, 'Add a video file or a YouTube link');
  db.projects[id] = { id, title: String(b.title || '').slice(0, 120), status: 'queued', stage: 'Waiting', progress: 0, source, options, createdAt: Date.now() };
  save();
  analysisQueue(() => runAnalysis(id));
  send(res, 200, publicProject(db.projects[id]));
});

route('GET', '/api/projects', async (req, res) => {
  send(res, 200, Object.values(db.projects).sort((a, b) => b.createdAt - a.createdAt).map((p) => ({ ...p, clipCount: Object.values(db.clips).filter((c) => c.projectId === p.id).length })));
});

route('GET', '/api/projects/(\\w+)', async (req, res, m) => {
  const p = db.projects[m[1]];
  if (!p) return fail(res, 404, 'Project not found');
  send(res, 200, publicProject(p));
});

route('DELETE', '/api/projects/(\\w+)', async (req, res, m) => {
  const p = db.projects[m[1]];
  if (!p) return fail(res, 404, 'Project not found');
  for (const c of Object.values(db.clips)) {
    if (c.projectId !== p.id) continue;
    c.cancelled = true;
    delete db.clips[c.id];
  }
  delete db.projects[p.id];
  fs.rmSync(projectDir(p.id), { recursive: true, force: true });
  save();
  send(res, 200, { ok: true });
});

const getClip = (res, id) => {
  const c = db.clips[id];
  if (!c) fail(res, 404, 'Clip not found');
  return c;
};

route('GET', '/api/clips/(\\w+)/words', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (c) send(res, 200, { text: clipText(c) });
});

route('PATCH', '/api/clips/(\\w+)', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  const b = await readJSON(req);
  const p = db.projects[c.projectId];
  try {
    if (b.segments) c.segments = validSegments(b.segments, p.duration);
    if (b.aspect) {
      if (!SIZES[b.aspect]) throw new Error('Unknown aspect ratio');
      c.aspect = b.aspect;
    }
    for (const k of ['title', 'hook', 'description']) if (typeof b[k] === 'string') c[k] = b[k].slice(0, 2000);
    if (Array.isArray(b.hashtags)) c.hashtags = b.hashtags.map((h) => String(h).replace(/[#\s]/g, '')).filter(Boolean).slice(0, 15);
    if (b.settings) sanitizeSettings(merge(c.settings, b.settings));
  } catch (e) {
    return fail(res, 400, e.message);
  }
  save();
  send(res, 200, publicClip(c));
});

function enqueueRender(c) {
  if (!c || c.cancelled) return;
  c.status = 'queued';
  c.progress = 0;
  c.error = null;
  save();
  renderQueue(async () => {
    if (!db.clips[c.id] || c.cancelled) return;
    c.status = 'rendering';
    try {
      await renderClip(c.id);
    } catch (e) {
      if (!db.clips[c.id] || c.cancelled) return;
      console.error('[render]', e.message);
      c.status = 'error';
      c.error = e.message.slice(-600);
      save();
    }
  });
}

route('POST', '/api/clips/(\\w+)/render', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  if (c.status === 'rendering' || c.status === 'queued') return fail(res, 409, 'This clip is already rendering');
  enqueueRender(c);
  send(res, 200, publicClip(c));
});

route('PUT', '/api/clips/(\\w+)/voice', async (req, res, m, url) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  const kind = url.searchParams.get('kind') === 'face' ? 'face' : 'voice';
  const ext = ['webm', 'mp4', 'm4a', 'wav', 'mp3', 'ogg'].includes(url.searchParams.get('ext')) ? url.searchParams.get('ext') : 'webm';
  const dir = projectDir(c.projectId);
  const rel = `voice_${c.id}.${ext}`;
  try {
    await receiveFile(req, path.join(dir, rel), 500 * 1024 * 1024);
    const { probe } = await import('./ffmpeg.js');
    const info = await probe(path.join(dir, rel));
    if (!info.hasAudio) throw new Error('The recording has no audio');
    c.voice = { file: rel, kind, hasVideo: info.hasVideo && kind === 'face', duration: info.duration };
    save();
    send(res, 200, publicClip(c));
  } catch (e) {
    fs.rmSync(path.join(dir, rel), { force: true });
    fail(res, 400, e.message);
  }
});

route('DELETE', '/api/clips/(\\w+)/voice', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  if (c.voice) fs.rmSync(path.join(projectDir(c.projectId), c.voice.file), { force: true });
  c.voice = null;
  save();
  send(res, 200, publicClip(c));
});

route('POST', '/api/clips/(\\w+)/tts', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  const b = await readJSON(req);
  if (!b.text || !String(b.text).trim()) return fail(res, 400, 'Type the voice-over script first');
  const rel = `voice_${c.id}.mp3`;
  try {
    await speak(String(b.text), b.voice, path.join(projectDir(c.projectId), rel));
    c.voice = { file: rel, kind: 'voice', hasVideo: false, tts: true };
    save();
    send(res, 200, publicClip(c));
  } catch (e) {
    fail(res, 400, e.message);
  }
});

route('POST', '/api/clips/(\\w+)/describe', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  const project = db.projects[c.projectId];
  const limits = tokenLimits();
  if (limits.project && (project.usage?.total || 0) >= limits.project) {
    return fail(res, 429, `This project has used its analysis limit of ${limits.project.toLocaleString()} tokens.`);
  }
  const d = await describeClip(clipText(c), c.title);
  c.description = d.description;
  c.hashtags = d.hashtags;
  if (d.usage) {
    c.usage = addUsage(c.usage || blankUsage(), d.usage);
    project.usage = addUsage(project.usage || blankUsage(), d.usage);
  }
  save();
  send(res, 200, publicClip(c));
});

route('POST', '/api/clips/(\\w+)/proofread', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  const project = db.projects[c.projectId];
  const limits = tokenLimits();
  if (limits.project && (project.usage?.total || 0) >= limits.project) {
    return fail(res, 429, `This project has used its analysis limit of ${limits.project.toLocaleString()} tokens.`);
  }
  const b = await readJSON(req);
  try {
    const fixed = await proofreadCaption(b.text || clipText(c));
    if (fixed.usage) {
      c.usage = addUsage(c.usage || blankUsage(), fixed.usage);
      project.usage = addUsage(project.usage || blankUsage(), fixed.usage);
      save();
    }
    send(res, 200, { text: fixed.text, usage: c.usage, projectUsage: project.usage });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// ---------- dispatcher ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.handler(req, res, m, url);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const [, , pid, ...rest] = url.pathname.split('/');
      const file = path.resolve(projectDir(pid), decodeURIComponent(rest.join('/')));
      if (!db.projects[pid] || !within(projectDir(pid), file)) return fail(res, 404, 'Not found');
      return serveFile(req, res, file);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/music/')) {
      const file = path.resolve(dirs.music, decodeURIComponent(url.pathname.slice(7)));
      return within(dirs.music, file) ? serveFile(req, res, file) : fail(res, 404, 'Not found');
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (within(PUBLIC, file)) return serveFile(req, res, file);
    }
    fail(res, 404, 'Not found');
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) fail(res, 500, e.message);
  }
});

process.on('SIGINT', () => {
  saveNow();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Cliphunt running at http://localhost:${PORT}`);
  const ai = llmEnabled() ? llmProvider() : 'heuristic';
  console.log(`Transcription: ${transcribeProvider()} | AI highlights: ${ai} | TTS: ${ttsEnabled() ? 'on' : 'off'}`);
  if (ai === 'ollama') console.log(`Ollama: ${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'} model ${process.env.OLLAMA_MODEL || 'llama3.2:3b'} (heuristic is used if it is not running)`);
  if (ai === 'gemini') console.log(`Gemini: ${process.env.GEMINI_MODEL || 'gemini-3.8-flash'}`);
  ensureMusic();
  for (const id of resumeProjectIds) analysisQueue(() => runAnalysis(id));
  for (const id of resumeRenderIds) if (db.clips[id]) enqueueRender(db.clips[id]);
});
