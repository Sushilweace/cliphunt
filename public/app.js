const $ = (s, e = document) => e.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const api = async (path, opt = {}) => {
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = (path, body, method = 'POST') =>
  api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

const fmt = (t) => {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};
const parseTime = (v) => {
  const s = String(v).trim();
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    return p.reduce((a, x) => a * 60 + x, 0);
  }
  return Number(s);
};
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v;
};

const state = { config: {}, music: [], projects: [], pid: null, project: null, draft: null, origText: '', previewMode: 'original', saveTimer: null, recorder: null };

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), bad ? 6000 : 2600);
}

// ---------- init ----------
async function init() {
  if (window.location.search.includes('youtube=connected')) {
    toast('YouTube account connected successfully!');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  [state.config, state.music] = await Promise.all([api('/api/config'), api('/api/music')]);
  const c = state.config;
  const ytChip = `<button type="button" class="chip ${c.youtubeStatus?.connected ? 'on yt-connected' : 'yt-disconnected'}" id="yt-status-chip">YouTube: ${c.youtubeStatus?.connected ? (c.youtubeStatus.channel?.customUrl || c.youtubeStatus.channel?.title || 'Connected') : 'Connect'}</button>`;
  $('#caps').innerHTML = [
    [c.transcribe !== 'none', `Speech: ${c.transcribe === 'none' ? 'off' : c.transcribe}`],
    [c.llm, c.llm ? `AI picks: ${c.llmProvider}` : 'AI picks: basic'],
    [c.tts, c.tts ? 'Voice-over AI: on' : 'Voice-over AI: off'],
  ].map(([on, t]) => `<span class="chip ${on ? 'on' : ''}">${t}</span>`).join('') + ytChip;

  $('#yt-status-chip')?.addEventListener('click', openYouTubeSettingsModal);
  wireYouTubeModals();

  if (!c.youtube) $('[data-src=youtube]').hidden = true;
  const lim = c.tokenLimits || {};
  const note = $('#token-note');
  if (note) note.textContent = `Each project can spend ${Number(lim.project || 0).toLocaleString()} analysis tokens. One clip's post copy is capped at ${Number(lim.clip || 0).toLocaleString()}. The Clips field is how many moments are analyzed.`;
  $('#aspect').innerHTML = c.aspects.map((a) => `<option>${a}</option>`).join('');
  await loadProjects();
  renderMain();
  setInterval(tick, 1500);
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderList();
}

function renderList() {
  const ul = $('#plist');
  if (!state.projects.length) {
    ul.innerHTML = '<li class="empty">No projects yet. Add a video above.</li>';
    return;
  }
  ul.innerHTML = state.projects
    .map((p) => {
      const meta = p.status === 'ready' ? `${p.clipCount} clips` : p.status === 'error' ? 'Failed' : `${p.stage} ${p.progress}%`;
      return `<li data-id="${p.id}" class="${p.id === state.pid ? 'on' : ''}"><span class="name">${esc(p.title || 'Untitled')}</span><span class="meta">${esc(meta)}</span></li>`;
    })
    .join('');
}
$('#plist').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) selectProject(li.dataset.id);
});

async function selectProject(id) {
  state.pid = id;
  closeEditor();
  state.project = await api(`/api/projects/${id}`);
  renderList();
  renderMain();
}

async function tick() {
  try {
    const busy = state.projects.some((p) => p.status === 'processing' || p.status === 'queued');
    if (busy) await loadProjects();
    if (!state.pid) return;
    const p = state.project;
    const active = !p || p.status === 'processing' || p.status === 'queued' || p.clips?.some((c) => c.status === 'rendering' || c.status === 'queued' || c.youtube?.status === 'uploading');
    if (!active) return;
    const fresh = await api(`/api/projects/${state.pid}`);
    state.project = fresh;
    if (p && p.status !== 'ready' && fresh.status === 'ready') renderMain();
    else if (fresh.status === 'ready') updateCards();
    else renderMain();
    if (state.draft) syncEditorStatus();
    if (ytActiveClipId && $('#yt-upload-modal')?.open) syncYouTubeUploadModal(ytActiveClipId);
  } catch {}
}

// ---------- new project form ----------
let uploaded = null;
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#src-upload').hidden = b.dataset.src !== 'upload';
    $('#src-youtube').hidden = b.dataset.src !== 'youtube';
  })
);
const drop = $('#drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) { $('#file').files = e.dataTransfer.files; onFile(); }
});
$('#file').addEventListener('change', onFile);

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads?name=${encodeURIComponent(file.name)}`);
    $('#upbar').hidden = false;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('#upbar i').style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      xhr.status === 200 ? resolve(j) : reject(new Error(j.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(file);
  });
}
function onFile() {
  const f = $('#file').files[0];
  uploaded = null;
  $('#drop-text').textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(0)} MB)` : 'Choose a video or drop it here';
}

$('#new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#go');
  const yt = !$('#src-youtube').hidden;
  try {
    if (!$('#rights').checked) throw new Error('Confirm that you have the rights to use this video');
    btn.disabled = true;
    const body = {
      title: $('#ptitle').value,
      rightsConfirmed: true,
      options: { count: $('#count').value, minLen: $('#minLen').value, maxLen: $('#maxLen').value, aspect: $('#aspect').value, prompt: $('#prompt').value },
    };
    if (yt) {
      if (!$('#yt').value.trim()) throw new Error('Paste a YouTube link');
      body.youtubeUrl = $('#yt').value.trim();
    } else {
      const f = $('#file').files[0];
      if (!f) throw new Error('Choose a video file first');
      btn.textContent = 'Uploading…';
      body.uploadId = (uploaded ||= await uploadFile(f)).uploadId;
    }
    const p = await post('/api/projects', body);
    toast('Started. Clips appear as soon as they are ready.');
    $('#upbar').hidden = true;
    $('#upbar i').style.width = '0';
    await loadProjects();
    await selectProject(p.id);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find clips';
  }
});

