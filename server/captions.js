// Builds an ASS subtitle file: animated captions + title overlay, burned in by ffmpeg/libass.

const hex2ass = (hex, alpha = 0) => {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'f');
  return `&H${alpha.toString(16).padStart(2, '0')}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase().replace('&H', '&H');
};
const ts = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const esc = (t) => String(t).replace(/[{}]/g, '').replace(/\\/g, '').replace(/\r?\n/g, '\\N');

export const CAPTION_STYLES = ['highlight', 'pop', 'karaoke', 'plain'];

function group(words, maxWords, maxChars = 24) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || chars > maxChars || w.s - prev.e > 0.6)) flush();
    cur.push(w);
    if (/[.?!]$/.test(w.w)) flush();
  }
  flush();
  return groups;
}

/**
 * words: [{w,s,e}] relative to clip start.  cap: caption settings. title: {text, seconds, enabled}.
 */
export function buildASS({ W, H, words, cap, title }) {
  const font = cap.font || 'Arial';
  const size = Math.round(H * (cap.size || 0.045));
  const primary = hex2ass(cap.color || '#FFFFFF');
  const accent = hex2ass(cap.accent || '#FFD23F');
  const outline = hex2ass('#000000');
  const marginV = cap.position === 'top' ? Math.round(H * 0.14) : cap.position === 'middle' ? 0 : Math.round(H * 0.2);
  const align = cap.position === 'top' ? 8 : cap.position === 'middle' ? 5 : 2;
  const mLR = Math.round(W * 0.07);
  const T = (x) => esc(cap.upper ? x.w.toUpperCase() : x.w);
  const out = [];
  const style = cap.style || 'highlight';

  if (cap.enabled !== false && words.length) {
    const maxWords = style === 'pop' ? 1 : Math.max(1, cap.maxWords || 3);
    for (const g of group(words, maxWords)) {
      const last = g[g.length - 1];
      if (style === 'plain') {
        out.push(ev(g[0].s, last.e + 0.1, 'Cap', g.map(T).join(' ')));
      } else if (style === 'karaoke') {
        const txt = g
          .map((w, i) => {
            const nxt = g[i + 1] ? g[i + 1].s : w.e;
            return `{\\kf${Math.max(1, Math.round((nxt - w.s) * 100))}}${T(w)}`;
          })
          .join(' ');
        out.push(ev(g[0].s, last.e + 0.1, 'Cap', txt));
      } else if (style === 'pop') {
        const w = g[0];
        out.push(ev(w.s, Math.max(w.e, w.s + 0.12) + 0.08, 'Cap', `{\\fscx70\\fscy70\\t(0,90,\\fscx112\\fscy112)\\t(90,170,\\fscx100\\fscy100)}${T(w)}`));
      } else {
        g.forEach((w, i) => {
          const end = g[i + 1] ? g[i + 1].s : w.e + 0.2;
          const txt = g
            .map((x, j) => (j === i ? `{\\c${accent}\\fscx115\\fscy115}${T(x)}{\\c${primary}\\fscx100\\fscy100}` : T(x)))
            .join(' ');
          out.push(ev(w.s, Math.max(end, w.s + 0.08), 'Cap', txt));
        });
      }
    }
  }
  if (title?.enabled && title.text) {
    const line = title.upper ? title.text.toUpperCase() : title.text;
    out.push(ev(0.1, Math.max(1, title.seconds || 3), 'Title', `{\\fad(250,250)}${esc(line)}`));
  }

  const tSize = Math.round(H * 0.04);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},${size},${style === 'karaoke' ? accent : primary},${style === 'karaoke' ? primary : accent},${outline},&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 11))},1,${align},${mLR},${mLR},${marginV},1
Style: Title,${font},${tSize},&H00FFFFFF,&H00FFFFFF,&H00000000,${hex2ass('#000000', 0x66)},-1,0,0,0,100,100,0,0,3,${Math.round(tSize / 3)},0,8,${mLR},${mLR},${Math.round(H * 0.07)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${out.join('\n')}
`;
}

function ev(s, e, style, text) {
  return `Dialogue: 0,${ts(s)},${ts(e)},${style},,0,0,0,,${text}`;
}

/** Words that fall inside the clip segments, re-timed to start at 0. Optional user text override. */
export function clipWords(transcript, segments, override) {
  if (!transcript) return [];
  const all = transcript.segments.flatMap((s) => s.words || []);
  let offset = 0;
  let out = [];
  for (const g of segments) {
    for (const w of all) {
      if (w.e > g.start + 0.02 && w.s < g.end - 0.02) {
        out.push({ w: w.w, s: Math.max(0, w.s - g.start) + offset, e: Math.min(w.e, g.end) - g.start + offset });
      }
    }
    offset += g.end - g.start;
  }
  if (override && override.trim() && out.length) {
    const tokens = override.trim().split(/\s+/);
    if (tokens.length === out.length) out = out.map((w, i) => ({ ...w, w: tokens[i] }));
    else {
      const s0 = out[0].s;
      const e0 = out[out.length - 1].e;
      const step = (e0 - s0) / tokens.length;
      out = tokens.map((w, i) => ({ w, s: s0 + i * step, e: s0 + (i + 1) * step - 0.02 }));
    }
  }
  return out;
}
