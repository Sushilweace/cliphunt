import fs from 'node:fs';
import path from 'node:path';
import { db, save, projectDir, dirs } from './store.js';
import { ffrun, exec, grabFrame } from './ffmpeg.js';
import { buildASS, clipWords } from './captions.js';
import { cropFraction } from './crop.js';
import { pythonCmd } from './python.js';
import { sanitizeSettings } from './settings.js';

export const SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };

// Colour looks, each is an ffmpeg filter chain.
export const FILTERS = {
  none: '',
  vivid: 'eq=contrast=1.08:saturation=1.35',
  warm: 'colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06,eq=saturation=1.1',
  cool: 'colorbalance=rs=-0.07:bs=0.09:rm=-0.05:bm=0.07,eq=saturation=1.05',
  bw: 'hue=s=0,eq=contrast=1.12',
  cinematic: 'eq=contrast=1.12:saturation=0.9:gamma=0.95,colorbalance=rs=0.05:bs=-0.04:rh=-0.03:bh=0.05,vignette=PI/5',
  punch: 'eq=contrast=1.15:saturation=1.2,unsharp=5:5:0.8',
  vintage: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,vignette=PI/4,noise=alls=8:allf=t',
};

const loadTranscript = (projectId) => {
  const f = path.join(projectDir(projectId), 'transcript.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export async function renderClip(clipId) {
  const clip = db.clips[clipId];
  if (!clip || clip.cancelled) return;
  const project = db.projects[clip.projectId];
  sanitizeSettings(clip.settings);
  const s = clip.settings;
  const dir = projectDir(project.id);
  const work = path.join(dir, 'work', clip.id);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });

  const [W, H] = SIZES[clip.aspect] || SIZES['9:16'];
  const src = path.join(dir, project.source.file);
  // Seek to 1s before the cut, then trim exactly. A seek straight to `start` lands on a keyframe and shifts captions.
  const LEAD = 1;
  const segs = clip.segments.map((g) => {
    const pre = Math.max(0, g.start - LEAD);
    return { start: g.start, end: g.end, d: g.end - g.start, pre, fine: g.start - pre };
  });
  const total = segs.reduce((a, g) => a + g.d, 0);
  const hasAudio = project.hasAudio !== false;

  // ---- captions + title ----
  const transcript = loadTranscript(project.id);
  const words = clipWords(transcript, clip.segments, s.captions?.textOverride);
  const ass = buildASS({
    W, H, words,
    cap: { ...s.captions, enabled: s.captions?.enabled !== false && words.length > 0 },
    title: { enabled: s.title?.enabled, text: s.title?.text || clip.hook || clip.title, seconds: s.title?.seconds, upper: !!s.title?.upper },
  });
  fs.writeFileSync(path.join(work, 'captions.ass'), ass);

  // ---- smart crop ----
  let cropX = num(s.cropX, 0.5);
  let cropY = 0.5;
  if (s.bg === 'smart') {
    try {
      const { stdout } = await exec(pythonCmd(), [path.resolve('tools/face_center.py'), src, String(segs[0].start), String(segs[0].end)]);
      const face = JSON.parse(stdout.trim());
      cropX = cropFraction(face.x, project.width, project.height, W, H, 'x');
      cropY = cropFraction(face.y, project.width, project.height, W, H, 'y');
    } catch {
      cropX = 0.5;
      cropY = 0.5;
    }
  }

  // ---- inputs ----
  const args = [];
  let n = 0;
  segs.forEach((g) => {
    args.push('-ss', g.pre.toFixed(3), '-t', (g.fine + g.d + 0.2).toFixed(3), '-i', src);
    n++;
  });
  let musicIdx = -1, voiceIdx = -1, logoIdx = -1;
  const musicFile = s.music?.track ? path.join(dirs.music, path.basename(s.music.track)) : null;
  if (musicFile && fs.existsSync(musicFile)) {
    args.push('-stream_loop', '-1', '-i', musicFile);
    musicIdx = n++;
  }
  const voiceFile = clip.voice ? path.join(dir, clip.voice.file) : null;
  if (voiceFile && fs.existsSync(voiceFile)) {
    args.push('-i', voiceFile);
    voiceIdx = n++;
  }
  const logoFile = path.join(dirs.brand, 'logo.png');
  if (s.logo?.enabled && fs.existsSync(logoFile)) {
    args.push('-i', logoFile);
    logoIdx = n++;
  }

  // ---- video graph ----
  const f = [];
  segs.forEach((g, i) => {
    const fine = g.fine.toFixed(3);
    const d = g.d.toFixed(3);
    f.push(`[${i}:v]trim=start=${fine}:duration=${d},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v${i}]`);
    if (hasAudio) f.push(`[${i}:a]atrim=start=${fine}:duration=${d},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(segs.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${segs.length}:v=1:a=1[vc][ac]`);

  // reframe to target aspect
  if (s.bg === 'crop' || s.bg === 'smart') {
    f.push(`[vc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(in_w-${W})*${cropX.toFixed(3)}:(in_h-${H})*${cropY.toFixed(3)}[vr]`);
  } else if (s.bg === 'fit') {
    const col = String(s.fitColor || '#000000').replace('#', '0x');
    f.push(`[vc]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${col}[vr]`);
  } else {
    f.push(`[vc]split=2[b0][f0]`);
    f.push(`[b0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:6,eq=brightness=-0.08[bgd]`);
    f.push(`[f0]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
    f.push(`[bgd][fg]overlay=(W-w)/2:(H-h)/2[vr]`);
  }
  let v = 'vr';
  const flt = FILTERS[s.filter] || '';
  if (flt) {
    f.push(`[${v}]${flt}[vf]`);
    v = 'vf';
  }
  if (logoIdx >= 0) {
    const pos = { tr: 'W-w-40:40', tl: '40:40', br: 'W-w-40:H-h-40', bl: '40:H-h-40' }[s.logo.pos] || 'W-w-40:40';
    f.push(`[${logoIdx}:v]scale=${Math.round(W * num(s.logo.size, 0.14))}:-1[lg]`);
    f.push(`[${v}][lg]overlay=${pos}[vl]`);
    v = 'vl';
  }
  // camera bubble for "react" recordings
  if (voiceIdx >= 0 && clip.voice.kind === 'face' && clip.voice.hasVideo) {
    const d = Math.round(W * num(s.bubble?.size, 0.28));
    const r = d / 2;
    f.push(`[${voiceIdx}:v]scale=-2:${d},crop=${d}:${d},format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lt(hypot(X-${r},Y-${r}),${r}),255,0)'[fb]`);
    f.push(`[${v}][fb]overlay=(W-w)*${num(s.bubble?.x, 0.88)}:(H-h)*${num(s.bubble?.y, 0.12)}:eof_action=pass[vb]`);
    v = 'vb';
  }
  const fontsdir = process.env.FONTS_DIR
    ? `:fontsdir=${process.env.FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '')}`
    : '';
  f.push(`[${v}]ass=captions.ass${fontsdir}[vout]`);

  // ---- audio graph ----
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const muteOriginal = voiceIdx >= 0 && s.voice?.mode === 'mute';
  f.push(`[ac]volume=${muteOriginal ? 0 : num(s.originalVolume, 1)}[sp0]`);
  let cur = 'sp0';
  if (voiceIdx >= 0) {
    f.push(`[${voiceIdx}:a]${fmt},atrim=0:${total.toFixed(3)},apad=whole_dur=${total.toFixed(3)},volume=${num(s.voice?.volume, 1.3)},asplit=2[vo1][vo2]`);
    f.push(`[${cur}][vo1]sidechaincompress=threshold=0.015:ratio=14:attack=10:release=350[spd]`);
    f.push(`[spd][vo2]amix=inputs=2:normalize=0:duration=longest[sp1]`);
    cur = 'sp1';
  }
  if (musicIdx >= 0) {
    f.push(`[${musicIdx}:a]${fmt},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${num(s.music.volume, 0.18)},afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[m]`);
    f.push(`[${cur}]asplit=2[spa][spb]`);
    f.push(`[m][spa]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[md]`);
    f.push(`[spb][md]amix=inputs=2:normalize=0:duration=first[aout]`);
  } else {
    f.push(`[${cur}]anull[aout]`);
  }

  const outName = `${clip.id}.mp4`;
  const outFile = path.join(dir, 'clips', outName);
  args.push(
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile
  );

  let lastSave = 0;
  await ffrun(args, {
    cwd: work,
    duration: total,
    onProgress: (p) => {
      if (clip.cancelled || !db.clips[clipId]) return;
      clip.progress = Math.round(p * 100);
      const now = Date.now();
      if (now - lastSave > 1000) {
        lastSave = now;
        save();
      }
    },
  });
  if (clip.cancelled || !db.clips[clipId]) return;

  const thumb = path.join(dir, 'clips', `${clip.id}.jpg`);
  await grabFrame(outFile, Math.min(1, total / 2), thumb, 360).catch(() => {});
  clip.outputFile = `clips/${outName}`;
  clip.renderedThumb = `clips/${clip.id}.jpg`;
  clip.renderedAt = Date.now();
  clip.status = 'done';
  clip.progress = 100;
  clip.error = null;
  fs.rmSync(work, { recursive: true, force: true });
  save();
}
