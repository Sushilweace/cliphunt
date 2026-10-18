import { llm, llmEnabled, llmProvider, parseJSON } from './llm.js';
import { tokenLimits } from './usage.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nearest = (arr, v) => arr.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), arr[0]);

/**
 * Pick the best moments.
 * transcript: {segments} | null     energy: dB-per-second[]
 * opts: {count, minLen, maxLen, prompt}
 * Returns [{start,end,title,hook,reason,score,scores}] sorted best-first.
 */
export async function findHighlights({ transcript, energy, duration, opts, onUsage, tokenBudget }) {
  const o = { count: 5, minLen: 20, maxLen: 60, prompt: '', ...opts };
  let cands = null;
  let method = 'energy';
  if (transcript?.segments?.length) {
    if (llmEnabled()) {
      try {
        cands = await llmCandidates(transcript, o, { onUsage, tokenBudget });
        method = cands.length ? 'llm' : 'heuristic';
      } catch (e) {
        console.warn('[highlights] LLM failed, using heuristic:', e.message);
      }
    }
    if (!cands?.length) {
      cands = heuristic(transcript, energy, o);
      method = 'heuristic';
    }
  } else {
    cands = energyOnly(energy, duration, o);
  }
  return { clips: finalize(cands, transcript, energy, duration, o), method };
}

// ---------- LLM ----------
const SYSTEM = `You are a short-form video editor. From a timestamped transcript choose the best standalone clips for TikTok, Reels and Shorts.
Rules: each clip must start with a strong hook and end on a complete thought; no clip may need earlier context to make sense.
Return ONLY JSON with this shape, no prose:
{"clips":[{"start":seconds,"end":seconds,"title":"max 8 words","hook":"max 12 word on-screen opener","reason":"one sentence","scores":{"hook":0-10,"emotion":0-10,"clarity":0-10,"share":0-10}}]}`;

async function llmCandidates(transcript, o, { onUsage, tokenBudget } = {}) {
  const windows = [];
  const segs = transcript.segments;
  const WIN = 600;
  const STEP = 540;
  const end = segs[segs.length - 1].end;
  for (let t = 0; t < end; t += STEP) {
    const lines = segs.filter((s) => s.start >= t && s.start < t + WIN).map((s) => `[${Math.round(s.start)}] ${s.text}`);
    if (lines.length) windows.push(lines.join('\n'));
  }
  const perWindow = Math.max(2, Math.ceil((o.count * 2) / windows.length));
  const out = [];
  let i = 0;
  let stopped = false;
  async function worker() {
    while (i < windows.length && !stopped) {
      const w = windows[i++];
      const user = `Clip length: ${o.minLen}-${o.maxLen} seconds. Return up to ${perWindow} clips.${o.prompt ? `\nUser focus: ${o.prompt}` : ''}\n\nTranscript ([seconds] text):\n${w}`;
      let arr = [];
      for (let attempt = 0; attempt < 2 && !arr.length && !stopped; attempt++) {
        try {
          const res = await llm(SYSTEM, user, { maxTokens: Math.min(2500, tokenLimits().clip || 2500) });
          if (onUsage?.(res.usage) === false) stopped = true;
          arr = clipList(parseJSON(res.text));
        } catch (e) {
          if (attempt === 1) console.warn('[highlights] window skipped:', e.message);
        }
      }
      out.push(...arr);
    }
  }
  // One local model cannot serve three prompts at once without stalling.
  const parallel = llmProvider() === 'ollama' ? 1 : 3;
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return out.map(cleanCandidate).filter(Boolean);
}

function clipList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.clips)) return parsed.clips;
  return [];
}

function cleanCandidate(c) {
  const start = Number(c?.start);
  const end = Number(c?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5) return null;
  const scores = {};
  for (const k of ['hook', 'emotion', 'clarity', 'share']) {
    const n = Number(c.scores?.[k]);
    if (Number.isFinite(n)) scores[k] = clamp(n, 0, 10);
  }
  const vals = Object.values(scores);
  return {
    start,
    end,
    title: String(c.title || 'Clip').slice(0, 80),
    hook: String(c.hook || '').slice(0, 120),
    reason: String(c.reason || '').slice(0, 240),
    scores,
    llmScore: vals.length ? avg(vals) * 10 : 50,
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + Number(y || 0), 0) / a.length : 0);

// ---------- heuristic (no API key) ----------
function heuristic(transcript, energy, o) {
  const segs = transcript.segments;
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    let j = i;
    while (j < segs.length - 1 && segs[j].end - segs[i].start < o.minLen) j++;
    const dur = segs[j].end - segs[i].start;
    if (dur < o.minLen * 0.7 || dur > o.maxLen) continue;
    const text = segs.slice(i, j + 1).map((s) => s.text).join(' ');
    const words = text.split(/\s+/).length;
    const punct = (text.match(/[?!]/g) || []).length;
    const llmScore = clamp(35 + (words / dur) * 8 + punct * 6, 0, 95);
    out.push({
      start: segs[i].start,
      end: segs[j].end,
      title: trimTitle(segs[i].text),
      hook: trimTitle(segs[i].text, 60),
      reason: 'Dense speech with questions and emphasis.',
      llmScore,
    });
  }
  return out;
}

