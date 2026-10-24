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

const state = { config: {}, music: [], projects: [], pid: null, project: null, draft: null, origText: '', previewMode: 'original', saveTimer: null, recorder: null, tasks: [] };

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), bad ? 6000 : 2600);
}

// ---------- background tasks UI ----------
async function fetchTasks() {
  try {
    const res = await api('/api/tasks');
    state.tasks = res.tasks || [];
    renderTasksBadge();
    if ($('#tasks-modal')?.open) {
      renderTasksModal();
    }
  } catch {}
}

function renderTasksBadge() {
  const btn = $('#tasks-btn');
  const label = $('#tasks-label');
  if (!btn || !label) return;
  const count = state.tasks?.length || 0;
  label.textContent = `Tasks (${count})`;
  if (count > 0) {
    btn.classList.add('has-active');
    btn.title = `${count} background task(s) active. Click to view or cancel.`;
  } else {
    btn.classList.remove('has-active');
    btn.title = 'No active background tasks';
  }
}

function renderTasksModal() {
  const cont = $('#tasks-list-container');
  const cancelAllBtn = $('#tasks-cancel-all-btn');
  const sub = $('#tasks-count-sub');
  if (!cont) return;

  const tasks = state.tasks || [];
  if (sub) {
    sub.textContent = tasks.length
      ? `${tasks.length} task(s) currently active or queued in background`
      : 'All background tasks idle';
  }
  if (cancelAllBtn) {
    cancelAllBtn.disabled = tasks.length === 0;
  }

  if (!tasks.length) {
    cont.innerHTML = `
      <div class="tasks-empty">
        <h4>No background tasks running</h4>
        <p class="note">When videos are being analyzed or clips are rendering, they will appear here with live progress and cancel buttons.</p>
      </div>`;
    return;
  }

  cont.innerHTML = `
    <div class="tasks-list">
      ${tasks
        .map((t) => {
          const isAnalysis = t.type === 'analysis';
          const badgeClass = isAnalysis ? 'analysis' : 'render';
          const badgeText = isAnalysis ? 'Analysis' : 'Render';
          const displayTitle = t.title || (isAnalysis ? 'Project Video' : 'Clip');
          return `
            <div class="task-card" data-task-id="${esc(t.id)}">
              <div class="task-card-info">
                <div class="task-card-head">
                  <span class="task-badge ${badgeClass}">${badgeText}</span>
                  <span class="task-card-title">${esc(displayTitle)}</span>
                </div>
                <div class="task-card-stage">
                  <span>${esc(t.stage)}</span>
                  <span>·</span>
                  <strong>${t.progress}%</strong>
                </div>
                <div class="bar"><i style="width:${Math.max(3, t.progress)}%"></i></div>
              </div>
              <div class="task-actions">
                <button type="button" class="ghost danger task-cancel-btn" data-cancel-task="${esc(t.id)}" title="Stop this background task">✕ Stop</button>
              </div>
            </div>`;
        })
        .join('')}
    </div>`;
}

function wireBackgroundTasks() {
  const btn = $('#tasks-btn');
  const modal = $('#tasks-modal');
  const cancelAllBtn = $('#tasks-cancel-all-btn');
  const cont = $('#tasks-list-container');

  btn?.addEventListener('click', () => {
    fetchTasks();
    modal?.showModal();
    renderTasksModal();
  });

  cancelAllBtn?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to stop and cancel ALL running and queued background tasks?')) return;
    cancelAllBtn.disabled = true;
    try {
      const res = await post('/api/tasks/cancel-all', {});
      toast(`Stopped ${res.cancelledCount || 0} background task(s)`);
      await fetchTasks();
      await loadProjects();
      if (state.pid) await selectProject(state.pid);
    } catch (err) {
      toast(err.message, true);
    } finally {
      cancelAllBtn.disabled = false;
    }
  });

  cont?.addEventListener('click', async (e) => {
    const cancelBtn = e.target.closest('[data-cancel-task]');
    if (!cancelBtn) return;
    const taskId = cancelBtn.dataset.cancelTask;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Stopping…';
    try {
      await post(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {});
      toast('Task cancelled successfully');
      await fetchTasks();
      await loadProjects();
      if (state.pid) await selectProject(state.pid);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- init ----------
async function init() {
  if (window.location.search.includes('youtube=connected')) {
    toast('YouTube account connected successfully!');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  wireBackgroundTasks();
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
  wireYouTubeCookies();
  fetchYouTubeCookiesInfo();

  if (!c.youtube) $('[data-src=youtube]').hidden = true;
  const lim = c.tokenLimits || {};
  const note = $('#token-note');
  if (note) note.textContent = `Each project can spend ${Number(lim.project || 0).toLocaleString()} analysis tokens. One clip's post copy is capped at ${Number(lim.clip || 0).toLocaleString()}. The Clips field is how many moments are analyzed.`;
  $('#aspect').innerHTML = c.aspects.map((a) => `<option>${a}</option>`).join('');
  await loadProjects();
  if (!state.pid && state.projects.length) {
    const hash = window.location.hash.slice(1);
    const target = state.projects.find((p) => p.id === hash) || state.projects[0];
    if (target) await selectProject(target.id);
  } else {
    renderMain();
  }
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
      const meta = p.status === 'ready' ? `${p.clipCount} clips` : p.status === 'cancelled' ? 'Cancelled' : p.status === 'error' ? 'Failed' : `${p.stage} ${p.progress}%`;
      return `<li data-id="${p.id}" class="${p.id === state.pid ? 'on' : ''}"><span class="name">${esc(p.title || 'Untitled')}</span><span class="meta">${esc(meta)}</span></li>`;
    })
    .join('');
}
$('#plist').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) selectProject(li.dataset.id);
});
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  if (hash && hash !== state.pid && state.projects?.some((p) => p.id === hash)) {
    selectProject(hash);
  }
});

async function selectProject(id) {
  state.pid = id;
  if (window.location.hash.slice(1) !== id) {
    window.location.hash = id;
  }
  closeEditor();
  state.project = await api(`/api/projects/${id}`);
  renderList();
  renderMain();
}

