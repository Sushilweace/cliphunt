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
import { registerTask, unregisterTask, listTasks, cancelTask, cancelAllTasks } from './tasks.js';
import { clipWords, CAPTION_STYLES } from './captions.js';
import { describeClip, proofreadCaption } from './highlights.js';
import { ensureMusic, listMusic } from './music.js';
import { transcribeProvider } from './transcribe.js';
import { llmEnabled, llmProvider } from './llm.js';
import { sanitizeSettings } from './settings.js';
import { speak, ttsEnabled } from './tts.js';
import { tokenLimits, addUsage, blankUsage } from './usage.js';
import {
  youtubeEnabled,
  validateYouTubeUrl,
  hasYouTubeCookies,
  getYouTubeCookiesInfo,
  saveYouTubeCookies,
  deleteYouTubeCookies,
  testYouTubeCookies,
} from './youtube.js';
import {
  getYouTubeStatus,
  getYouTubeAuthUrl,
  exchangeYouTubeCode,
  disconnectYouTube,
  saveYouTubeCredentials,
  uploadShortToYouTube,
} from './youtube_api.js';

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
    youtubeStatus: getYouTubeStatus(),
    youtubeCookiesConfigured: hasYouTubeCookies(),
    llmProvider: llmProvider(),
    autoFixCaptions: process.env.AUTO_FIX_CAPTIONS !== '0',
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
  analysisQueue(() => runAnalysis(id), id);
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

route('POST', '/api/projects/(\\w+)/apply-settings', async (req, res, m) => {
  const p = db.projects[m[1]];
  if (!p) return fail(res, 404, 'Project not found');
  const b = await readJSON(req);
  if (!b.settings) return fail(res, 400, 'Settings required');
  sanitizeSettings(b.settings);
  let updatedCount = 0;
  for (const c of Object.values(db.clips)) {
    if (c.projectId === p.id) {
      c.settings = JSON.parse(JSON.stringify(b.settings));
      if (b.aspect) c.aspect = b.aspect;
      updatedCount++;
    }
  }
  save();
  send(res, 200, { ok: true, updatedCount });
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
    const ctrl = new AbortController();
    registerTask(`render-${c.id}`, ctrl, { type: 'render', targetId: c.id, projectId: c.projectId });
    c.status = 'rendering';
    try {
      await renderClip(c.id, { signal: ctrl.signal });
    } catch (e) {
      if (!db.clips[c.id] || c.cancelled || ctrl.signal.aborted) return;
      console.error('[render]', e.message);
      c.status = 'error';
      c.error = e.message.slice(-600);
      save();
    } finally {
      unregisterTask(`render-${c.id}`);
    }
  }, c.id);
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

route('POST', '/api/projects/(\\w+)/proofread-captions', async (req, res, m) => {
  const p = db.projects[m[1]];
  if (!p) return fail(res, 404, 'Project not found');
  const t = sourceTranscript(p.id);
  if (!t) return fail(res, 400, 'No transcript found for this project');
  if (!llmEnabled()) return fail(res, 400, 'AI proofreading requires an active LLM provider');

  const clips = Object.values(db.clips).filter((c) => c.projectId === p.id);
  if (!clips.length) return fail(res, 400, 'No clips found for this project');

  let fixedCount = 0;
  await Promise.all(
    clips.map(async (c) => {
      try {
        const rawWords = clipWords(t, c.segments);
        const rawText = rawWords.map((w) => w.w).join(' ').trim();
        const textToFix = (c.settings?.captions?.textOverride || rawText).trim();
        if (!textToFix) return;
        const fixed = await proofreadCaption(textToFix);
        if (fixed?.text) {
          c.settings.captions.textOverride = fixed.text;
          if (/[\u0900-\u097F]/.test(fixed.text)) {
            c.settings.captions.font = 'Nirmala UI';
          }
          if (fixed.usage) {
            c.usage = addUsage(c.usage || blankUsage(), fixed.usage);
            p.usage = addUsage(p.usage || blankUsage(), fixed.usage);
          }
          fixedCount++;
        }
      } catch (err) {
        console.warn(`[captions] Proofread failed for clip ${c.id}:`, err.message);
      }
    })
  );
  save();
  send(res, 200, { ok: true, fixedCount, project: publicProject(p) });
});

// ---------- background tasks management ----------
route('GET', '/api/tasks', async (req, res) => {
  send(res, 200, { tasks: listTasks() });
});

route('POST', '/api/tasks/([\\w-]+)/cancel', async (req, res, m) => {
  const ok = cancelTask(m[1]);
  send(res, 200, { ok, tasks: listTasks() });
});

route('POST', '/api/tasks/cancel-all', async (req, res) => {
  const count = cancelAllTasks();
  send(res, 200, { ok: true, cancelledCount: count, tasks: listTasks() });
});

route('POST', '/api/clips/(\\w+)/cancel', async (req, res, m) => {
  cancelTask(`render-${m[1]}`);
  const c = db.clips[m[1]];
  send(res, 200, { ok: true, clip: c ? publicClip(c) : null });
});

route('POST', '/api/projects/(\\w+)/cancel', async (req, res, m) => {
  cancelTask(`analysis-${m[1]}`);
  const p = db.projects[m[1]];
  send(res, 200, { ok: true, project: p ? publicProject(p) : null });
});