// ---------- project view ----------
function renderMain() {
  const m = $('#main');
  const p = state.project;
  if (!p) {
    m.innerHTML = `<div class="card"><h2>Start with a video</h2><p class="sub">Upload a podcast, stream or interview, or paste a YouTube link you have rights to. Cliphunt finds the strongest moments and turns each into a vertical clip with captions, a title and music.</p></div>`;
    return;
  }
  const tokens = p.usage?.total ? ` · ${(p.usage.total).toLocaleString()} analysis tokens${state.config.tokenLimits?.project ? ` / ${Number(state.config.tokenLimits.project).toLocaleString()}` : ''}` : '';
  const head = `<div class="head"><div><h2>${esc(p.title || 'Untitled')}</h2><p class="sub">${p.duration ? `${fmt(p.duration)} long` : ''}${p.language ? ` · ${esc(p.language)}` : ''}${p.method ? ` · picked by ${p.method === 'llm' ? 'AI' : p.method}` : ''}${tokens}</p></div><button class="ghost danger" id="del">Delete project</button></div>`;
  let body = '';
  if (p.status === 'error') body = `<div class="err">${esc(p.error)}</div>`;
  else if (p.status !== 'ready') body = `<div class="progress"><strong>${esc(p.stage)}</strong><div class="bar"><i style="width:${p.progress}%"></i></div><p class="note">This runs in the background. You can leave this page.</p></div>`;
  else {
    const hot = Math.max(...p.clips.map((c) => c.score));
    body = `<div class="ruler" aria-label="Where the clips sit in the original video">${p.clips
      .map((c) => c.segments.map((g) => `<button data-edit="${c.id}" class="${c.score >= hot - 5 ? 'hot' : ''}" style="left:${(g.start / p.duration) * 100}%;width:${Math.max(0.6, ((g.end - g.start) / p.duration) * 100)}%" title="${esc(c.title)} (${c.score})"></button>`).join(''))
      .join('')}</div><div class="ticks"><span>0:00</span><span>${fmt(p.duration)}</span></div><div class="grid" id="grid">${p.clips.map(cardHTML).join('')}</div>`;
  }
  m.innerHTML = head + body;
  $('#del').onclick = async () => {
    if (!confirm('Delete this project and all its clips?')) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    state.pid = state.project = null;
    closeEditor();
    await loadProjects();
    renderMain();
  };
}

function thumbOf(p, c) {
  return c.renderedThumb ? `/media/${p.id}/${c.renderedThumb}?v=${c.renderedAt}` : `/media/${p.id}/${c.thumb}`;
}
function cardHTML(c) {
  const p = state.project;
  let st = c.status === 'done' ? '<span class="state ok">Rendered</span>' : c.status === 'rendering' ? `<span class="state">Rendering ${c.progress}%</span>` : c.status === 'queued' ? '<span class="state">Queued</span>' : c.status === 'error' ? '<span class="state">Failed</span>' : '';
  if (c.youtube?.status === 'uploaded') {
    if (c.youtube.publishAt) {
      const d = new Date(c.youtube.publishAt);
      st = `<span class="state yt scheduled" title="Scheduled: ${esc(d.toLocaleString())}">Scheduled</span>`;
    } else {
      st = '<span class="state yt">Short on YouTube</span>';
    }
  } else if (c.youtube?.status === 'uploading') {
    st = `<span class="state yt">Uploading ${c.youtube.progress || 0}%</span>`;
  }
  const dur = c.segments.reduce((a, g) => a + g.end - g.start, 0);
  const parts = c.segments.length > 1 ? ` · ${c.segments.length} parts` : '';
  const tok = c.usage?.total ? ` · ${c.usage.total.toLocaleString()} tokens` : '';
  const ytAction = c.outputFile
    ? (c.youtube?.videoUrl
        ? `<a class="ghost yt-red" target="_blank" rel="noreferrer" href="${c.youtube.videoUrl}">Short ↗</a>`
        : `<button type="button" class="ghost yt-red" data-yt="${c.id}">${c.youtube?.status === 'uploaded' ? 'YouTube' : 'Post Short'}</button>`)
    : '';

  return `<article class="clip" data-clip="${c.id}">
    <button class="th" data-edit="${c.id}" aria-label="Edit ${esc(c.title)}"><img src="${thumbOf(p, c)}" alt="" loading="lazy"><span class="score">${c.score}</span>${st}</button>
    <div class="body"><h3>${esc(c.title)}</h3><div class="range">${fmt(c.segments[0].start)} to ${fmt(c.segments[c.segments.length - 1].end)} · ${Math.round(dur)}s · ${c.aspect}${parts}${tok}</div>
    <div class="why">${esc(c.reason)}</div>
    <div class="acts"><button class="ghost" data-edit="${c.id}">Edit</button><button class="ghost" data-react="${c.id}">React</button>${c.outputFile ? `<a class="ghost" download href="/media/${p.id}/${c.outputFile}?v=${c.renderedAt}">Download</a>` : ''}${ytAction}</div></div></article>`;
}
function updateCards() {
  const g = $('#grid');
  if (!g) return;
  g.innerHTML = state.project.clips.map(cardHTML).join('');
}
$('#main').addEventListener('click', (e) => {
  const yt = e.target.closest('[data-yt]');
  if (yt) { openYouTubeUploadModal(yt.dataset.yt); return; }
  const r = e.target.closest('[data-react]');
  if (r) { openEditor(r.dataset.react, true); return; }
  const b = e.target.closest('[data-edit]');
  if (b) openEditor(b.dataset.edit);
});

