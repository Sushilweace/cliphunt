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

/** Seconds, or null when yt-dlp cannot say. Used to reject huge videos before the download. */
export async function youtubeDuration(u) {
  const url = validateYouTubeUrl(u);
  let stdout;
  try {
    ({ stdout } = await exec('yt-dlp', ['--no-playlist', '--skip-download', '--print', '%(duration)s', url]));
  } catch (e) {
    if (/"yt-dlp" is not installed/.test(e.message)) throw new Error('yt-dlp is not installed on the server');
    throw e;
  }
  const n = Number(String(stdout).trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Downloads with yt-dlp into dir; returns the file name. Requires the user's rights confirmation upstream. */
export async function downloadYouTube(u, dir) {
  const url = validateYouTubeUrl(u);
  await exec('yt-dlp', [
    '--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4', '-o', path.join(dir, 'source.%(ext)s'), url,
  ]).catch((e) => {
    if (/"yt-dlp" is not installed/.test(e.message)) throw new Error('yt-dlp is not installed on the server');
    throw e;
  });
  const f = fs.readdirSync(dir).find((n) => n.startsWith('source.'));
  if (!f) throw new Error('Download finished but no file was found');
  return f;
}