async function tick() {
  try {
    await fetchTasks();
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
  const head = `<div class="head"><div><h2>${esc(p.title || 'Untitled')}</h2><p class="sub">${p.duration ? `${fmt(p.duration)} long` : ''}${p.language ? ` · ${esc(p.language)}` : ''}${p.method ? ` · picked by ${p.method === 'llm' ? 'AI' : p.method}` : ''}${tokens}</p></div><div style="display:flex;gap:8px;align-items:center">${p.hasTranscript && state.config.llm && p.clips?.length ? `<button class="ghost" id="fix-all-captions" title="Automatically fix speech-to-text typos across all clips">✨ AI Fix All Captions</button>` : ''}<button class="ghost danger" id="del">Delete project</button></div></div>`;
  let body = '';
  if (p.status === 'error') {
    const isYtAuthError = /bot verification|cookies|LOGIN_REQUIRED|Sign in to confirm|Age Restriction|verification required/i.test(p.error || '');
    body = `<div class="err" style="border-radius:10px;padding:16px;line-height:1.5">
      <div style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:var(--danger,#c6283e);margin-bottom:8px">
        <span>⚠️ Video Acquisition Error</span>
      </div>
      <div style="white-space:pre-wrap;margin-bottom:14px;color:var(--ink);font-size:13.5px">${esc(p.error)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(198,40,62,0.2)">
        <button type="button" class="primary" id="retry-analysis-btn" style="margin:0;padding:6px 14px;font-size:13px">🔄 Retry Video Analysis</button>
        ${isYtAuthError ? `<button type="button" class="ghost" id="err-cookies-setup-btn" style="padding:6px 14px;font-size:13px">⚙️ Cookies Setup</button><button type="button" class="ghost" id="err-switch-upload-btn" style="padding:6px 14px;font-size:13px">📁 Switch to File Upload</button>` : ''}
      </div>
    </div>`;
  }
  else if (p.status === 'cancelled') body = `<div class="progress" style="border-color:#fca5a5;background:#fff5f5"><strong style="color:var(--danger)">Analysis was cancelled.</strong><p class="note">You can delete this project or start a new video above.</p></div>`;
  else if (p.status !== 'ready') body = `<div class="progress"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px"><strong>${esc(p.stage)}</strong><button type="button" class="ghost danger" id="cancel-analysis" style="padding:4px 10px;font-size:12px;font-weight:600" title="Stop video analysis">✕ Cancel Analysis</button></div><div class="bar"><i style="width:${p.progress}%"></i></div><p class="note">This runs in the background. You can leave this page or cancel anytime.</p></div>`;
  else {
    const hot = Math.max(...p.clips.map((c) => c.score));
    body = `<div class="ruler" aria-label="Where the clips sit in the original video">${p.clips
      .map((c) => c.segments.map((g) => `<button data-edit="${c.id}" class="${c.score >= hot - 5 ? 'hot' : ''}" style="left:${(g.start / p.duration) * 100}%;width:${Math.max(0.6, ((g.end - g.start) / p.duration) * 100)}%" title="${esc(c.title)} (${c.score})"></button>`).join(''))
      .join('')}</div><div class="ticks"><span>0:00</span><span>${fmt(p.duration)}</span></div><div class="grid" id="grid">${p.clips.map(cardHTML).join('')}</div>`;
  }
  m.innerHTML = head + body;

  const retryBtn = $('#retry-analysis-btn');
  if (retryBtn) {
    retryBtn.onclick = async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
      try {
        await post(`/api/projects/${p.id}/retry`, {});
        toast('Retrying video analysis…');
        await loadProjects();
        await selectProject(p.id);
      } catch (err) {
        toast(err.message, true);
        retryBtn.disabled = false;
        retryBtn.textContent = '🔄 Retry Video Analysis';
      }
    };
  }
  const errCookiesBtn = $('#err-cookies-setup-btn');
  if (errCookiesBtn) {
    errCookiesBtn.onclick = () => openYouTubeCookiesModal();
  }
  const errUploadBtn = $('#err-switch-upload-btn');
  if (errUploadBtn) {
    errUploadBtn.onclick = () => {
      const uploadTab = document.querySelector('[data-src="upload"]');
      if (uploadTab) uploadTab.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  const cancelAnalysisBtn = $('#cancel-analysis');
  if (cancelAnalysisBtn) {
    cancelAnalysisBtn.onclick = async () => {
      if (!confirm('Cancel video analysis for this project?')) return;
      cancelAnalysisBtn.disabled = true;
      cancelAnalysisBtn.textContent = 'Cancelling…';
      try {
        await post(`/api/projects/${p.id}/cancel`, {});
        toast('Analysis cancelled');
        await fetchTasks();
        await selectProject(p.id);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  const fixAllBtn = $('#fix-all-captions');
  if (fixAllBtn) {
    fixAllBtn.onclick = async () => {
      fixAllBtn.disabled = true;
      const old = fixAllBtn.textContent;
      fixAllBtn.textContent = 'Fixing captions with AI…';
      try {
        const r = await post(`/api/projects/${p.id}/proofread-captions`, {});
        await selectProject(p.id);
        toast(`Fixed captions for ${r.fixedCount} clip(s) with AI!`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        fixAllBtn.disabled = false;
        fixAllBtn.textContent = old;
      }
    };
  }
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
        ? `<a class="ghost yt-red" target="_blank" rel="noreferrer" href="${c.youtube.videoUrl}" title="Open Short on YouTube">Short ↗</a>`
        : `<button type="button" class="ghost yt-red" data-yt="${c.id}" title="${c.youtube?.status === 'uploading' ? 'Uploading Short…' : 'Upload & Schedule YouTube Short'}">${c.youtube?.status === 'uploading' ? 'Uploading…' : (c.youtube?.status === 'uploaded' ? 'YouTube' : 'Post Short')}</button>`)
    : '';
  const cancelClipBtn = (c.status === 'rendering' || c.status === 'queued')
    ? `<button type="button" class="ghost danger" data-cancel-clip="${c.id}" title="Stop rendering this clip">✕ Stop</button>`
    : '';

  return `<article class="clip" data-clip="${c.id}">
    <button class="th" data-edit="${c.id}" aria-label="Edit ${esc(c.title)}"><img src="${thumbOf(p, c)}" alt="" loading="lazy"><span class="score">${c.score}</span>${st}</button>
    <div class="body"><h3>${esc(c.title)}</h3><div class="range">${fmt(c.segments[0].start)} to ${fmt(c.segments[c.segments.length - 1].end)} · ${Math.round(dur)}s · ${c.aspect}${parts}${tok}</div>
    <div class="why">${esc(c.reason)}</div>
    <div class="acts"><button class="ghost" data-edit="${c.id}" title="Edit clip">Edit</button><button class="ghost" data-react="${c.id}" title="Record reaction">React</button>${c.outputFile ? `<a class="ghost" download href="/media/${p.id}/${c.outputFile}?v=${c.renderedAt}" title="Download rendered clip">Download</a>` : ''}${ytAction}${cancelClipBtn}</div></div></article>`;
}
function updateCards() {
  const g = $('#grid');
  if (!g) return;
  g.innerHTML = state.project.clips.map(cardHTML).join('');
}
$('#main').addEventListener('click', async (e) => {
  const cc = e.target.closest('[data-cancel-clip]');
  if (cc) {
    const clipId = cc.dataset.cancelClip;
    cc.disabled = true;
    cc.textContent = 'Stopping…';
    try {
      await post(`/api/clips/${clipId}/cancel`, {});
      toast('Render cancelled');
      await fetchTasks();
      if (state.pid) await selectProject(state.pid);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
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

let activeStudioTool = 'colors';

function renderEditor() {
  const d = state.draft;
  const s = d.settings;
  const p = state.project;
  const dur = d.segments.reduce((a, g) => a + g.end - g.start, 0);

  $('#editor').innerHTML = `
  <header class="studio-topbar">
    <div class="studio-top-left">
      <button type="button" class="studio-back-btn" id="ed-close">✕ Back to clips</button>
      <span class="studio-pill">🌐 ${esc(p.language || 'English')}</span>
      <span class="studio-title-badge" title="${esc(d.title)}">${esc(d.title || 'Untitled Clip')}</span>
    </div>

    <div class="studio-tabs">
      <button type="button" class="studio-pill on" data-cat="Key insights">Key insights</button>
      <button type="button" class="studio-pill" data-cat="Hot take">Hot take</button>
      <button type="button" class="studio-pill" data-cat="Quotable">Quotable</button>
      <button type="button" class="studio-pill" data-cat="Viral hook">Viral hook</button>
    </div>

    <div style="display:flex;align-items:center;gap:8px">
      <span class="studio-pill" style="color:var(--tape,#ffd23f);font-weight:700">★ ${d.score || 85}/100</span>
      <select id="ed-aspect-sel" class="studio-pill" style="background:#141a26;color:#fff;border-color:rgba(255,255,255,0.15);cursor:pointer">
        ${state.config.aspects.map(a => `<option value="${a}" ${d.aspect === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
    </div>
  </header>

  <main class="studio-stage">
    <!-- Left Toolbar -->
    <aside class="studio-toolbar left">
      <button type="button" class="tool-btn ${activeStudioTool === 'style' ? 'active' : ''}" data-tool="style" title="Presets & Look"><span class="ico">🎨</span><span>Style</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'colors' ? 'active' : ''}" data-tool="colors" title="Colors & Accents"><span class="ico">🟢</span><span>Colors</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'captions' ? 'active' : ''}" data-tool="captions" title="Subtitles & Font"><span class="ico">💬</span><span>Caption</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'hook' ? 'active' : ''}" data-tool="hook" title="Top Opener & Hook Title"><span class="ico">🪝</span><span>Hook</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'title' ? 'active' : ''}" data-tool="title" title="Title & Post Copy"><span class="ico">🔤</span><span>Title</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'subtitle' ? 'active' : ''}" data-tool="subtitle" title="Transcript & AI Auto-Fix"><span class="ico">📝</span><span>Subtitle</span></button>
      <button type="button" class="tool-btn" id="tool-safe-zones" title="Toggle Social Safe Zones Guide"><span class="ico">#️⃣</span><span>Safe zones</span></button>
    </aside>

    <!-- Left Flyout Drawer -->
    <div class="studio-flyout left-dock" id="studio-flyout-left" hidden></div>

    <!-- Center Canvas -->
    <section class="studio-canvas">
      <div class="phone-mockup" id="phone-mockup">
        <video id="pv" playsinline preload="auto"></video>

        <!-- Real-time on-screen title/opener overlay -->
        <div class="pv-top-title" id="pv-top-title">${esc(s.title.text || d.hook || '')}</div>

        <!-- Real-time on-screen caption overlay -->
        <div class="pv-bottom-caption" id="pv-bottom-caption">${esc(d.title || '')}</div>

        <!-- Social Media Safe Zones overlay -->
        <div class="pv-safe-zones" id="pv-safe-zones" hidden>
          <div style="font-size:10px;opacity:0.6;letter-spacing:1px">SHORT TITLE / TOP SAFE AREA</div>
          <div class="sz-right-rail">
            <span>❤️ 98K</span>
            <span>💬 1.2K</span>
            <span>↗️ Share</span>
            <span>💿 Audio</span>
          </div>
          <div class="sz-bot-rail">CAPTION & MUSIC SAFE BOUNDARY</div>
        </div>

        <!-- Live Rendering Progress Overlay -->
        <div class="pv-render-overlay" id="pv-render-overlay" hidden>
          <div class="pv-spinner"></div>
          <div class="pv-render-text" id="pv-render-label">Almost ready to share... 0%</div>
          <div class="pv-render-bar"><i id="pv-render-bar-fill" style="width:0%"></i></div>
        </div>
      </div>

      <!-- Player Controls -->
      <div class="studio-player-controls">
        <button type="button" class="sp-btn" id="sp-play" title="Play / Pause">▶</button>
        <span class="sp-time" id="sp-cur-time">0:00</span>
        <input type="range" class="sp-seek" id="sp-seek" min="0" max="100" value="0" step="0.1">
        <span class="sp-time" id="sp-dur-time">${Math.round(dur)}s</span>
        <button type="button" class="sp-btn" id="sp-vol" title="Mute / Unmute">🔊</button>
      </div>
    </section>

    <!-- Right Flyout Drawer -->
    <div class="studio-flyout right-dock" id="studio-flyout-right" hidden></div>

    <!-- Right Toolbar -->
    <aside class="studio-toolbar right">
      <button type="button" class="tool-btn ${activeStudioTool === 'bg' ? 'active' : ''}" data-tool="bg" title="Background & Fill"><span class="ico">⬛</span><span>${s.bg === 'fit' ? 'Black' : s.bg === 'blur' ? 'Blur' : 'Fill'}</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'crop' ? 'active' : ''}" data-tool="crop" title="Crop & Face Centering"><span class="ico">✂️</span><span>${s.bg === 'smart' ? 'Auto' : 'Crop'}</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'speed' ? 'active' : ''}" data-tool="speed" title="Playback Speed"><span class="ico">⚡</span><span>1x</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'music' ? 'active' : ''}" data-tool="music" title="Background Music"><span class="ico">🎵</span><span>Music</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'cut' ? 'active' : ''}" data-tool="cut" title="Segments & Supercut"><span class="ico">🎞️</span><span>Cut</span></button>
      <button type="button" class="tool-btn ${activeStudioTool === 'react' ? 'active' : ''}" data-tool="react" title="Reaction Webcam & Voiceover"><span class="ico">🔴</span><span>React</span></button>
    </aside>
  </main>

  <footer class="studio-footbar">
    <div class="studio-foot-left">
      <button type="button" class="studio-btn ghost" id="apply-all-btn" title="Copy this exact look and settings to all clips in this project">Apply to all clips</button>
      <button type="button" class="studio-btn ghost" id="reset-look-btn" title="Reset look back to defaults">Reset look</button>
      <div class="inline" style="margin:0;gap:4px">
        <button type="button" class="studio-pill ${state.previewMode === 'original' ? 'on' : ''}" data-pm="original">Original</button>
        <button type="button" class="studio-pill ${state.previewMode === 'rendered' ? 'on' : ''}" data-pm="rendered" ${d.outputFile ? '' : 'disabled'}>Rendered</button>
      </div>
    </div>

    <div class="studio-foot-right">
      <span id="rtext" style="font-size:12px;color:#94a3b8;margin-right:8px"></span>
      <button type="button" class="studio-btn ghost danger" id="ed-stop-render" hidden>Stop Render</button>
      <a class="studio-btn ghost" id="dl" download hidden>⬇ Download MP4</a>
      ${d.outputFile ? '<button type="button" class="studio-btn yt" id="ed-yt-btn">Post Short ↗</button>' : ''}
      <button type="button" class="studio-btn primary" id="render">🎬 Render clip</button>
    </div>
  </footer>`;

  wireEditor();
  setPreview();
  syncLiveOverlays();
  syncEditorStatus();
  openFlyout(activeStudioTool);
}

function syncLiveOverlays() {
  const d = state.draft;
  if (!d) return;
  const s = d.settings;

  // Top Opener Title ("सच या झूठ?")
  const topTitle = $('#pv-top-title');
  if (topTitle) {
    topTitle.textContent = s.title?.text || d.hook || '';
    topTitle.style.display = s.title?.enabled === false ? 'none' : 'block';
    const accent = s.captions?.accent || '#00e5a3';
    topTitle.style.color = accent;
    topTitle.style.textShadow = `0 0 16px ${accent}bb, 0 2px 4px rgba(0,0,0,0.95)`;
    if (s.captions?.font) topTitle.style.fontFamily = `"${s.captions.font}", "Nirmala UI", sans-serif`;
    topTitle.style.textTransform = s.title?.upper ? 'uppercase' : 'none';
  }

  // Bottom Subtitle Preview ("मास्टरबेशन")
  const botCaption = $('#pv-bottom-caption');
  if (botCaption) {
    const raw = (s.captions?.textOverride || state.origText || d.title || '').trim();
    const words = raw.split(/\s+/).slice(0, s.captions?.maxWords || 3);
    const accent = s.captions?.accent || '#00e5a3';
    if (words.length > 0) {
      botCaption.innerHTML = words.map((w, idx) => idx === 0 ? `<span class="pv-hl" style="color:${accent};text-shadow:0 0 14px ${accent}bb">${esc(w)}</span>` : esc(w)).join(' ');
    } else {
      botCaption.textContent = '';
    }
    botCaption.style.display = s.captions?.enabled === false ? 'none' : 'block';
    botCaption.style.color = s.captions?.color || '#ffffff';
    if (s.captions?.font) botCaption.style.fontFamily = `"${s.captions.font}", "Nirmala UI", sans-serif`;
    botCaption.style.textTransform = s.captions?.upper ? 'uppercase' : 'none';
    if (s.captions?.position === 'top') {
      botCaption.style.bottom = 'auto';
      botCaption.style.top = '22%';
    } else if (s.captions?.position === 'middle') {
      botCaption.style.bottom = '46%';
      botCaption.style.top = 'auto';
    } else {
      botCaption.style.bottom = '14%';
      botCaption.style.top = 'auto';
    }
  }

  // Phone Mockup Aspect & Background
  const mockup = $('#phone-mockup');
  if (mockup) {
    if (d.aspect === '1:1') mockup.style.aspectRatio = '1/1';
    else if (d.aspect === '16:9') mockup.style.aspectRatio = '16/9';
    else mockup.style.aspectRatio = '9/16';

    if (s.bg === 'fit') mockup.style.background = s.fitColor || '#000000';
    else mockup.style.background = '#000000';
  }
}

function openFlyout(tool) {
  activeStudioTool = tool;
  const leftFlyout = $('#studio-flyout-left');
  const rightFlyout = $('#studio-flyout-right');
  if (!leftFlyout || !rightFlyout) return;

  // Update active state on tool buttons
  document.querySelectorAll('.tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });

  if (!tool) {
    leftFlyout.hidden = true;
    rightFlyout.hidden = true;
    return;
  }

  const isLeft = ['style', 'colors', 'captions', 'hook', 'title', 'subtitle'].includes(tool);
  const targetFlyout = isLeft ? leftFlyout : rightFlyout;
  const otherFlyout = isLeft ? rightFlyout : leftFlyout;
  otherFlyout.hidden = true;

  targetFlyout.innerHTML = buildFlyoutHTML(tool);
  targetFlyout.hidden = false;
  wireFlyoutControls(targetFlyout, tool);
}

function buildFlyoutHTML(tool) {
  const d = state.draft;
  const s = d.settings;
  const p = state.project;
  const musicOpts = [''].concat(state.music.map((m) => m.id));
  const musicLabels = Object.fromEntries([['', 'No music']].concat(state.music.map((m) => [m.id, m.name])));

  if (tool === 'style') {
    return `
      <div class="flyout-head"><h4>🎨 Style Presets</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <p class="note" style="margin:0 0 10px">1-Click Viral Visual Styles:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="preset-card ${s.captions.accent === '#00e5a3' ? 'on' : ''}" data-preset="teal-glow">
          <div><strong style="color:#00e5a3">Teal Glow (Podcast Viral)</strong><div style="font-size:11px;color:#94a3b8">Nirmala UI, Neon Cyan glow, Black fit bars</div></div>
          <span style="font-size:18px">🔥</span>
        </div>
        <div class="preset-card ${s.captions.accent === '#00f3ff' ? 'on' : ''}" data-preset="cyber-neon">
          <div><strong style="color:#00f3ff">Cyberpunk Neon</strong><div style="font-size:11px;color:#94a3b8">Impact font, Cyan pop, Blur background</div></div>
          <span style="font-size:18px">⚡</span>
        </div>
        <div class="preset-card ${s.captions.accent === '#ffd23f' ? 'on' : ''}" data-preset="gold-hormozi">
          <div><strong style="color:#ffd23f">Gold VIP (Hormozi style)</strong><div style="font-size:11px;color:#94a3b8">Impact font, Gold highlight, Face crop</div></div>
          <span style="font-size:18px">👑</span>
        </div>
        <div class="preset-card ${s.captions.accent === '#ffffff' ? 'on' : ''}" data-preset="clean-minimal">
          <div><strong style="color:#ffffff">Clean Minimal</strong><div style="font-size:11px;color:#94a3b8">Arial font, Pure white, Solid background</div></div>
          <span style="font-size:18px">🤍</span>
        </div>
      </div>`;
  }

  if (tool === 'colors') {
    const swatches = ['#00e5a3', '#00d2ff', '#ffd23f', '#ff2d78', '#ff6b35', '#ffffff'];
    return `
      <div class="flyout-head"><h4>🟢 Colors & Glow</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Highlight & Glow Accent</label>
      <div class="swatches">
        ${swatches.map((c) => `<div class="swatch ${s.captions.accent?.toLowerCase() === c.toLowerCase() ? 'on' : ''}" style="background:${c}" data-swatch="${c}"></div>`).join('')}
      </div>
      <label style="margin-top:12px">Custom Accent Color <input type="color" data-k="settings.captions.accent" value="${s.captions.accent || '#00e5a3'}"></label>
      <label style="margin-top:12px">Caption Text Color <input type="color" data-k="settings.captions.color" value="${s.captions.color || '#ffffff'}"></label>`;
  }

  if (tool === 'captions') {
    return `
      <div class="flyout-head"><h4>💬 Subtitles & Captions</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label class="check" style="color:#fff"><input type="checkbox" data-k="settings.captions.enabled" ${s.captions.enabled ? 'checked' : ''}> Burn captions into video</label>
      <label>Caption Style
        <select data-k="settings.captions.style">
          <option value="highlight" ${s.captions.style === 'highlight' ? 'selected' : ''}>Highlight word</option>
          <option value="pop" ${s.captions.style === 'pop' ? 'selected' : ''}>Word pop</option>
          <option value="karaoke" ${s.captions.style === 'karaoke' ? 'selected' : ''}>Karaoke sweep</option>
          <option value="plain" ${s.captions.style === 'plain' ? 'selected' : ''}>Plain</option>
        </select>
      </label>
      <label>Font (Nirmala UI recommended for Hindi)
        <select data-k="settings.captions.font">
          ${['Nirmala UI', 'Mangal', 'Arial', 'Impact', 'Verdana', 'Georgia', 'Courier New'].map(f => `<option value="${f}" ${s.captions.font === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </label>
      <div class="two">
        <label>Words per line <input type="number" min="1" max="6" data-k="settings.captions.maxWords" value="${s.captions.maxWords || 3}"></label>
        <label>Position
          <select data-k="settings.captions.position">
            <option value="bottom" ${s.captions.position === 'bottom' ? 'selected' : ''}>Bottom</option>
            <option value="middle" ${s.captions.position === 'middle' ? 'selected' : ''}>Middle</option>
            <option value="top" ${s.captions.position === 'top' ? 'selected' : ''}>Top</option>
          </select>
        </label>
      </div>
      <label>Font Size <input type="range" min="0.025" max="0.08" step="0.002" data-k="settings.captions.size" value="${s.captions.size || 0.045}"></label>
      <label class="check" style="color:#fff"><input type="checkbox" data-k="settings.captions.upper" ${s.captions.upper ? 'checked' : ''}> Capital letters</label>`;
  }

  if (tool === 'hook') {
    return `
      <div class="flyout-head"><h4>🪝 Top Opener & Hook</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label class="check" style="color:#fff"><input type="checkbox" data-k="settings.title.enabled" ${s.title.enabled ? 'checked' : ''}> Show on-screen opener</label>
      <label>Opener Text (shown on top like "सच या झूठ?")
        <input data-k="settings.title.text" value="${esc(s.title.text || d.hook || '')}" placeholder="e.g. सच या झूठ?">
      </label>
      <div class="two">
        <label>Duration (s) <input type="number" min="1" max="10" step="0.5" data-k="settings.title.seconds" value="${s.title.seconds || 3}"></label>
        <label class="check" style="margin-top:22px;color:#fff"><input type="checkbox" data-k="settings.title.upper" ${s.title.upper ? 'checked' : ''}> Capital text</label>
      </div>`;
  }

  if (tool === 'title') {
    return `
      <div class="flyout-head"><h4>🔤 Title & Social Copy</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Clip Title <input data-k="title" value="${esc(d.title || '')}"></label>
      <label>Post Description <textarea data-k="description" rows="3">${esc(d.description || '')}</textarea></label>
      <label>Hashtags <input data-k="hashtags" value="${esc((d.hashtags || []).map((h) => '#' + h).join(' '))}"></label>
      <div class="inline" style="margin-top:10px">
        <button type="button" class="studio-btn ghost" id="desc-go">✨ AI Write Copy</button>
        <button type="button" class="studio-btn ghost" id="desc-copy">📋 Copy Text</button>
      </div>`;
  }

  if (tool === 'subtitle') {
    return `
      <div class="flyout-head"><h4>📝 Transcript & Subtitles</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Edit Transcript Words:
        <textarea id="f-text" rows="5" ${p.hasTranscript ? '' : 'disabled placeholder="No transcript found."'}>${esc(s.captions.textOverride || state.origText || '')}</textarea>
      </label>
      <div class="inline" style="margin-top:10px">
        <button type="button" class="studio-btn primary" id="fix-text" ${p.hasTranscript && state.config.llm ? '' : 'disabled'}>✨ AI Auto-Fix Captions</button>
        <button type="button" class="studio-btn ghost" id="revert-text" ${p.hasTranscript ? '' : 'disabled'}>↺ Reset Audio</button>
      </div>
      <p class="note" style="margin-top:8px">AI Auto-Fix cleans typos and sets Hindi font to Nirmala UI automatically.</p>`;
  }

  if (tool === 'bg') {
    return `
      <div class="flyout-head"><h4>⬛ Background & Fit</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Fill Mode
        <select data-k="settings.bg">
          <option value="fit" ${s.bg === 'fit' ? 'selected' : ''}>Solid colour bars (Black)</option>
          <option value="blur" ${s.bg === 'blur' ? 'selected' : ''}>Blurred video background</option>
          <option value="crop" ${s.bg === 'crop' ? 'selected' : ''}>Crop to fill</option>
          <option value="smart" ${s.bg === 'smart' ? 'selected' : ''}>Crop to face (Smart)</option>
        </select>
      </label>
      <label>Bars Color <input type="color" data-k="settings.fitColor" value="${s.fitColor || '#000000'}"></label>
      <label>Color Filter
        <select data-k="settings.filter">
          ${state.config.filters.map(f => `<option value="${f}" ${s.filter === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </label>`;
  }

  if (tool === 'crop') {
    return `
      <div class="flyout-head"><h4>✂️ Crop & Framing</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Manual Crop Position <input type="range" min="0" max="1" step="0.01" data-k="settings.cropX" value="${s.cropX ?? 0.5}"></label>
      <p class="note" style="margin-top:8px">Use 0.5 for centered framing. 'Smart' mode in Background auto-tracks faces.</p>`;
  }

  if (tool === 'speed') {
    return `
      <div class="flyout-head"><h4>⚡ Playback Speed</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <div class="inline" style="gap:8px">
        ${[0.75, 1, 1.25, 1.5, 2].map(sp => `<button type="button" class="studio-pill ${sp === 1 ? 'on' : ''}" data-speed="${sp}">${sp}x</button>`).join('')}
      </div>`;
  }

  if (tool === 'music') {
    return `
      <div class="flyout-head"><h4>🎵 Background Music</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <label>Music Track
        <select data-k="settings.music.track">
          ${musicOpts.map(m => `<option value="${m}" ${s.music.track === m ? 'selected' : ''}>${musicLabels[m] || m}</option>`).join('')}
        </select>
      </label>
      <label>Music Volume <input type="range" min="0" max="0.6" step="0.01" data-k="settings.music.volume" value="${s.music.volume ?? 0.18}"></label>
      <p class="note" style="margin-top:8px">Music volume dips automatically (audio ducking) when dialogue occurs.</p>`;
  }

  if (tool === 'cut') {
    return `
      <div class="flyout-head"><h4>🎞️ Cut & Segments</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <div id="segs">${d.segments.map(segRow).join('')}</div>
      <button type="button" class="studio-btn ghost" id="add-seg" style="margin-top:10px;width:100%">+ Add Segment</button>`;
  }

  if (tool === 'react') {
    return `
      <div class="flyout-head"><h4>🔴 Reaction Webcam & Voice</h4><button type="button" class="flyout-close" data-close-flyout>✕</button></div>
      <div id="voice-status" style="margin-bottom:8px">${voiceStatus()}</div>
      <div class="inline" style="gap:8px">
        <button type="button" class="studio-btn ghost" id="rec-voice">🎙️ Voice</button>
        <button type="button" class="studio-btn ghost" id="rec-face">📹 Camera</button>
      </div>
      <label style="margin-top:10px">Reaction Position</label>
      <div class="inline" id="bubble-pos">${bubbleButtons(s.bubble)}</div>
      <label style="margin-top:10px">Reaction Size <input type="range" min="0.16" max="0.46" step="0.02" data-k="settings.bubble.size" value="${s.bubble?.size ?? 0.28}"></label>`;
  }

  return '';
}

function wireFlyoutControls(flyout, tool) {
  flyout.querySelector('[data-close-flyout]')?.addEventListener('click', () => openFlyout(null));

  // Style Presets
  flyout.querySelectorAll('[data-preset]').forEach((card) => {
    card.onclick = () => {
      const pName = card.dataset.preset;
      const s = state.draft.settings;
      if (pName === 'teal-glow') {
        s.captions.accent = '#00e5a3';
        s.captions.font = 'Nirmala UI';
        s.captions.style = 'highlight';
        s.bg = 'fit';
        s.fitColor = '#000000';
        s.title.enabled = true;
        s.title.text = s.title.text || state.draft.hook || 'सच या झूठ?';
      } else if (pName === 'cyber-neon') {
        s.captions.accent = '#00f3ff';
        s.captions.font = 'Impact';
        s.captions.style = 'pop';
        s.bg = 'blur';
      } else if (pName === 'gold-hormozi') {
        s.captions.accent = '#ffd23f';
        s.captions.font = 'Impact';
        s.captions.style = 'highlight';
        s.bg = 'smart';
      } else if (pName === 'clean-minimal') {
        s.captions.accent = '#ffffff';
        s.captions.font = 'Arial';
        s.captions.style = 'plain';
        s.bg = 'fit';
        s.fitColor = '#000000';
      }
      scheduleSave();
      syncLiveOverlays();
      openFlyout('style');
      toast('Style preset applied!');
    };
  });

  // Color Swatches
  flyout.querySelectorAll('[data-swatch]').forEach((sw) => {
    sw.onclick = () => {
      state.draft.settings.captions.accent = sw.dataset.swatch;
      scheduleSave();
      syncLiveOverlays();
      openFlyout('colors');
    };
  });

  // Generic data-k bindings
  flyout.querySelectorAll('[data-k]').forEach((el) => {
    const h = () => {
      const k = el.dataset.k;
      let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      if (k === 'hashtags') v = el.value.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
      setPath(state.draft, k, v);
      if (k === 'settings.title.text') state.draft.hook = v;
      scheduleSave();
      syncLiveOverlays();
    };
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input', h);
  });

  // Speed selector
  flyout.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.onclick = () => {
      const sp = Number(btn.dataset.speed);
      const v = $('#pv');
      if (v) v.playbackRate = sp;
      flyout.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', b === btn));
    };
  });

  // Transcript controls in Subtitle flyout
  flyout.querySelector('#f-text')?.addEventListener('input', (e) => {
    state.draft.settings.captions.textOverride = e.target.value.trim() === (state.origText || '').trim() ? '' : e.target.value;
    scheduleSave();
    syncLiveOverlays();
  });
  flyout.querySelector('#revert-text')?.addEventListener('click', () => {
    const ta = $('#f-text');
    if (!ta) return;
    ta.value = state.origText || '';
    state.draft.settings.captions.textOverride = '';
    scheduleSave();
    syncLiveOverlays();
    toast('Captions reset to original spoken audio words');
  });
  flyout.querySelector('#fix-text')?.addEventListener('click', async () => {
    const btn = $('#fix-text');
    const ta = $('#f-text');
    if (!ta?.value.trim()) return toast('There is no caption text to fix', true);
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Fixing with AI…';
    try {
      const r = await post(`/api/clips/${state.draft.id}/proofread`, { text: ta.value });
      ta.value = r.text;
      state.draft.settings.captions.textOverride = r.text.trim() === (state.origText || '').trim() ? '' : r.text;
      if (/[\u0900-\u097F]/.test(r.text)) {
        state.draft.settings.captions.font = 'Nirmala UI';
      }
      if (r.projectUsage) state.project.usage = r.projectUsage;
      scheduleSave();
      syncLiveOverlays();
      toast('Captions fixed with AI! Render again to burn them in.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // AI Copy Writer
  flyout.querySelector('#desc-go')?.addEventListener('click', async () => {
    const btn = $('#desc-go');
    btn.disabled = true;
    try {
      const c = await post(`/api/clips/${state.draft.id}/describe`);
      state.draft.description = c.description;
      state.draft.hashtags = c.hashtags;
      openFlyout('title');
      toast('Post copy generated!');
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  flyout.querySelector('#desc-copy')?.addEventListener('click', async () => {
    const d = state.draft;
    await navigator.clipboard.writeText(`${d.description}\n\n${(d.hashtags || []).map((h) => '#' + h).join(' ')}`.trim());
    toast('Copied to clipboard!');
  });

  // Cut segments
  const readSegs = () => {
    state.draft.segments = [...flyout.querySelectorAll('[data-seg]')].map((r) => ({ start: parseTime($('[data-seg-s]', r).value), end: parseTime($('[data-seg-e]', r).value) }));
  };
  flyout.addEventListener('change', (e) => {
    if (e.target.matches('[data-seg-s],[data-seg-e]')) { readSegs(); scheduleSave(); if (state.previewMode === 'original') setPreview(); }
  });
  flyout.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-seg-rm]');
    if (rm) { readSegs(); state.draft.segments.splice(Number(rm.dataset.segRm), 1); flyout.querySelector('#segs').innerHTML = state.draft.segments.map(segRow).join(''); scheduleSave(); }
  });
  flyout.querySelector('#add-seg')?.addEventListener('click', () => {
    readSegs();
    const last = state.draft.segments.at(-1);
    state.draft.segments.push({ start: Math.min(last.end + 5, state.project.duration - 6), end: Math.min(last.end + 11, state.project.duration) });
    flyout.querySelector('#segs').innerHTML = state.draft.segments.map(segRow).join('');
    scheduleSave();
  });

  // Voiceover / React
  flyout.querySelector('#bubble-pos')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bubble]');
    if (!b) return;
    const [x, y] = b.dataset.bubble.split(',').map(Number);
    state.draft.settings.bubble ??= { x: 0.88, y: 0.12, size: 0.28 };
    state.draft.settings.bubble.x = x;
    state.draft.settings.bubble.y = y;
    flyout.querySelectorAll('[data-bubble]').forEach((n) => n.classList.toggle('on', n === b));
    scheduleSave();
  });
  flyout.querySelector('#rec-voice')?.addEventListener('click', () => toggleRecording('voice'));
  flyout.querySelector('#rec-face')?.addEventListener('click', () => toggleRecording('face'));
  wireVoiceRemove();
}

function segRow(g, i) {
  return `<div class="segrow" data-seg="${i}"><label style="margin:0">Start <input data-seg-s value="${fmt(g.start)}" style="margin-top:2px;padding:6px 8px"></label><label style="margin:0">End <input data-seg-e value="${fmt(g.end)}" style="margin-top:2px;padding:6px 8px"></label>${state.draft.segments.length > 1 ? `<button type="button" class="studio-btn ghost danger" data-seg-rm="${i}" style="padding:4px 8px;font-size:11px">✕</button>` : '<span></span>'}</div>`;
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
  return BUBBLES.map(([k, label, x, y]) => `<button type="button" class="studio-pill ${k === on ? 'on' : ''}" data-bubble="${x},${y}" style="font-size:11px">${label}</button>`).join('');
}
function voiceStatus() {
  const v = state.draft.voice;
  return v ? `<p class="note" style="margin:0"><strong>${v.tts ? 'AI voice' : v.kind === 'face' ? 'Camera take' : 'Voice take'} attached.</strong> <button type="button" class="studio-btn ghost danger" id="voice-rm" style="padding:2px 8px;font-size:11px">Remove</button></p>` : '<p class="note" style="margin:0">No voice-over attached.</p>';
}

function setPreview() {
  const d = state.draft;
  const p = state.project;
  const v = $('#pv');
  if (!v) return;

  document.querySelectorAll('[data-pm]').forEach((b) => b.classList.toggle('on', b.dataset.pm === state.previewMode));
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
    const segs = list();
    const g = segs[idx];
    if (!g) return;

    // Timeline bar & counter sync
    const curTime = $('#sp-cur-time');
    const durTime = $('#sp-dur-time');
    const seek = $('#sp-seek');
    const dur = d.segments.reduce((a, seg) => a + seg.end - seg.start, 0);

    if (curTime) curTime.textContent = fmt(Math.max(0, v.currentTime - g.start));
    if (durTime) durTime.textContent = fmt(dur);
    if (seek && dur > 0) seek.value = Math.min(100, Math.max(0, ((v.currentTime - g.start) / dur) * 100));

    // Opener title duration visibility
    const topTitle = $('#pv-top-title');
    if (topTitle && d.settings.title.enabled !== false) {
      const showSec = d.settings.title.seconds || 3;
      topTitle.style.display = (v.currentTime - g.start <= showSec) ? 'block' : 'none';
    }

    if (state.previewMode !== 'original') return;
    if (v.currentTime >= g.end - 0.08) {
      if (idx >= segs.length - 1) {
        v.pause();
        const playBtn = $('#sp-play');
        if (playBtn) playBtn.textContent = '▶';
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
  if (rb) {
    rb.disabled = busy;
    rb.textContent = busy ? '⏳ Rendering…' : c.outputFile ? '🎬 Render again' : '🎬 Render clip';
  }

  const stopBtn = $('#ed-stop-render');
  if (stopBtn) stopBtn.hidden = !busy;

  const overlay = $('#pv-render-overlay');
  const overlayLabel = $('#pv-render-label');
  const overlayBar = $('#pv-render-bar-fill');
  if (overlay) {
    overlay.hidden = !busy;
    if (busy) {
      const pText = c.status === 'queued' ? 'Queued in rendering queue…' : `Almost ready to share... ${c.progress || 0}%`;
      if (overlayLabel) overlayLabel.textContent = pText;
      if (overlayBar) overlayBar.style.width = `${c.progress || 0}%`;
    }
  }

  const rtext = $('#rtext');
  if (rtext) {
    rtext.textContent = busy ? (c.status === 'queued' ? 'Queued' : `${c.progress}%`) : c.status === 'error' ? 'Render failed.' : '';
  }

  const dl = $('#dl');
  if (dl && c.outputFile) {
    dl.hidden = false;
    dl.href = `/media/${state.project.id}/${c.outputFile}?v=${c.renderedAt}`;
  }

  if (c.status === 'done' && (c.renderedAt !== state.draft.renderedAt)) {
    state.draft.outputFile = c.outputFile;
    state.draft.renderedAt = c.renderedAt;
    state.previewMode = 'rendered';
    setPreview();
    $('[data-pm=rendered]').disabled = false;
  }
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

  // Tool buttons toggle
  ed.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.onclick = () => {
      const tool = btn.dataset.tool;
      openFlyout(activeStudioTool === tool ? null : tool);
    };
  });

  // Safe zones toggle
  $('#tool-safe-zones')?.addEventListener('click', () => {
    const sz = $('#pv-safe-zones');
    if (sz) {
      sz.hidden = !sz.hidden;
      $('#tool-safe-zones').classList.toggle('active', !sz.hidden);
    }
  });

  // Aspect selector in topbar
  $('#ed-aspect-sel')?.addEventListener('change', (e) => {
    state.draft.aspect = e.target.value;
    scheduleSave();
    syncLiveOverlays();
  });

  // Category pill tabs
  ed.querySelectorAll('.studio-tabs .studio-pill').forEach((pill) => {
    pill.onclick = () => {
      ed.querySelectorAll('.studio-tabs .studio-pill').forEach((p) => p.classList.remove('on'));
      pill.classList.add('on');
    };
  });

  // Player controls
  const playBtn = $('#sp-play');
  const v = $('#pv');
  if (playBtn && v) {
    playBtn.onclick = () => {
      if (v.paused) {
        v.play();
        playBtn.textContent = '⏸';
      } else {
        v.pause();
        playBtn.textContent = '▶';
      }
    };
  }

  const seek = $('#sp-seek');
  if (seek && v) {
    seek.oninput = () => {
      const g = state.draft.segments[0];
      if (!g) return;
      const dur = state.draft.segments.reduce((a, seg) => a + seg.end - seg.start, 0);
      v.currentTime = g.start + (Number(seek.value) / 100) * dur;
    };
  }

  const volBtn = $('#sp-vol');
  if (volBtn && v) {
    volBtn.onclick = () => {
      v.muted = !v.muted;
      volBtn.textContent = v.muted ? '🔇' : '🔊';
    };
  }

  // Preview Mode
  document.querySelectorAll('[data-pm]').forEach((b) => (b.onclick = () => {
    state.previewMode = b.dataset.pm;
    setPreview();
  }));

  // Apply to all clips
  $('#apply-all-btn')?.addEventListener('click', async () => {
    const btn = $('#apply-all-btn');
    btn.disabled = true;
    try {
      await saveDraft();
      const res = await post(`/api/projects/${state.project.id}/apply-settings`, {
        settings: state.draft.settings,
        aspect: state.draft.aspect,
      });
      toast(`Look applied to all ${res.updatedCount || ''} clips in this project!`);
      if (state.pid) await selectProject(state.pid);
    } catch (err) {
      toast('Failed to apply settings: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Reset Look
  $('#reset-look-btn')?.addEventListener('click', () => {
    if (!confirm('Reset current look to defaults?')) return;
    state.draft.settings.captions.accent = '#00e5a3';
    state.draft.settings.captions.font = 'Nirmala UI';
    state.draft.settings.captions.style = 'highlight';
    state.draft.settings.bg = 'fit';
    state.draft.settings.fitColor = '#000000';
    state.draft.settings.filter = 'none';
    scheduleSave();
    syncLiveOverlays();
    openFlyout(activeStudioTool);
    toast('Look reset to defaults');
  });

  // Post to YouTube Short
  $('#ed-yt-btn')?.addEventListener('click', () => {
    saveDraft();
    openYouTubeUploadModal(state.draft.id);
  });

  // Render button
  $('#render').onclick = async () => {
    await saveDraft();
    try {
      const c = await post(`/api/clips/${state.draft.id}/render`);
      const i = state.project.clips.findIndex((x) => x.id === c.id);
      state.project.clips[i] = c;
      syncEditorStatus();
      await fetchTasks();
    } catch (err) { toast(err.message, true); }
  };

  const edStop = $('#ed-stop-render');
  if (edStop) {
    edStop.onclick = async () => {
      edStop.disabled = true;
      edStop.textContent = 'Stopping…';
      try {
        await post(`/api/clips/${state.draft.id}/cancel`, {});
        toast('Render cancelled');
        await fetchTasks();
        if (state.pid) await selectProject(state.pid);
        syncEditorStatus();
      } catch (err) {
        toast(err.message, true);
      } finally {
        edStop.disabled = false;
        edStop.textContent = 'Stop Render';
      }
    };
  }
}

function wireVoiceRemove() {
  const b = $('#voice-rm');
  if (!b) return;
  b.onclick = async () => {
    await api(`/api/clips/${state.draft.id}/voice`, { method: 'DELETE' });
    state.draft.voice = null;
    $('#voice-status').innerHTML = voiceStatus();
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

// ---------- YouTube cookies UI ----------
let ytCookiesState = null;

async function fetchYouTubeCookiesInfo() {
  try {
    ytCookiesState = await api('/api/youtube/cookies');
    renderYouTubeCookiesBadge();
  } catch {}
}

function renderYouTubeCookiesBadge() {
  const badge = $('#yt-cookies-badge');
  if (!badge) return;
  if (ytCookiesState?.active) {
    badge.className = 'chip yt-cookie-chip on';
    const kb = Math.max(1, Math.round((ytCookiesState.size || 0) / 1024));
    badge.textContent = `🍪 Cookies: Active (${kb} KB)`;
    badge.title = 'Cookies loaded. yt-dlp will authenticate using these cookies to bypass bot checks.';
  } else {
    badge.className = 'chip yt-cookie-chip off';
    badge.textContent = '🍪 Cookies: None';
    badge.title = 'No cookies loaded. Some YouTube videos might trigger bot checks.';
  }
}

async function openYouTubeCookiesModal() {
  const pop = $('#yt-cookies-modal');
  if (!pop) return;
  try {
    ytCookiesState = await api('/api/youtube/cookies');
    renderYouTubeCookiesBadge();
    const stEl = $('#yt-cookies-current-status');
    const delBtn = $('#yt-cookie-delete-btn');
    const testBtn = $('#yt-cookie-test-btn');
    if (stEl) {
      if (ytCookiesState?.active) {
        const timeStr = ytCookiesState.mtime ? new Date(ytCookiesState.mtime).toLocaleString() : '';
        stEl.innerHTML = `<span style="color:var(--ok);font-weight:600">✓ Cookies are loaded and active (${esc(ytCookiesState.path || 'cookies.txt')}, ${Math.max(1, Math.round((ytCookiesState.size || 0) / 1024))} KB).</span><div style="font-size:11px;color:var(--soft);margin-top:4px">Last updated: ${esc(timeStr)}</div>`;
        if (delBtn) delBtn.hidden = false;
        if (testBtn) testBtn.hidden = false;
      } else {
        stEl.innerHTML = `<span style="color:#b45309;font-weight:600">⚠️ No cookies configured yet.</span><div style="font-size:11px;color:var(--soft);margin-top:4px">Without cookies, YouTube might block requests with <em>"Sign in to confirm you're not a bot"</em> or age restrictions.</div>`;
        if (delBtn) delBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
      }
    }
    const fileInp = $('#yt-cookie-file-input');
    if (fileInp) fileInp.value = '';
    const textInp = $('#yt-cookie-text');
    if (textInp) textInp.value = '';
    if (!pop.open) pop.showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

function wireYouTubeCookies() {
  $('#yt-cookies-open-btn')?.addEventListener('click', openYouTubeCookiesModal);
  $('#yt-cookies-badge')?.addEventListener('click', openYouTubeCookiesModal);

  $('#yt-cookie-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      $('#yt-cookie-text').value = text;
    } catch (err) {
      toast('Failed to read file: ' + err.message, true);
    }
  });

  $('#yt-cookie-save-btn')?.addEventListener('click', async () => {
    let content = $('#yt-cookie-text')?.value?.trim();
    const file = $('#yt-cookie-file-input')?.files?.[0];
    if (!content && file) {
      try {
        content = await file.text();
      } catch (err) {
        return toast('Failed to read file: ' + err.message, true);
      }
    }
    if (!content) {
      return toast('Please select a cookies.txt file or paste cookie data', true);
    }
    try {
      const res = await post('/api/youtube/cookies', { cookies: content });
      ytCookiesState = res;
      renderYouTubeCookiesBadge();
      toast('Cookies saved! YouTube downloads are now authenticated.');
      $('#yt-cookies-modal')?.close();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#yt-cookie-delete-btn')?.addEventListener('click', async () => {
    if (!confirm('Delete current YouTube cookies?')) return;
    try {
      const res = await api('/api/youtube/cookies', { method: 'DELETE' });
      ytCookiesState = res;
      renderYouTubeCookiesBadge();
      toast('Cookies deleted');
      $('#yt-cookies-modal')?.close();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#yt-cookie-test-btn')?.addEventListener('click', async () => {
    const testBtn = $('#yt-cookie-test-btn');
    const stEl = $('#yt-cookies-current-status');
    testBtn.disabled = true;
    testBtn.textContent = 'Verifying…';
    try {
      const res = await post('/api/youtube/cookies/test', {});
      if (stEl) {
        stEl.innerHTML = `<span style="color:var(--ok);font-weight:600">✓ ${esc(res.message || 'Verified successfully with YouTube!')}</span>`;
      }
      toast('Cookies verified with YouTube successfully!');
    } catch (err) {
      if (stEl) {
        stEl.innerHTML = `<span style="color:var(--danger);font-weight:600">⚠️ Verification issue:</span> <span style="font-size:12px">${esc(err.message)}</span>`;
      }
      toast('Cookie verification failed: ' + err.message, true);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '🔍 Test / Verify Cookies';
    }
  });
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
  if (e.key !== 'Escape' || $('#editor').hidden || $('#react-pop')?.open || $('#yt-modal')?.open || $('#yt-upload-modal')?.open || $('#yt-cookies-modal')?.open) return;
  $('#ed-close').click();
});
init().catch((e) => toast(e.message, true));

