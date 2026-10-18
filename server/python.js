import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let cached = null;

/** Pick a Python that has faster-whisper. `python` on PATH may be a different install. */
export function pythonCmd() {
  if (cached) return cached;
  const tries = [];
  if (process.env.PYTHON) tries.push([process.env.PYTHON, []]);
  else if (process.platform === 'win32') tries.push(['py', ['-3']], ['python', []], ['python3', []]);
  else tries.push(['python3', []], ['python', []]);
  for (const [cmd, prefix] of tries) {
    const r = spawnSync(cmd, [...prefix, '-c', 'import faster_whisper,sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const exe = String(r.stdout || '').trim().split(/\r?\n/).pop();
    if (r.status === 0 && exe && fs.existsSync(exe)) {
      cached = exe;
      return cached;
    }
  }
  cached = process.platform === 'win32' ? 'python' : 'python3';
  return cached;
}
