// Backend API client. URLs are relative so the page works under the host's
// /plugins/code-live/ proxy prefix.
// The connect button is disabled while a token is requested, so that request must end
// by itself. The default sits just above the backend's own 15 s bound on the Gemini
// call, so a slow backend's error surfaces before this timeout does.
export const TOKEN_TIMEOUT_MS = 20000;

export function createApi(fetchImpl = (...a) => fetch(...a), { tokenTimeoutMs = TOKEN_TIMEOUT_MS } = {}) {
  // `timeoutMs` bounds the whole exchange, response body included; other calls are unbounded.
  async function call(method, url, body, timeoutMs) {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const res = await fetchImpl(url, {
        method,
        cache: 'no-store',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const data = await res.json().catch((e) => { if (signal?.aborted) throw e; return null; });
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new Error(`No response from the backend within ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    }
  }
  return {
    getSettings: () => call('GET', 'api/settings'),
    setApiKey: (apiKey) => call('PUT', 'api/settings/api-key', { apiKey }),
    clearApiKey: () => call('DELETE', 'api/settings/api-key'),
    getModels: () => call('GET', 'api/models'),
    mintToken: (model, resumeHandle) => call('POST', 'api/token', { model, ...(resumeHandle ? { resumeHandle } : {}) }, tokenTimeoutMs),
    callTool: (name, args) => call('POST', 'api/tools/call', { name, args: args ?? {} }),
  };
}
