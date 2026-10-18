import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA = path.resolve(process.env.DATA_DIR || './data');
export const dirs = {
  projects: path.join(DATA, 'projects'),
  uploads: path.join(DATA, 'uploads'),
  music: path.join(DATA, 'music'),
  brand: path.join(DATA, 'brand'),
};
Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));

const file = path.join(DATA, 'db.json');
export const db = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { projects: {}, clips: {}, uploads: {} };

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 150);
}
export function saveNow() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}
export const uid = () => crypto.randomBytes(5).toString('hex');
export const projectDir = (id) => path.join(dirs.projects, id);

// Jobs die with the process. Queue them again; finished stages are skipped from files on disk.
export const resumeProjectIds = [];
export const resumeRenderIds = [];
for (const p of Object.values(db.projects)) {
  if (p.status === 'processing' || p.status === 'queued') {
    p.status = 'queued';
    p.stage = 'Resuming';
    p.error = null;
    resumeProjectIds.push(p.id);
  }
}
for (const c of Object.values(db.clips)) {
  if (c.status === 'rendering' || c.status === 'queued') {
    c.status = 'queued';
    c.progress = 0;
    c.error = null;
    resumeRenderIds.push(c.id);
  }
}
if (resumeProjectIds.length || resumeRenderIds.length) saveNow();