// ---------- editor ----------
const clipOf = (id) => state.project.clips.find((c) => c.id === id);

function openReact() {
  const pop = $('#react-pop');
  if (!pop) return;
  if (!pop.open) pop.showModal();
  setPreview();
}
function openEditor(id, react) {
  const c = clipOf(id);
  state.draft = JSON.parse(JSON.stringify(c));
  state.previewMode = c.outputFile ? 'rendered' : 'original';
  api(`/api/clips/${id}/words`).then((w) => {
    state.origText = w.text;
    const ta = $('#f-text');
    if (ta) ta.value = state.draft.settings.captions.textOverride || w.text;
  }).catch(() => {});
  renderEditor();
  $('#editor').hidden = false;
  if (react) openReact();
}
function closeEditor() {
  const pop = $('#react-pop');
  if (pop?.open) pop.close();
  stopRecording();
  state.draft = null;
  $('#editor').hidden = true;
  $('#editor').innerHTML = '';
}

const sel = (path, options, labels = {}) => `<select data-k="${path}">${options.map((o) => `<option value="${o}" ${getPath(state.draft, path) === o ? 'selected' : ''}>${labels[o] || o}</option>`).join('')}</select>`;
const val = (path) => esc(getPath(state.draft, path) ?? '');

function renderEditor() {
  const d = state.draft;
  const s = d.settings;
  const p = state.project;
  const musicOpts = [''].concat(state.music.map((m) => m.id));
  const musicLabels = Object.fromEntries([['', 'No music']].concat(state.music.map((m) => [m.id, m.name])));
  $('#editor').innerHTML = `
  <div class="ed-head"><h3>Edit clip</h3><button class="ghost" id="ed-close">Close</button></div>
  <div class="ed-body">
    <button type="button" class="primary" id="open-react">Play video and record a reaction</button>
    <p class="note">Opens the clip with voice-over and camera controls.</p>

    <fieldset><legend>Title and hook</legend>
      <label>Title <input data-k="title" value="${val('title')}"></label>
      <label>On-screen opener <input data-k="settings.title.text" value="${esc(s.title.text || d.hook)}" placeholder="Shown over the first seconds"></label>
      <div class="two"><label class="check"><input type="checkbox" data-k="settings.title.enabled" ${s.title.enabled ? 'checked' : ''}> Show opener</label>
      <label class="check"><input type="checkbox" data-k="settings.title.upper" ${s.title.upper ? 'checked' : ''}> Capital opener</label>
      <label>Shown for (s) <input type="number" min="1" max="10" step="0.5" data-k="settings.title.seconds" value="${s.title.seconds}"></label></div>
    </fieldset>

    <fieldset><legend>Cut</legend>
      <div id="segs">${d.segments.map(segRow).join('')}</div>
      <div class="inline"><button class="ghost" id="add-seg">Add a segment (supercut)</button></div>
      <p class="note">Segments play in order. The source is ${fmt(p.duration)} long. Use m:ss or seconds.</p>
      <div class="two"><label>Shape ${sel('aspect', state.config.aspects)}</label>
      <label>Fill ${sel('settings.bg', ['blur', 'crop', 'smart', 'fit'], { blur: 'Blurred background', crop: 'Crop to fill', smart: 'Crop to face', fit: 'Solid colour bars' })}</label></div>
      <label>Crop position (for crop modes) <input type="range" min="0" max="1" step="0.01" data-k="settings.cropX" value="${s.cropX}"></label>
    </fieldset>

    <fieldset><legend>Captions</legend>
      <label class="check"><input type="checkbox" data-k="settings.captions.enabled" ${s.captions.enabled ? 'checked' : ''}> Burn captions into the video</label>
      <div class="two"><label>Style ${sel('settings.captions.style', state.config.captionStyles, { highlight: 'Highlight word', pop: 'Word pop', karaoke: 'Karaoke sweep', plain: 'Plain' })}</label>
      <label>Position ${sel('settings.captions.position', ['bottom', 'middle', 'top'])}</label></div>
      <div class="two"><label>Text colour <input type="color" data-k="settings.captions.color" value="${s.captions.color}"></label>
      <label>Highlight colour <input type="color" data-k="settings.captions.accent" value="${s.captions.accent}"></label></div>
      <div class="two"><label>Size <input type="range" min="0.025" max="0.08" step="0.001" data-k="settings.captions.size" value="${s.captions.size}"></label>
      <label>Words per line <input type="number" min="1" max="6" data-k="settings.captions.maxWords" value="${s.captions.maxWords}"></label></div>
      <label>Font ${sel('settings.captions.font', ['Arial', 'Nirmala UI', 'Mangal', 'Impact', 'Verdana', 'Georgia', 'Courier New', 'DejaVu Sans'])}</label>
      <label class="check"><input type="checkbox" data-k="settings.captions.upper" ${s.captions.upper ? 'checked' : ''}> Capital letters</label>
      <label>Caption text. Fix any mistakes in the transcript here.
        <textarea id="f-text" ${p.hasTranscript ? '' : 'disabled placeholder="No transcript for this video. Turn on a transcription provider."'}>${esc(s.captions.textOverride || state.origText)}</textarea></label>
      <div class="inline"><button type="button" class="ghost" id="fix-text" ${p.hasTranscript && state.config.llm ? '' : 'disabled'}>Fix spelling and grammar</button></div>
      <p class="note">Corrects words in the same language. Hindi stays Hindi. Render again to burn the new words in. Use Nirmala UI for Hindi.</p>
    </fieldset>

    <fieldset><legend>Look</legend>
      <label>Filter ${sel('settings.filter', state.config.filters)}</label>
      <label class="check"><input type="checkbox" data-k="settings.logo.enabled" ${s.logo.enabled ? 'checked' : ''}> Show my logo</label>
      <div class="inline"><label style="margin:0">Position ${sel('settings.logo.pos', ['tr', 'tl', 'br', 'bl'], { tr: 'Top right', tl: 'Top left', br: 'Bottom right', bl: 'Bottom left' })}</label>
      <label style="margin:0">Logo file (PNG) <input type="file" id="logo-file" accept="image/png"></label></div>
    </fieldset>

    <fieldset><legend>Music</legend>
      <label>Track ${sel('settings.music.track', musicOpts, musicLabels)}</label>
      <label>Music volume <input type="range" min="0" max="0.6" step="0.01" data-k="settings.music.volume" value="${s.music.volume}"></label>
      <p class="note">Music dips automatically while someone is speaking. Add your own licensed files to data/music.</p>
    </fieldset>

    <dialog id="react-pop">
      <form method="dialog" class="react-head"><h3>Play and react</h3><button class="ghost" value="close">Close</button></form>
      <div class="react-grid">
        <div>
          <video id="pv" class="pv" controls playsinline></video>
          <div class="inline"><button type="button" class="ghost" data-pm="original">Original range</button><button type="button" class="ghost" data-pm="rendered" ${d.outputFile ? '' : 'disabled'}>Rendered clip</button></div>
        </div>
        <fieldset><legend>Voice-over and reaction</legend>
          <div id="voice-status">${voiceStatus()}</div>
          <div class="inline"><button type="button" class="ghost" id="rec-voice">Record voice</button><button type="button" class="ghost" id="rec-face">Record with camera</button>
          <label style="margin:0">Or upload <input type="file" id="voice-file" accept="audio/*,video/*"></label></div>
          <p class="note">Use headphones. The clip plays while you record, and your take starts at the beginning of the clip.</p>
          <div class="two"><label>Original sound ${sel('settings.voice.mode', ['duck', 'mute'], { duck: 'Lower under me', mute: 'Mute' })}</label>
          <label>Voice volume <input type="range" min="0.5" max="2.5" step="0.05" data-k="settings.voice.volume" value="${s.voice.volume}"></label></div>
          <div id="react-place" ${d.voice?.kind === 'face' && d.voice?.hasVideo ? '' : 'hidden'}>
            <p class="note">Reaction place. The circle is burned in when you render.</p>
            <div class="inline" id="bubble-pos">${bubbleButtons(s.bubble)}</div>
            <label>Reaction size <input type="range" min="0.16" max="0.46" step="0.02" data-k="settings.bubble.size" value="${s.bubble?.size ?? 0.28}"></label>
          </div>
          <label>Or type a script for an AI voice <textarea id="tts-text" ${state.config.tts ? '' : 'disabled placeholder="Needs an OPENAI_API_KEY on the server"'}></textarea></label>
          <div class="inline"><button type="button" class="ghost" id="tts-go" ${state.config.tts ? '' : 'disabled'}>Make AI voice</button></div>
        </fieldset>
      </div>
    </dialog>

    <fieldset><legend>Post copy</legend>
      <label>Description <textarea data-k="description">${esc(d.description)}</textarea></label>
      <label>Hashtags <input data-k="hashtags" value="${esc((d.hashtags || []).map((h) => '#' + h).join(' '))}"></label>
      <div class="inline">
        <button class="ghost" id="desc-go">Write it for me</button>
        <button class="ghost" id="desc-copy">Copy</button>
        <button type="button" class="ghost yt-red" id="desc-yt" ${d.outputFile ? '' : 'disabled title="Render clip first"'}>Upload / Schedule Short</button>
      </div>
    </fieldset>
  </div>
  <div class="ed-foot"><div class="bar" id="rbar" hidden><i></i></div><span id="rtext" class="note" style="margin:0"></span><span style="flex:1"></span>
    <a class="ghost" id="dl" download hidden>Download</a>
    ${d.outputFile ? '<button type="button" class="ghost yt-red" id="ed-yt-btn">YouTube Short</button>' : ''}
    <button class="primary" id="render">Render clip</button></div>`;
  wireEditor();
  setPreview();
  syncEditorStatus();
}

