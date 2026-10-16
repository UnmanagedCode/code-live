// Pins: conductor.plugin.json only uses keys code-conductor's manifest
// validator accepts (unknown keys invalidate the plugin), and its version
// matches package.json; package.json builds the UI on install and declares no
// runtime dependency; .gitignore keeps an installed checkout clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Mirrors code-conductor's validateManifest key sets.
const TOP = ['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'conventions', 'roles', 'playbooks', 'claudePlugin'];
const BACKEND = ['start', 'healthPath', 'readyWhen'];
const FRONTEND = ['path', 'navLabel', 'keepAlive'];

test('manifest keys are all accepted by the host', () => {
  for (const k of Object.keys(manifest)) assert.ok(TOP.includes(k), `top-level key ${k}`);
  for (const k of Object.keys(manifest.backend)) assert.ok(BACKEND.includes(k), `backend key ${k}`);
  for (const k of Object.keys(manifest.frontend)) assert.ok(FRONTEND.includes(k), `frontend key ${k}`);
});

test('manifest declares the backend, frontend and no MCP surface', () => {
  assert.equal(manifest.id, 'code-live');
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.backend.start, 'node server.js');
  assert.equal(manifest.backend.healthPath, '/api/health');
  assert.deepEqual(manifest.frontend, { path: '/', navLabel: 'Code Live', keepAlive: true });
  assert.equal(typeof manifest.frontend.keepAlive, 'boolean');
  assert.equal('mcp' in manifest, false);
});

test('manifest version equals package.json version', () => {
  assert.equal(manifest.version, pkg.version);
});

// The backend runs on node: built-ins only, so no runtime dependency; the UI is
// devDependencies, built into frontend/dist by `npm install` (`prepare`), which
// cc's Library entry runs on Install and Update.
const UI_DEV_DEPS = ['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'tailwindcss', 'tw-animate-css', 'typescript',
  'react', 'react-dom', '@types/react', '@types/react-dom', 'radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge',
  'lucide-react', 'vitest', 'happy-dom', '@testing-library/react', '@testing-library/user-event', 'ws'];

test('package.json: no runtime dependencies; the UI is devDependencies built on install', () => {
  assert.equal(pkg.dependencies, undefined);
  for (const d of UI_DEV_DEPS) assert.ok(pkg.devDependencies?.[d], `devDependency ${d}`);
  assert.equal(pkg.scripts.prepare, 'vite build --config frontend/vite.config.ts');
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.test, 'node tests/run.mjs && npm run typecheck && npm run test:web');
  assert.equal(pkg.scripts.typecheck, 'tsc -p frontend');
  assert.equal(pkg.scripts['test:web'], 'vitest run --config frontend/vitest.config.ts');
  assert.equal(pkg.engines.node, '>=22.12');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
});

// Install must leave the checkout clean, or cc's Update (git pull --ff-only) refuses.
test('.gitignore covers what npm install writes', () => {
  const lines = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  // No trailing slash on node_modules: a worktree's node_modules is a symlink, which `node_modules/` does not match.
  for (const l of ['node_modules', 'frontend/dist/', 'package-lock.json', '.code-live/']) assert.ok(lines.includes(l), l);
});
