// The HTTP API. Each handler gets {req, res, body, deps} and returns
// {status?, body} to send as JSON, or undefined when it wrote the response
// itself (SSE). Thrown errors with a `code` become {error, code} responses.
import { MODELS } from './models.js';
import { callTool } from './tools.js';
import { HttpError } from './http.js';

export const ROUTES = [
  { method: 'GET', path: '/api/health', handler: () => ({ body: { ok: true } }) },

  { method: 'GET', path: '/api/settings', handler: async ({ deps }) => ({ body: { apiKey: await deps.keyStore.status() } }) },

  {
    method: 'PUT', path: '/api/settings/api-key', json: true,
    handler: async ({ body, deps }) => {
      await deps.keyStore.set(body.apiKey);
      return { body: { apiKey: await deps.keyStore.status() } };
    },
  },

  {
    method: 'DELETE', path: '/api/settings/api-key',
    handler: async ({ deps }) => {
      await deps.keyStore.clear();
      return { body: { apiKey: await deps.keyStore.status() } };
    },
  },

  { method: 'GET', path: '/api/models', handler: () => ({ body: { models: MODELS.map(({ id, label }) => ({ id, label })) } }) },

  {
    method: 'POST', path: '/api/token', json: true,
    handler: async ({ body, deps }) => ({ body: await deps.gemini.mintToken({ modelId: body.model, resumeHandle: body.resumeHandle }) }),
  },

  {
    // Tool failures are data for Gemini, so they come back as 200 {ok:false}.
    method: 'POST', path: '/api/tools/call', json: true,
    handler: async ({ body, deps }) => {
      if (typeof body.name !== 'string') throw new HttpError(400, 'INVALID_ARGS', 'name must be a string');
      return { body: await callTool(body.name, body.args, deps.service) };
    },
  },

  { method: 'GET', path: '/api/conductors', handler: async ({ deps }) => ({ body: await deps.service.list() }) },

  {
    method: 'PUT', path: '/api/target', json: true,
    handler: async ({ body, deps }) => {
      if (body.sessionId === null) {
        await deps.service.clearTarget();
        return { body: { activeTarget: null } };
      }
      if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new HttpError(400, 'INVALID_ARGS', 'sessionId must be a string or null');
      return { body: { activeTarget: await deps.service.setTarget(body.sessionId) } };
    },
  },

  {
    method: 'GET', path: '/api/events',
    handler: async ({ req, res, deps }) => {
      deps.sse.handle(req, res, [
        ['target', await deps.service.getTarget()],
        ['host', { connected: deps.link.isOpen() }],
      ]);
    },
  },
];
