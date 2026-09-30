// Backend API client. URLs are relative so the page works under the host's
// /plugins/code-live/ proxy prefix.
export function createApi(fetchImpl = (...a) => fetch(...a)) {
  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }
  return {
    getSettings: () => call('GET', 'api/settings'),
    setApiKey: (apiKey) => call('PUT', 'api/settings/api-key', { apiKey }),
    clearApiKey: () => call('DELETE', 'api/settings/api-key'),
    getModels: () => call('GET', 'api/models'),
    mintToken: (model, resumeHandle) => call('POST', 'api/token', { model, ...(resumeHandle ? { resumeHandle } : {}) }),
    callTool: (name, args) => call('POST', 'api/tools/call', { name, args: args ?? {} }),
    getConductors: () => call('GET', 'api/conductors'),
    setTarget: (sessionId) => call('PUT', 'api/target', { sessionId }),
  };
}