function segRow(g, i) {
  return `<div class="segrow" data-seg="${i}"><label>Start <input data-seg-s value="${fmt(g.start)}"></label><label>End <input data-seg-e value="${fmt(g.end)}"></label>${state.draft.segments.length > 1 ? `<button class="ghost danger" data-seg-rm="${i}">Remove</button>` : '<span></span>'}</div>`;
}
const BUBBLES = [
  ['tl', 'Top left', 0.04, 0.04],
  ['tr', 'Top right', 0.96, 0.04],
  ['bl', 'Bottom left', 0.04, 0.96],
  ['br', 'Bottom right', 0.96, 0.96],
];
function bubbleKey(b) {
  let best = 'tr';
  let dist = 99;
  for (const [k, , x, y] of BUBBLES) {
    const d = Math.abs((b?.x ?? 0.88) - x) + Math.abs((b?.y ?? 0.12) - y);
    if (d < dist) { dist = d; best = k; }
  }
  return best;
}
function bubbleButtons(b) {
  const on = bubbleKey(b);
  return BUBBLES.map(([k, label, x, y]) => `<button type="button" class="ghost ${k === on ? 'on' : ''}" data-bubble="${x},${y}">${label}</button>`).join('');
}
function syncReactPlace() {
  const el = $('#react-place');
  if (!el || !state.draft) return;
  const v = state.draft.voice;
  el.hidden = !(v && v.kind === 'face' && v.hasVideo);
}
function voiceStatus() {
  const v = state.draft.voice;
  return v ? `<p class="note"><strong>${v.tts ? 'AI voice' : v.kind === 'face' ? 'Camera take' : 'Voice take'} attached.</strong> <button class="ghost danger" id="voice-rm">Remove</button></p>` : '<p class="note">No voice-over yet.</p>';
}

