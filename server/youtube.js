import fs from 'node:fs';
import path from 'node:path';
import { exec } from './ffmpeg.js';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

export const youtubeEnabled = () => process.env.ENABLE_YOUTUBE !== '0';

export function validateYouTubeUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Error('That does not look like a valid link');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname)) {
    throw new Error('Only YouTube links are supported');
  }
  return url.toString();
}

export function getYouTubeCookiePath() {
  const configured = process.env.YOUTUBE_COOKIES_FILE;
  if (configured) {
    const abs = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
    if (fs.existsSync(abs)) return abs;
  }
  const defaultFile = path.join(process.cwd(), 'cookies.txt');
  if (fs.existsSync(defaultFile)) return defaultFile;
  return null;
}

export function hasYouTubeCookies() {
  return Boolean(getYouTubeCookiePath()) || Boolean(process.env.YOUTUBE_COOKIES_BROWSER);
}

export function getYouTubeCookiesInfo() {
  const p = getYouTubeCookiePath();
  if (!p || !fs.existsSync(p)) {
    return { active: false, size: 0, mtime: null, path: null };
  }
  const stat = fs.statSync(p);
  return {
    active: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    path: path.basename(p),
  };
}

export function saveYouTubeCookies(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Cookies content cannot be empty');
  }
  const defaultFile = path.join(process.cwd(), 'cookies.txt');
  fs.writeFileSync(defaultFile, content.trim() + '\n', 'utf8');
  return getYouTubeCookiesInfo();
}

export function deleteYouTubeCookies() {
  const p = getYouTubeCookiePath();
  if (p && fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  return { active: false, size: 0, mtime: null, path: null };
}

export function getYouTubeDlArgs() {
  const extra = [];
  const cookiePath = getYouTubeCookiePath();
  if (cookiePath) {
    extra.push('--cookies', cookiePath);
  } else if (process.env.YOUTUBE_COOKIES_BROWSER) {
    extra.push('--cookies-from-browser', process.env.YOUTUBE_COOKIES_BROWSER);
  }

  if (process.env.YOUTUBE_PROXY) {
    extra.push('--proxy', process.env.YOUTUBE_PROXY);
  }

  if (process.env.YOUTUBE_EXTRACTOR_ARGS) {
    extra.push('--extractor-args', process.env.YOUTUBE_EXTRACTOR_ARGS);
  }

  return extra;
}

export function formatYtDlpError(err) {
  const msg = err?.message || String(err || '');
  if (/"yt-dlp" is not installed/.test(msg)) {
    return new Error('yt-dlp is not installed on the server');
  }
  if (/Sign in to confirm you.?re not a bot|LOGIN_REQUIRED|confirm you are not a bot|confirm your age|age.?gate/i.test(msg)) {
    const hasCookies = hasYouTubeCookies();
    if (hasCookies) {
      return new Error(
        'YouTube verification failed: The configured cookies may be expired, invalid, or lack 18+ age verification for this video. Please re-export a fresh "cookies.txt" from YouTube in your browser, or upload the video directly using the "Upload" tab.'
      );
    }
    return new Error(
      'YouTube verification required ("Sign in to confirm you\'re not a bot" or Age Restriction). YouTube blocked automated access for this video.\n\n' +
      'How to solve:\n' +
      '1. [Recommended & Fastest] Direct Upload: Switch to the "Upload a file" tab and choose the video file directly (100% bypasses YouTube checks).\n' +
      '2. Cookies authentication: Click "Cookies Setup" to upload or paste your YouTube "cookies.txt" file (using the "Get cookies.txt locally" extension), then click "Retry".'
    );
  }
  if (/Video unavailable/i.test(msg)) {
    return new Error('This YouTube video is unavailable, private, or has been removed.');
  }
  if (/Private video/i.test(msg)) {
    return new Error('This YouTube video is private. Please provide a public or unlisted video URL.');
  }
  return err;
}

/** Verifies configured cookies by attempting a lightweight metadata check on YouTube */
export async function testYouTubeCookies() {
  const cookiePath = getYouTubeCookiePath();
  if (!cookiePath) {
    throw new Error('No cookies configured to test. Upload or paste cookies.txt first.');
  }
  const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  try {
    const { stdout } = await exec(
      'yt-dlp',
      ['--cookies', cookiePath, '--no-playlist', '--skip-download', '--print', '%(title)s', testUrl],
      { timeout: 15000 }
    );
    return { ok: true, title: String(stdout).trim() };
  } catch (e) {
    throw formatYtDlpError(e);
  }
}

/** Seconds, or null when yt-dlp cannot say. Used to reject huge videos before the download. */
export async function youtubeDuration(u, opts = {}) {
  const url = validateYouTubeUrl(u);
  let stdout;
  try {
    const args = [...getYouTubeDlArgs(), '--no-playlist', '--skip-download', '--print', '%(duration)s', url];
    ({ stdout } = await exec('yt-dlp', args, opts));
  } catch (e) {
    throw formatYtDlpError(e);
  }
  const n = Number(String(stdout).trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Downloads with yt-dlp into dir; returns the file name. Requires the user's rights confirmation upstream. */
export async function downloadYouTube(u, dir, opts = {}) {
  const url = validateYouTubeUrl(u);
  const args = [
    ...getYouTubeDlArgs(),
    '--no-playlist',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(dir, 'source.%(ext)s'),
    url,
  ];
  try {
    await exec('yt-dlp', args, opts);
  } catch (e) {
    throw formatYtDlpError(e);
  }
  const f = fs.readdirSync(dir).find((n) => n.startsWith('source.'));
  if (!f) throw new Error('Download finished but no file was found');
  return f;
}
