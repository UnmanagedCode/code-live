// REST client for the code-conductor host API.

function hostError(code, message, status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}

export function createCcApi({ baseUrl, fetchImpl = fetch, timeoutMs = 5000 }) {
  async function call(method, pathname, body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + pathname, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw hostError('HOST_UNAVAILABLE', `code-conductor is unreachable (${e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e})`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && typeof data.error === 'string') ? data.error : `HTTP ${res.status}`;
      throw hostError(res.status === 404 ? 'SESSION_GONE' : 'HOST_HTTP_ERROR', `code-conductor ${method} ${pathname.split('?')[0]} failed: ${message}`, res.status);
    }
    return data;
  }

  return {
    async listInstances() {
      const data = await call('GET', '/api/instances');
      if (!Array.isArray(data)) throw hostError('HOST_HTTP_ERROR', 'code-conductor /api/instances did not return an array');
      return data;
    },
    ensureConduct() {
      return call('POST', '/api/projects/.conduct/ensure');
    },
    async createConductor() {
      await this.ensureConduct();
      return call('POST', '/api/instances', { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
    },
    getEvents(id, { limit = 500 } = {}) {
      return call('GET', `/api/instances/${encodeURIComponent(id)}/events?limit=${limit}`);
    },
  };
}
