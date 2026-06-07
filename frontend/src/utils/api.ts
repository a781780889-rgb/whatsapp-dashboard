export const API = '/api/v1';

export const TOKEN_KEY         = 'wa_token';
export const REFRESH_TOKEN_KEY = 'wa_refresh_token';
export const USER_KEY          = 'wa_user';

/** Save both tokens after login / refresh */
export function saveTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

/** Remove all session data */
export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Attempt to refresh the access token using the stored refresh token.
 *  Returns new accessToken on success, null on failure. */
async function tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.success && data.accessToken) {
      // Rotate both tokens (server issues a new refresh token too)
      saveTokens(data.accessToken, data.refreshToken || refreshToken);
      return data.accessToken;
    }
  } catch {
    // network error — can't refresh
  }
  return null;
}

/**
 * Authenticated fetch — automatically attaches JWT Bearer token.
 * On 401, attempts a silent token refresh once before redirecting to login.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let response = await fetch(url, { ...options, headers });

  // ── Auto-refresh on 401 ────────────────────────────────────────────────────
  if (response.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      // Retry the original request with the fresh token
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, { ...options, headers });
    }
    // Still 401 after refresh attempt → full logout
    if (response.status === 401) {
      clearTokens();
      window.location.href = '/';
    }
  }

  return response;
}
