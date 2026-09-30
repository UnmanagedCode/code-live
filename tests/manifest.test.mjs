// Pins: conductor.plugin.json only uses keys code-conductor's manifest
// validator accepts (unknown keys invalidate the plugin), and its version
// matches package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Mirrors code-conductor's validateManifest key sets.
const TOP = ['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'conventions', 'roles', 'playbooks', 'claudePlugin'];
const BACKEND = ['start', 'healthPath', 'readyWhen'];
const FRONTEND = ['path', 'navLabel'];

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
  assert.deepEqual(manifest.frontend, { path: '/', navLabel: 'Code Live' });
  assert.equal('mcp' in manifest, false);
});

test('manifest version equals package.json version', () => {
  assert.equal(manifest.version, pkg.version);
});
