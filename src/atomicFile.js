// Owner-only atomic JSON writes shared by the key and state stores: write a
// sibling temp file at 0600, then rename it over the target.
import { promises as fs } from 'node:fs';
import path from 'node:path';

let tmpCounter = 0;

export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file, '.json')}.${process.pid}.${++tmpCounter}.tmp`);
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

// Returns the parsed JSON, or null when the file does not exist. Unparseable
// content throws STORE_CORRUPT rather than being treated as empty.
export async function readJson(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error(`${path.basename(file)} is not valid JSON`), { code: 'STORE_CORRUPT' }); }
}
