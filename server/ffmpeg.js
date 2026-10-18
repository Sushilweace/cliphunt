import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp'];

function findInWinGet(exe) {
  const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(root)) return null;
  for (const pkg of fs.readdirSync(root)) {
    const pkgDir = path.join(root, pkg);
    let kids = [];
    try {
      kids = fs.readdirSync(pkgDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates = [path.join(pkgDir, exe), path.join(pkgDir, 'bin', exe)];
    for (const kid of kids) {
      if (kid.isDirectory()) candidates.push(path.join(pkgDir, kid.name, 'bin', exe), path.join(pkgDir, kid.name, exe));
    }
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return null;
}

function onPath(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, exe);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function resolveTool(name) {
  const fromEnv = process.env[`${name.toUpperCase().replace(/-/g, '_')}_PATH`];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return onPath(name) || (process.platform === 'win32' ? findInWinGet(`${name}.exe`) : null) || name;
}

const bins = Object.fromEntries(TOOLS.map((name) => [name, resolveTool(name)]));
const command = (cmd) => bins[cmd] || cmd;

function toolPath() {
  const dirs = TOOLS.map((name) => (bins[name] && bins[name] !== name ? path.dirname(bins[name]) : null)).filter(Boolean);
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...dirs, ...current])].join(path.delimiter);
}

/** Run any command and collect output. */
export function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command(cmd), args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, PATH: toolPath(), ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `"${cmd}" is not installed or not on PATH` : e.message))
    );
    p.on('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`))
    );
  });
}

/** Run ffmpeg with a progress callback (0..1). */
export function ffrun(args, { cwd, duration, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command('ffmpeg'), ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, PATH: toolPath() },
    });
    let stderr = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_us=(\d+)/);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 100000) stderr = stderr.slice(-50000);
    });
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed or not on PATH' : e.message))
    );
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1800)}`))
    );
  });
}

export async function probe(file) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

export const extractWav = (src, out) =>
  ffrun(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);

/** Loudness per second (dB RMS). One signal used to rank moments. */
export async function energyPerSecond(wav) {
  const { stdout } = await exec('ffmpeg', [
    '-hide_banner', '-v', 'error', '-i', wav,
    '-af', 'asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ]);
  return [...stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => {
    const v = m[1] === '-inf' ? -90 : Number(m[1]);
    return Number.isFinite(v) ? Math.max(-90, v) : -90;
  });
}

/** Small browser-friendly copy used for previews and faster analysis. */
export const makeProxy = (src, out, onProgress, duration) =>
  ffrun(
    ['-i', src, '-vf', 'scale=-2:480,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
     '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out],
    { duration, onProgress }
  );

export const grabFrame = (src, t, out, width = 360) =>
  ffrun(['-ss', String(Math.max(0, t)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out]);
