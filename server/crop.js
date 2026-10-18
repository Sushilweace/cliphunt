/** Map a face center (0..1 of the full frame) to ffmpeg's crop fraction of the leftover strip. */
export function cropFraction(center, srcW, srcH, outW, outH, axis) {
  if (![srcW, srcH, outW, outH].every((n) => n > 0)) return 0.5;
  const scale = Math.max(outW / srcW, outH / srcH);
  const scaled = (axis === 'y' ? srcH : srcW) * scale;
  const out = axis === 'y' ? outH : outW;
  const leftover = scaled - out;
  if (leftover <= 1) return 0.5;
  const c = Number.isFinite(Number(center)) ? Math.min(1, Math.max(0, Number(center))) : 0.5;
  return Math.min(1, Math.max(0, (c * scaled - out / 2) / leftover));
}
