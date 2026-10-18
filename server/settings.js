import path from 'node:path';
import { CAPTION_STYLES } from './captions.js';

const FILTERS = new Set(['none', 'vivid', 'warm', 'cool', 'bw', 'cinematic', 'punch', 'vintage']);

const FONTS = new Set(['Arial', 'Impact', 'Verdana', 'Georgia', 'Courier New', 'DejaVu Sans', 'Nirmala UI', 'Mangal']);
const BGS = new Set(['blur', 'crop', 'smart', 'fit']);
const POS = new Set(['bottom', 'middle', 'top']);
const LOGO = new Set(['tr', 'tl', 'br', 'bl']);
const VOICE = new Set(['duck', 'mute']);
const HEX = /^#[0-9a-fA-F]{6}$/;

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};
const hex = (v, d) => (HEX.test(String(v || '')) ? String(v) : d);

/**
 * Drop anything that would be interpolated into an ffmpeg filter or an ASS style line.
 * The editor sends the whole settings object, so this runs on every save and again at render.
 */
export function sanitizeSettings(s) {
  if (!s || typeof s !== 'object') return s;
  s.bg = BGS.has(s.bg) ? s.bg : 'blur';
  s.cropX = clamp(s.cropX, 0, 1, 0.5);
  s.fitColor = hex(s.fitColor, '#000000');
  s.filter = FILTERS.has(s.filter) ? s.filter : 'none';
  s.originalVolume = clamp(s.originalVolume, 0, 2, 1);

  s.captions = s.captions && typeof s.captions === 'object' ? s.captions : {};
  const c = s.captions;
  c.enabled = c.enabled !== false;
  c.style = CAPTION_STYLES.includes(c.style) ? c.style : 'highlight';
  c.font = FONTS.has(c.font) ? c.font : 'Arial';
  c.size = clamp(c.size, 0.02, 0.1, 0.045);
  c.color = hex(c.color, '#FFFFFF');
  c.accent = hex(c.accent, '#FFD23F');
  c.position = POS.has(c.position) ? c.position : 'bottom';
  c.upper = !!c.upper;
  c.maxWords = Math.round(clamp(c.maxWords, 1, 6, 3));
  c.textOverride = String(c.textOverride || '').slice(0, 8000);

  s.title = s.title && typeof s.title === 'object' ? s.title : {};
  s.title.enabled = s.title.enabled !== false;
  s.title.text = String(s.title.text || '').slice(0, 200);
  s.title.seconds = clamp(s.title.seconds, 1, 10, 3);
  s.title.upper = !!s.title.upper;

  s.music = s.music && typeof s.music === 'object' ? s.music : {};
  s.music.track = s.music.track ? path.basename(String(s.music.track)).slice(0, 120) : '';
  s.music.volume = clamp(s.music.volume, 0, 1, 0.18);

  s.voice = s.voice && typeof s.voice === 'object' ? s.voice : {};
  s.voice.mode = VOICE.has(s.voice.mode) ? s.voice.mode : 'duck';
  s.voice.volume = clamp(s.voice.volume, 0, 3, 1.3);

  s.logo = s.logo && typeof s.logo === 'object' ? s.logo : {};
  s.logo.enabled = !!s.logo.enabled;
  s.logo.pos = LOGO.has(s.logo.pos) ? s.logo.pos : 'tr';
  s.logo.size = clamp(s.logo.size, 0.05, 0.4, 0.14);

  s.bubble = s.bubble && typeof s.bubble === 'object' ? s.bubble : {};
  s.bubble.x = clamp(s.bubble.x, 0, 1, 0.88);
  s.bubble.y = clamp(s.bubble.y, 0, 1, 0.12);
  s.bubble.size = clamp(s.bubble.size, 0.12, 0.5, 0.28);
  return s;
}