function energyOnly(energy, duration, o) {
  const len = Math.round((o.minLen + o.maxLen) / 2);
  const out = [];
  for (let t = 0; t + len <= duration; t += Math.max(5, Math.floor(len / 3))) {
    out.push({ start: t, end: t + len, title: `Moment at ${fmt(t)}`, hook: '', reason: 'Loud, active audio. Add a transcription provider for smarter picks.', llmScore: 50 });
  }
  if (!out.length) out.push({ start: 0, end: Math.min(duration, o.maxLen), title: 'Opening', hook: '', reason: 'Video is short.', llmScore: 50 });
  return out;
}

// ---------- shared ----------
function finalize(cands, transcript, energy, duration, o) {
  const segs = transcript?.segments || [];
  const starts = segs.map((s) => s.start);
  const ends = segs.map((s) => s.end);
  const lo = percentile(energy, 0.1);
  const hi = percentile(energy, 0.9);
  const scored = [];
  for (const c of cands) {
    let { start, end } = c;
    if (segs.length) {
      start = nearest(starts, start);
      end = nearest(ends, end);
      if (end - start > o.maxLen + 10) {
        const ok = ends.filter((e) => e > start + o.minLen * 0.7 && e <= start + o.maxLen);
        end = ok.length ? ok[ok.length - 1] : start + o.maxLen;
      }
    }
    start = clamp(start, 0, duration);
    end = clamp(end, 0, duration);
    if (end - start < 5) continue;
    const es = energyScore(energy, start, end, lo, hi);
    const score = Math.round(clamp((c.llmScore ?? 50) * 0.8 + es * 0.2, 1, 99));
    scored.push({ start, end, title: c.title || 'Clip', hook: c.hook || '', reason: c.reason || '', scores: { ...(c.scores || {}), energy: Math.round(es / 10) }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    const overlap = picked.some((p) => Math.min(p.end, c.end) - Math.max(p.start, c.start) > 0.3 * (c.end - c.start));
    if (!overlap) picked.push(c);
    if (picked.length >= o.count) break;
  }
  return picked;
}

function energyScore(energy, start, end, lo, hi) {
  const sl = energy.slice(Math.floor(start), Math.ceil(end));
  if (!sl.length || hi <= lo) return 50;
  return clamp(((avg(sl) - lo) / (hi - lo)) * 100, 0, 100);
}
function percentile(a, p) {
  if (!a.length) return -60;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(p * (s.length - 1))];
}
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function trimTitle(t, max = 48) {
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}

// ---------- post description ----------
export async function describeClip(text, title) {
  const limits = tokenLimits();
  if (llmEnabled() && text) {
    try {
      const slice = text.slice(0, Math.min(3000, (limits.clip || 8000) * 4));
      const res = await llm(
        'You write social post copy. Return ONLY JSON: {"description":"1-2 punchy sentences, no hashtags","hashtags":["5-8 lowercase tags without #"]}',
        `Clip title: ${title}\nTranscript: ${slice}`,
        { maxTokens: Math.min(400, limits.clip || 400) }
      );
      const j = parseJSON(res.text);
      return { description: j.description, hashtags: (j.hashtags || []).map((h) => String(h).replace(/^#/, '')), usage: res.usage };
    } catch (e) {
      console.warn('[describe] LLM failed:', e.message);
    }
  }
  const stop = new Set('this that with have from they them were what when your about there their would could which because just like really very than then also into over only some more been will being'.split(' '));
  const freq = {};
  for (const w of (text || '').toLowerCase().match(/[a-z]{5,}/g) || []) if (!stop.has(w)) freq[w] = (freq[w] || 0) + 1;
  const tags = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  return { description: title, hashtags: tags };
}

/** Correct spelling and grammar. Keeps the original language. */
export async function proofreadCaption(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('There is no caption text to fix');
  if (!llmEnabled()) throw new Error('Spelling and grammar fix needs Gemini, Claude, or Ollama');
  const limits = tokenLimits();
  const res = await llm(
    'You correct caption text. Fix spelling and grammar only. Keep the original language: Hindi stays Hindi, English stays English. Do not translate. Do not change the meaning or add new ideas. Return ONLY JSON: {"text":"the corrected caption"}',
    clean.slice(0, 6000),
    { maxTokens: Math.min(2000, limits.clip || 2000) }
  );
  const fixed = String(parseJSON(res.text).text || '').trim();
  if (!fixed) throw new Error('The model returned no corrected text');
  return { text: fixed, usage: res.usage };
}
