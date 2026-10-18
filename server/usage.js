export const blankUsage = () => ({ input: 0, output: 0, total: 0, calls: 0 });

export function tokenLimits() {
  return {
    project: Math.max(0, Number(process.env.MAX_PROJECT_TOKENS || 80000)),
    clip: Math.max(0, Number(process.env.MAX_CLIP_TOKENS || 8000)),
  };
}

export function addUsage(bucket, usage) {
  const b = bucket || blankUsage();
  b.input += usage?.input || 0;
  b.output += usage?.output || 0;
  b.total = b.input + b.output;
  b.calls += 1;
  return b;
}

export function estimateTokens(system, user, output) {
  const input = Math.ceil(`${system || ''}${user || ''}`.length / 4);
  const out = Math.ceil(`${output || ''}`.length / 4);
  return { input, output: out, total: input + out };
}
