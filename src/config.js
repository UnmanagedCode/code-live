// Environment → runtime config. The host spawns the backend with PORT,
// PROJECTS_ROOT and CONDUCTOR_URL; the last two have no sane default.
import path from 'node:path';

const LIVE_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export function loadConfig(env = process.env) {
  if (!env.PROJECTS_ROOT) throw new Error('code-live: PROJECTS_ROOT is not set (the host provides it)');
  if (!env.CONDUCTOR_URL) throw new Error('code-live: CONDUCTOR_URL is not set (the host provides it)');
  const conductorUrl = env.CONDUCTOR_URL.replace(/\/+$/, '');
  // CODE_LIVE_GEMINI_BASE points the backend at a fake Gemini server in tests.
  const geminiBase = (env.CODE_LIVE_GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return {
    port: Number(env.PORT) || 7300,
    host: env.HOST || '127.0.0.1',
    dataDir: path.join(env.PROJECTS_ROOT, '.code-live'),
    conductorUrl,
    geminiBase,
    geminiWsUrl: geminiBase.replace(/^http/, 'ws') + LIVE_WS_PATH,
    hostWsUrl: conductorUrl.replace(/^http/, 'ws') + '/ws',
  };
}
