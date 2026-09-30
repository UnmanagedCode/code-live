// happy-dom globals for importing the real public/ modules in Node.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function loadDom(...modules) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  const mods = {};
  for (const m of modules) Object.assign(mods, await import(pathToFileURL(path.join(PUB, m)).href));
  return { window, document: window.document, ...mods };
}
