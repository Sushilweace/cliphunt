// Tiny in-process job queue. For production swap for BullMQ/Redis (same interface: queue(fn, id)).
function makeQueue(concurrency) {
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < concurrency && waiting.length) {
      const item = waiting.shift();
      if (item.cancelled) continue;
      running++;
      Promise.resolve()
        .then(item.fn)
        .catch((e) => console.error('[queue]', e))
        .finally(() => {
          running--;
          next();
        });
    }
  };
  const enqueue = (fn, id = null) => {
    const item = { id, fn, cancelled: false };
    waiting.push(item);
    next();
    return () => {
      item.cancelled = true;
      const idx = waiting.indexOf(item);
      if (idx !== -1) waiting.splice(idx, 1);
    };
  };
  enqueue.cancel = (id) => {
    if (!id) return;
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (waiting[i].id === id) {
        waiting[i].cancelled = true;
        waiting.splice(i, 1);
      }
    }
  };
  enqueue.clear = () => {
    for (const item of waiting) item.cancelled = true;
    waiting.length = 0;
  };
  enqueue.isWaiting = (id) => waiting.some((w) => w.id === id && !w.cancelled);
  return enqueue;
}
export const analysisQueue = makeQueue(Number(process.env.ANALYSIS_CONCURRENCY || 1));
export const renderQueue = makeQueue(Number(process.env.RENDER_CONCURRENCY || 2));