function setPreview() {
  const d = state.draft;
  const p = state.project;
  const v = $('#pv');
  if (!v) return;
  document.querySelectorAll('[data-pm]').forEach((b) => b.classList.toggle('active', b.dataset.pm === state.previewMode));
  v.ontimeupdate = null;
  if (state.previewMode === 'rendered' && d.outputFile) {
    v.src = `/media/${p.id}/${d.outputFile}?v=${d.renderedAt}`;
    return;
  }
  const list = () => d.segments.filter((g) => Number(g.end) > Number(g.start) + 0.2);
  let idx = 0;
  const arm = () => {
    const g = list()[0];
    if (!g) return;
    idx = 0;
    if (Math.abs(v.currentTime - g.start) > 0.25) v.currentTime = g.start;
  };
  v.onloadeddata = arm;
  if (!v.src.endsWith(p.proxy)) v.src = `/media/${p.id}/${p.proxy}`;
  else arm();
  v.ontimeupdate = () => {
    if (state.previewMode !== 'original') return;
    const segs = list();
    const g = segs[idx];
    if (!g) return;
    if (v.currentTime >= g.end - 0.08) {
      if (idx >= segs.length - 1) {
        v.pause();
        if (state.recorder) stopRecording();
        return;
      }
      idx += 1;
      v.currentTime = segs[idx].start;
    }
  };
}

function syncEditorStatus() {
  if (!state.draft) return;
  const c = clipOf(state.draft.id);
  if (!c) return;
  const busy = c.status === 'rendering' || c.status === 'queued';
  const rb = $('#render');
  if (!rb) return;
  rb.disabled = busy;
  rb.textContent = busy ? 'Rendering…' : c.outputFile ? 'Render again' : 'Render clip';
  $('#rbar').hidden = !busy;
  if (busy) $('#rbar i').style.width = `${c.progress}%`;
  $('#rtext').textContent = busy ? (c.status === 'queued' ? 'Waiting for a free slot' : `${c.progress}%`) : c.status === 'error' ? 'Render failed. See below.' : '';
  const dl = $('#dl');
  if (c.outputFile) { dl.hidden = false; dl.href = `/media/${state.project.id}/${c.outputFile}?v=${c.renderedAt}`; }
  if (c.status === 'done' && (c.renderedAt !== state.draft.renderedAt)) {
    state.draft.outputFile = c.outputFile;
    state.draft.renderedAt = c.renderedAt;
    state.previewMode = 'rendered';
    setPreview();
    $('[data-pm=rendered]').disabled = false;
  }
  let er = $('#rerr');
  if (c.status === 'error') {
    if (!er) { er = document.createElement('div'); er.id = 'rerr'; er.className = 'err'; $('.ed-body').prepend(er); }
    er.textContent = c.error;
  } else if (er) er.remove();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDraft, 600);
}
async function saveDraft() {
  clearTimeout(state.saveTimer);
  const d = state.draft;
  if (!d) return;
  try {
    const c = await post(`/api/clips/${d.id}`, { title: d.title, hook: d.hook, description: d.description, hashtags: d.hashtags, segments: d.segments, aspect: d.aspect, settings: d.settings }, 'PATCH');
    const i = state.project.clips.findIndex((x) => x.id === c.id);
    state.project.clips[i] = { ...state.project.clips[i], ...c };
  } catch (e) {
    toast(e.message, true);
  }
}

