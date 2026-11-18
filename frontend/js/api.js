// Minimal same-origin API client for the Contract Guard backend.
// Every call resolves to the `data` field of the success envelope or
// rejects with a structured ApiError (status, code, message, details).

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: `Could not reach the API (${networkError.message}). Is the backend running?`,
    });
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // No JSON body (e.g. empty 204) — that is fine for our endpoints.
  }

  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: json?.error?.code ?? `HTTP_${res.status}`,
      message: json?.error?.message ?? `Request failed with status ${res.status}`,
      details: json?.error?.details ?? null,
    });
  }
  return json?.data;
}

export const get = (path, query) => api(path, { query });
export const post = (path, body) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
