import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './store.js';
import { ffrun } from './ffmpeg.js';

// Three small synthetic pads so music works out of the box (no licensing questions).
// Drop your own licensed .mp3/.m4a/.wav files into data/music/ and they appear in the editor.
const PADS = {
  'calm-pad': { notes: [220, 277.18, 329.63], lp: 900, trem: '0.25:d=0.4' },
  'bright-pad': { notes: [261.63, 329.63, 392, 523.25], lp: 2400, trem: '2:d=0.5' },
  'tense-pad': { notes: [146.83, 174.61, 207.65], lp: 700, trem: '4:d=0.6' },
};

export async function ensureMusic() {
  for (const [name, p] of Object.entries(PADS)) {
    const out = path.join(dirs.music, `${name}.m4a`);
    if (fs.existsSync(out)) continue;
    const args = [];
    p.notes.forEach((f) => args.push('-f', 'lavfi', '-i', `sine=f=${f}:d=60`));
    const mix = p.notes.map((_, i) => `[${i}]`).join('');
    await ffrun([
      ...args, '-filter_complex',
      `${mix}amix=inputs=${p.notes.length}:normalize=0,lowpass=f=${p.lp},tremolo=f=${p.trem},volume=0.6,afade=t=in:d=2,afade=t=out:st=57:d=3,aformat=channel_layouts=stereo`,
      '-c:a', 'aac', '-b:a', '128k', out,
    ]).catch((e) => console.warn('[music] could not generate', name, e.message));
  }
}

export function listMusic() {
  return fs
    .readdirSync(dirs.music)
    .filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f))
    .map((f) => ({ id: f, name: f.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') }));
}