function wireEditor() {
  const ed = $('#editor');
  $('#ed-close').onclick = () => { saveDraft(); closeEditor(); renderMain(); };
  $('#open-react').onclick = openReact;
  $('#react-pop').addEventListener('close', () => { if (state.recorder) stopRecording(); });
  document.querySelectorAll('[data-pm]').forEach((b) => (b.onclick = () => { state.previewMode = b.dataset.pm; setPreview(); }));

  ed.querySelectorAll('[data-k]').forEach((el) => {
    const h = () => {
      const k = el.dataset.k;
      let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      if (k === 'hashtags') v = el.value.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
      setPath(state.draft, k, v);
      if (k === 'settings.title.text') state.draft.hook = v;
      scheduleSave();
    };
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input', h);
  });

  $('#f-text')?.addEventListener('input', (e) => {
    state.draft.settings.captions.textOverride = e.target.value.trim() === state.origText.trim() ? '' : e.target.value;
    scheduleSave();
  });
  $('#fix-text')?.addEventListener('click', async () => {
    const btn = $('#fix-text');
    const ta = $('#f-text');
    if (!ta?.value.trim()) return toast('There is no caption text to fix', true);
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Fixing…';
    try {
      const r = await post(`/api/clips/${state.draft.id}/proofread`, { text: ta.value });
      ta.value = r.text;
      state.draft.settings.captions.textOverride = r.text.trim() === state.origText.trim() ? '' : r.text;
      if (/[\u0900-\u097F]/.test(r.text)) {
        state.draft.settings.captions.font = 'Nirmala UI';
        const font = ed.querySelector('[data-k="settings.captions.font"]');
        if (font) font.value = 'Nirmala UI';
      }
      if (r.projectUsage) state.project.usage = r.projectUsage;
      scheduleSave();
      toast('Spelling and grammar updated. Render to burn them in.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  const readSegs = () => {
    state.draft.segments = [...ed.querySelectorAll('[data-seg]')].map((r) => ({ start: parseTime($('[data-seg-s]', r).value), end: parseTime($('[data-seg-e]', r).value) }));
  };
  ed.addEventListener('change', (e) => {
    if (e.target.matches('[data-seg-s],[data-seg-e]')) { readSegs(); scheduleSave(); if (state.previewMode === 'original') setPreview(); }
  });
  ed.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-seg-rm]');
    if (rm) { readSegs(); state.draft.segments.splice(Number(rm.dataset.segRm), 1); $('#segs').innerHTML = state.draft.segments.map(segRow).join(''); scheduleSave(); }
  });
  $('#add-seg').onclick = () => {
    readSegs();
    const last = state.draft.segments.at(-1);
    state.draft.segments.push({ start: Math.min(last.end + 5, state.project.duration - 6), end: Math.min(last.end + 11, state.project.duration) });
    $('#segs').innerHTML = state.draft.segments.map(segRow).join('');
    scheduleSave();
  };

  $('#logo-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await api('/api/brand/logo', { method: 'PUT', body: f }); toast('Logo saved'); } catch (err) { toast(err.message, true); }
  };

  $('#desc-go').onclick = async () => {
    $('#desc-go').disabled = true;
    try {
      const c = await post(`/api/clips/${state.draft.id}/describe`);
      state.draft.description = c.description;
      state.draft.hashtags = c.hashtags;
      renderEditor();
    } catch (err) { toast(err.message, true); }
  };
  $('#desc-copy').onclick = async () => {
    const d = state.draft;
    await navigator.clipboard.writeText(`${d.description}\n\n${(d.hashtags || []).map((h) => '#' + h).join(' ')}`.trim());
    toast('Copied');
  };
  $('#desc-yt')?.addEventListener('click', () => {
    saveDraft();
    openYouTubeUploadModal(state.draft.id);
  });
  $('#ed-yt-btn')?.addEventListener('click', () => {
    saveDraft();
    openYouTubeUploadModal(state.draft.id);
  });

  // voice-over
  $('#bubble-pos')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bubble]');
    if (!b) return;
    const [x, y] = b.dataset.bubble.split(',').map(Number);
    state.draft.settings.bubble ??= { x: 0.88, y: 0.12, size: 0.28 };
    state.draft.settings.bubble.x = x;
    state.draft.settings.bubble.y = y;
    $('#bubble-pos').querySelectorAll('[data-bubble]').forEach((n) => n.classList.toggle('on', n === b));
    scheduleSave();
  });

  $('#rec-voice').onclick = () => toggleRecording('voice');
  $('#rec-face').onclick = () => toggleRecording('face');
  $('#voice-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() || 'webm').toLowerCase();
    await uploadVoice(f, f.type.startsWith('video') ? 'face' : 'voice', ext);
  };
  $('#tts-go').onclick = async () => {
    try {
      const c = await post(`/api/clips/${state.draft.id}/tts`, { text: $('#tts-text').value });
      state.draft.voice = c.voice;
      $('#voice-status').innerHTML = voiceStatus();
      syncReactPlace();
      wireVoiceRemove();
      toast('Voice-over added');
    } catch (err) { toast(err.message, true); }
  };
  wireVoiceRemove();

  $('#render').onclick = async () => {
    await saveDraft();
    try {
      const c = await post(`/api/clips/${state.draft.id}/render`);
      const i = state.project.clips.findIndex((x) => x.id === c.id);
      state.project.clips[i] = c;
      syncEditorStatus();
    } catch (err) { toast(err.message, true); }
  };
}

function wireVoiceRemove() {
  const b = $('#voice-rm');
  if (!b) return;
  b.onclick = async () => {
    await api(`/api/clips/${state.draft.id}/voice`, { method: 'DELETE' });
    state.draft.voice = null;
    $('#voice-status').innerHTML = voiceStatus();
    syncReactPlace();
  };
}

async function uploadVoice(blob, kind, ext) {
  try {
    const c = await api(`/api/clips/${state.draft.id}/voice?kind=${kind}&ext=${ext}`, { method: 'PUT', body: blob });
    state.draft.voice = c.voice;
    $('#voice-status').innerHTML = voiceStatus();
    syncReactPlace();
    wireVoiceRemove();
    toast('Voice-over attached. Render to hear it in the clip.');
  } catch (err) { toast(err.message, true); }
}

// ---------- recording ----------
function stopRecording() {
  const r = state.recorder;
  if (!r) return;
  state.recorder = null;
  try { r.mr.state !== 'inactive' && r.mr.stop(); } catch {}
  r.stream.getTracks().forEach((t) => t.stop());
}
async function toggleRecording(kind) {
  if (state.recorder) return stopRecording();
  if (!navigator.mediaDevices?.getUserMedia) return toast('Recording needs a secure page (https or localhost)', true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: kind === 'face' ? { width: 640, height: 640, facingMode: 'user' } : false });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      $('#rec-voice').textContent = 'Record voice';
      $('#rec-face').textContent = 'Record with camera';
      const v = $('#pv');
      v?.pause();
      if (chunks.length) await uploadVoice(new Blob(chunks, { type: mr.mimeType }), kind, 'webm');
    };
    state.recorder = { mr, stream };
    state.previewMode = 'original';
    setPreview();
    const v = $('#pv');
    mr.start();
    await v.play().catch(() => {});
    $(kind === 'face' ? '#rec-face' : '#rec-voice').textContent = 'Stop recording';
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Allow microphone or camera access to record' : err.message, true);
  }
}

// ---------- YouTube Integration ----------
let ytActiveClipId = null;

function toLocalISOString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  return `${Y}-${M}-${D}T${h}:${m}`;
}

function renderYouTubeChip() {
  const chip = $('#yt-status-chip');
  if (!chip) return;
  const st = state.config.youtubeStatus;
  if (st?.connected && st?.channel) {
    chip.className = 'chip on yt-connected';
    chip.textContent = `YouTube: ${st.channel.customUrl || st.channel.title}`;
  } else {
    chip.className = 'chip yt-disconnected';
    chip.textContent = 'YouTube: Connect';
  }
}