route('POST', '/api/projects/(\\w+)/retry', async (req, res, m) => {
  const p = db.projects[m[1]];
  if (!p) return fail(res, 404, 'Project not found');
  cancelTask(`analysis-${p.id}`);
  p.cancelled = false;
  p.error = null;
  p.status = 'queued';
  p.stage = 'Waiting';
  p.progress = 0;
  save();
  analysisQueue(() => runAnalysis(p.id), p.id);
  send(res, 200, { ok: true, project: publicProject(p) });
});

route('GET', '/api/youtube/status', async (req, res) => {
  send(res, 200, getYouTubeStatus());
});

route('POST', '/api/youtube/credentials', async (req, res) => {
  const b = await readJSON(req);
  saveYouTubeCredentials({
    clientId: b.clientId,
    clientSecret: b.clientSecret,
    redirectUri: b.redirectUri,
  });
  send(res, 200, getYouTubeStatus());
});

route('GET', '/api/youtube/auth-url', async (req, res, m, url) => {
  try {
    const host = req.headers.host;
    const redirect = url.searchParams.get('redirectUri');
    const authData = getYouTubeAuthUrl(host, redirect);
    send(res, 200, authData);
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', '/api/youtube/callback', async (req, res, m, url) => {
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<h2>YouTube authorization failed</h2><p>${err}</p><p><a href="/">Back to Cliphunt</a></p>`);
  }
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h2>Missing code parameter</h2><p><a href="/">Back to Cliphunt</a></p>');
  }
  try {
    const host = req.headers.host;
    const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
    const redirectUri = `${proto}://${host}/api/youtube/callback`;
    await exchangeYouTubeCode(code, redirectUri);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:30px;text-align:center"><h2>YouTube Connected!</h2><p>Your channel is now linked to Cliphunt.</p><script>if (window.opener) { window.opener.postMessage({ type: 'youtube-connected' }, '*'); window.close(); } else { window.location.href = '/?youtube=connected'; }</script></body></html>`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>Connection error</h2><p>${e.message}</p><p><a href="/">Back to Cliphunt</a></p>`);
  }
});

route('POST', '/api/youtube/disconnect', async (req, res) => {
  disconnectYouTube();
  send(res, 200, getYouTubeStatus());
});

route('GET', '/api/youtube/cookies', async (req, res) => {
  send(res, 200, getYouTubeCookiesInfo());
});

route('POST', '/api/youtube/cookies', async (req, res) => {
  try {
    const b = await readJSON(req);
    const text = b.cookies || b.content || '';
    const info = saveYouTubeCookies(text);
    send(res, 200, { ok: true, ...info });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', '/api/youtube/cookies', async (req, res) => {
  const info = deleteYouTubeCookies();
  send(res, 200, { ok: true, ...info });
});

route('POST', '/api/youtube/cookies/test', async (req, res) => {
  try {
    const resTest = await testYouTubeCookies();
    send(res, 200, { ok: true, message: `Verified! YouTube accepted session (Sample: "${resTest.title}").` });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', '/api/clips/(\\w+)/youtube', async (req, res, m) => {
  const c = getClip(res, m[1]);
  if (!c) return;
  if (!c.outputFile) {
    return fail(res, 400, 'Render the clip first before uploading to YouTube');
  }
  if (c.youtube?.status === 'uploading') {
    return fail(res, 409, 'This clip is currently being uploaded');
  }

  const b = await readJSON(req);
  const filePath = path.join(projectDir(c.projectId), c.outputFile);
  if (!fs.existsSync(filePath)) {
    return fail(res, 404, 'Rendered video file not found on disk');
  }

  c.youtube = {
    status: 'uploading',
    progress: 0,
    publishAt: b.publishAt || null,
    privacyStatus: b.privacyStatus || (b.publishAt ? 'private' : 'public'),
    error: null,
  };
  save();

  // Asynchronous background upload
  uploadShortToYouTube({
    filePath,
    title: b.title || c.title,
    description: b.description || c.description,
    hashtags: Array.isArray(b.hashtags) ? b.hashtags : c.hashtags || [],
    publishAt: b.publishAt || null,
    privacyStatus: b.privacyStatus || 'public',
    onProgress: (pct) => {
      if (c.youtube && c.youtube.status === 'uploading') {
        c.youtube.progress = pct;
        save();
      }
    },
  }).then((result) => {
    c.youtube = {
      status: 'uploaded',
      progress: 100,
      videoId: result.id,
      videoUrl: result.videoUrl,
      publishAt: result.publishAt,
      privacyStatus: result.privacyStatus,
      uploadedAt: Date.now(),
      error: null,
    };
    save();
  }).catch((err) => {
    console.error('[youtube upload]', err);
    c.youtube = {
      status: 'error',
      progress: 0,
      error: err.message.slice(-600),
      uploadedAt: null,
    };
    save();
  });

  send(res, 200, publicClip(c));
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
  for (const id of resumeProjectIds) analysisQueue(() => runAnalysis(id), id);
  for (const id of resumeRenderIds) if (db.clips[id]) enqueueRender(db.clips[id]);
});
