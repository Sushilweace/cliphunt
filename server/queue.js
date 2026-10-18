// Tiny in-process job queue. For production swap for BullMQ/Redis (same interface: queue(fn)).
function makeQueue(concurrency) {
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < concurrency && waiting.length) {
      const job = waiting.shift();
      running++;
      Promise.resolve()
        .then(job)
        .catch((e) => console.error('[queue]', e))
        .finally(() => {
          running--;
          next();
        });
    }
  };
  return (fn) => {
    waiting.push(fn);
    next();
  };
}
export const analysisQueue = makeQueue(Number(process.env.ANALYSIS_CONCURRENCY || 1));
export const renderQueue = makeQueue(Number(process.env.RENDER_CONCURRENCY || 2));
