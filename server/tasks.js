import { db, save } from './store.js';
import { analysisQueue, renderQueue } from './queue.js';

// Active in-memory controllers: id -> { controller, startedAt, type, targetId }
const activeControllers = new Map();

export function registerTask(id, controller, meta = {}) {
  activeControllers.set(id, {
    controller,
    startedAt: meta.startedAt || Date.now(),
    type: meta.type,
    targetId: meta.targetId,
  });
}

export function unregisterTask(id) {
  activeControllers.delete(id);
}

export function getTaskController(id) {
  return activeControllers.get(id)?.controller;
}

export function listTasks() {
  const tasks = [];

  // 1. Project Analysis
  for (const p of Object.values(db.projects || {})) {
    if (p.status === 'processing' || p.status === 'queued') {
      const rec = activeControllers.get(`analysis-${p.id}`);
      tasks.push({
        id: `analysis-${p.id}`,
        type: 'analysis',
        targetId: p.id,
        title: p.title || p.source?.name || 'Untitled Project',
        stage: p.stage || (p.status === 'queued' ? 'Queued for analysis' : 'Analyzing video'),
        progress: p.progress || 0,
        status: p.status === 'queued' ? 'queued' : 'running',
        startedAt: rec?.startedAt || p.createdAt || Date.now(),
      });
    }
  }

  // 2. Clip Rendering
  for (const c of Object.values(db.clips || {})) {
    if (c.status === 'rendering' || c.status === 'queued') {
      const rec = activeControllers.get(`render-${c.id}`);
      const project = db.projects?.[c.projectId];
      tasks.push({
        id: `render-${c.id}`,
        type: 'render',
        targetId: c.id,
        projectId: c.projectId,
        projectTitle: project?.title || 'Project',
        title: c.title || 'Clip',
        stage: c.status === 'queued' ? 'Queued for rendering' : `Rendering video (${c.progress || 0}%)`,
        progress: c.progress || 0,
        status: c.status === 'queued' ? 'queued' : 'running',
        startedAt: rec?.startedAt || Date.now(),
      });
    }
  }

  return tasks.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
}

export function cancelTask(taskId) {
  if (!taskId) return false;

  if (taskId.startsWith('analysis-')) {
    const projectId = taskId.replace('analysis-', '');
    analysisQueue.cancel(projectId);
    const rec = activeControllers.get(taskId);
    if (rec?.controller) {
      try { rec.controller.abort(); } catch {}
    }
    unregisterTask(taskId);
    const p = db.projects?.[projectId];
    if (p) {
      p.cancelled = true;
      p.status = 'cancelled';
      p.stage = 'Cancelled by user';
      save();
      return true;
    }
  }

  if (taskId.startsWith('render-')) {
    const clipId = taskId.replace('render-', '');
    renderQueue.cancel(clipId);
    const rec = activeControllers.get(taskId);
    if (rec?.controller) {
      try { rec.controller.abort(); } catch {}
    }
    unregisterTask(taskId);
    const c = db.clips?.[clipId];
    if (c) {
      c.cancelled = true;
      c.status = 'idle';
      c.progress = 0;
      c.error = null;
      save();
      return true;
    }
  }

  return false;
}

export function cancelAllTasks() {
  const current = listTasks();
  let cancelledCount = 0;
  for (const t of current) {
    if (cancelTask(t.id)) cancelledCount++;
  }
  analysisQueue.clear();
  renderQueue.clear();
  return cancelledCount;
}