async function openYouTubeSettingsModal() {
  const pop = $('#yt-modal');
  if (!pop) return;
  try {
    const st = await api('/api/youtube/status');
    state.config.youtubeStatus = st;
    renderYouTubeSettings(st);
    if (!pop.open) pop.showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderYouTubeSettings(status) {
  const info = $('#yt-account-info');
  const disBtn = $('#yt-disconnect-btn');
  const connBtn = $('#yt-connect-btn');
  if (status.connected && status.channel) {
    info.innerHTML = `
      <div class="yt-channel-card">
        ${status.channel.thumbnail ? `<img src="${esc(status.channel.thumbnail)}" alt="">` : ''}
        <div class="yt-channel-meta">
          <h4>${esc(status.channel.title)}</h4>
          <p>${esc(status.channel.customUrl || 'Channel Connected')}</p>
        </div>
      </div>
      <p class="note" style="margin-top:8px;color:var(--ok)">✓ Channel connected. You are ready to upload Shorts with predefined schedules.</p>
    `;
    disBtn.hidden = false;
    connBtn.textContent = 'Reconnect Channel';
  } else {
    info.innerHTML = `
      <p style="margin:0"><strong>YouTube Not Connected.</strong> Connect your account to enable 1-click Shorts uploading and cloud scheduling.</p>
    `;
    disBtn.hidden = true;
    connBtn.textContent = 'Connect YouTube Channel';
  }
  const redirectUri = `${window.location.origin}/api/youtube/callback`;
  $('#yt-redirect-uri').value = redirectUri;
}

async function openYouTubeUploadModal(id) {
  const c = clipOf(id);
  if (!c) return;
  ytActiveClipId = id;
  const pop = $('#yt-upload-modal');
  if (!pop) return;

  const ytStatus = state.config.youtubeStatus || (await api('/api/youtube/status').catch(() => ({})));
  state.config.youtubeStatus = ytStatus;

  const badge = $('#yt-channel-badge');
  if (ytStatus.connected && ytStatus.channel) {
    badge.innerHTML = `<span class="chip on">Connected: <strong>${esc(ytStatus.channel.title)}</strong> ${esc(ytStatus.channel.customUrl || '')}</span>`;
  } else {
    badge.innerHTML = `<span class="chip" style="background:#fee2e2;color:#b91c1c">YouTube channel not connected. <button type="button" class="ghost" id="yt-open-settings-inline" style="padding:2px 8px;font-size:11px;margin-left:6px">Connect now</button></span>`;
    $('#yt-open-settings-inline')?.addEventListener('click', () => {
      pop.close();
      openYouTubeSettingsModal();
    });
  }

  // Auto-fill Title with #Shorts
  let title = c.title || 'Short Clip';
  if (!title.toLowerCase().includes('#shorts')) {
    title = title.slice(0, 91).trim() + ' #Shorts';
  }
  $('#ytu-title').value = title;

  // Auto-fill Description & Hashtags
  const tagsList = (c.hashtags || []).map((h) => (h.startsWith('#') ? h : `#${h}`));
  if (!tagsList.some((t) => t.toLowerCase() === '#shorts')) tagsList.push('#Shorts');
  const desc = c.description || c.title || '';
  $('#ytu-desc').value = `${desc}\n\n${tagsList.join(' ')}`.trim();
  $('#ytu-tags').value = (c.hashtags || []).join(', ');

  // Default predefined schedule time: Tomorrow 10:00 AM
  const defTime = new Date();
  defTime.setDate(defTime.getDate() + 1);
  defTime.setHours(10, 0, 0, 0);
  $('#ytu-time').value = toLocalISOString(defTime);

  // Status message
  const statusEl = $('#yt-upload-status');
  if (c.youtube?.status === 'uploaded') {
    const pub = c.youtube.publishAt ? `Scheduled for ${new Date(c.youtube.publishAt).toLocaleString()}` : 'Uploaded as Public Short';
    statusEl.innerHTML = `<div class="yt-box" style="margin:0"><strong>Current Status:</strong> ${pub}. <a href="${esc(c.youtube.videoUrl)}" target="_blank" rel="noreferrer">Open Short on YouTube ↗</a></div>`;
  } else if (c.youtube?.status === 'uploading') {
    statusEl.innerHTML = `<div class="yt-box" style="margin:0"><strong>Uploading…</strong> ${c.youtube.progress || 0}%</div>`;
  } else if (c.youtube?.status === 'error') {
    statusEl.innerHTML = `<div class="err">${esc(c.youtube.error)}</div>`;
  } else {
    statusEl.innerHTML = '';
  }

  $('#ytu-bar').hidden = true;
  $('#ytu-msg').textContent = '';
  $('#ytu-submit').disabled = false;
  $('#ytu-submit').textContent = c.youtube?.status === 'uploaded' ? 'Upload Again' : 'Upload & Schedule Short';

  if (!pop.open) pop.showModal();
}

function syncYouTubeUploadModal(id) {
  const c = clipOf(id);
  if (!c || !c.youtube) return;
  const pop = $('#yt-upload-modal');
  if (!pop || !pop.open) return;
  const y = c.youtube;
  const btn = $('#ytu-submit');
  const bar = $('#ytu-bar');
  const msg = $('#ytu-msg');
  const statusEl = $('#yt-upload-status');

  if (y.status === 'uploading') {
    btn.disabled = true;
    btn.textContent = `Uploading… ${y.progress || 0}%`;
    bar.hidden = false;
    bar.querySelector('i').style.width = `${y.progress || 0}%`;
    msg.textContent = `Uploading bytes to YouTube (${y.progress || 0}%)…`;
  } else if (y.status === 'uploaded') {
    btn.disabled = false;
    btn.textContent = 'Upload Again';
    bar.hidden = false;
    bar.querySelector('i').style.width = '100%';
    const dt = y.publishAt ? new Date(y.publishAt).toLocaleString() : 'Public Short';
    const label = y.publishAt ? `Scheduled to publish on YouTube: <strong>${dt}</strong>` : 'Published successfully!';
    msg.innerHTML = `✓ ${label} <br><a href="${esc(y.videoUrl)}" target="_blank" rel="noreferrer" class="ghost yt-red" style="margin-top:8px;display:inline-block">Open Short on YouTube ↗</a>`;
    statusEl.innerHTML = `<div class="yt-box" style="margin:0">✓ Short uploaded. <a href="${esc(y.videoUrl)}" target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>`;
  } else if (y.status === 'error') {
    btn.disabled = false;
    btn.textContent = 'Upload & Schedule Short';
    bar.hidden = true;
    msg.textContent = '';
    statusEl.innerHTML = `<div class="err">${esc(y.error || 'Upload failed')}</div>`;
  }
}

function wireYouTubeModals() {
  $('#yt-save-creds')?.addEventListener('click', async () => {
    const clientId = $('#yt-client-id').value.trim();
    const clientSecret = $('#yt-client-secret').value.trim();
    const redirectUri = $('#yt-redirect-uri').value.trim();
    if (!clientId || !clientSecret) return toast('Please enter both Client ID and Client Secret', true);
    try {
      const st = await post('/api/youtube/credentials', { clientId, clientSecret, redirectUri });
      state.config.youtubeStatus = st;
      toast('Credentials saved');
      renderYouTubeSettings(st);
      renderYouTubeChip();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#yt-connect-btn')?.addEventListener('click', async () => {
    try {
      const redirectUri = $('#yt-redirect-uri').value;
      const { url } = await api(`/api/youtube/auth-url?redirectUri=${encodeURIComponent(redirectUri)}`);
      const w = window.open(url, 'yt_auth', 'width=560,height=700');
      if (!w) {
        window.location.href = url;
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#yt-disconnect-btn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect your YouTube channel?')) return;
    try {
      const st = await post('/api/youtube/disconnect');
      state.config.youtubeStatus = st;
      toast('YouTube channel disconnected');
      renderYouTubeSettings(st);
      renderYouTubeChip();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#ytu-mode')?.addEventListener('change', () => {
    const isSchedule = $('#ytu-mode').value === 'schedule';
    $('#ytu-time-box').hidden = !isSchedule;
    $('#ytu-quick-times').hidden = !isSchedule;
  });

  $('#ytu-quick-times')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const offset = b.dataset.offset;
    const preset = b.dataset.preset;
    const d = new Date();
    if (offset) {
      d.setTime(d.getTime() + Number(offset) * 3600000);
    } else if (preset === 'tonight') {
      if (d.getHours() >= 20) d.setDate(d.getDate() + 1);
      d.setHours(20, 0, 0, 0);
    } else if (preset === 'tomorrow_morning') {
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
    } else if (preset === 'tomorrow_evening') {
      d.setDate(d.getDate() + 1);
      d.setHours(18, 0, 0, 0);
    }
    $('#ytu-time').value = toLocalISOString(d);
  });

  $('#ytu-submit')?.addEventListener('click', async () => {
    if (!ytActiveClipId) return;
    const c = clipOf(ytActiveClipId);
    if (!c) return;
    if (!state.config.youtubeStatus?.connected) {
      toast('Please connect your YouTube account first', true);
      openYouTubeSettingsModal();
      return;
    }
    const mode = $('#ytu-mode').value;
    let publishAt = null;
    let privacyStatus = mode;
    if (mode === 'schedule') {
      const v = $('#ytu-time').value;
      if (!v) return toast('Please choose a scheduled time', true);
      const d = new Date(v);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now() + 60000) {
        return toast('Scheduled time must be at least 2 minutes in the future', true);
      }
      publishAt = d.toISOString();
      privacyStatus = 'private';
    }

    const title = $('#ytu-title').value.trim();
    const description = $('#ytu-desc').value.trim();
    const hashtags = $('#ytu-tags').value.split(/[\s,]+/).map((h) => h.replace(/^#/, '')).filter(Boolean);

    const btn = $('#ytu-submit');
    btn.disabled = true;
    btn.textContent = 'Uploading to YouTube…';
    $('#ytu-bar').hidden = false;
    $('#ytu-bar i').style.width = '10%';
    $('#ytu-msg').textContent = 'Connecting and uploading video to YouTube…';

    try {
      const res = await post(`/api/clips/${c.id}/youtube`, {
        title,
        description,
        hashtags,
        publishAt,
        privacyStatus,
      });
      const i = state.project.clips.findIndex((x) => x.id === c.id);
      if (i !== -1) state.project.clips[i] = { ...state.project.clips[i], ...res };
      updateCards();
      toast('Upload started in background');
      syncYouTubeUploadModal(c.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Upload & Schedule Short';
      $('#ytu-bar').hidden = true;
      $('#ytu-msg').textContent = '';
      toast(err.message, true);
    }
  });

  window.addEventListener('message', async (ev) => {
    if (ev.data?.type === 'youtube-connected') {
      toast('YouTube connected successfully!');
      const st = await api('/api/youtube/status').catch(() => ({}));
      state.config.youtubeStatus = st;
      renderYouTubeChip();
      const modal = $('#yt-modal');
      if (modal?.open) renderYouTubeSettings(st);
      const uModal = $('#yt-upload-modal');
      if (uModal?.open && ytActiveClipId) openYouTubeUploadModal(ytActiveClipId);
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#editor').hidden || $('#react-pop')?.open || $('#yt-modal')?.open || $('#yt-upload-modal')?.open) return;
  $('#ed-close').click();
});
init().catch((e) => toast(e.message, true));

