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

/** Read CSRF token from cookie (set by backend on GET requests) */
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Fetch CSRF token from server if not in cookie */
async function ensureCsrfToken(): Promise<string | null> {
  let token = getCsrfToken();
  if (token) return token;

  try {
    const res = await fetch(`${API}/auth/csrf-token`, { method: 'GET', credentials: 'include' });
    const data = await res.json();
    if (data.csrfToken) return data.csrfToken;
  } catch { /* ignore */ }

  return getCsrfToken();
}

// ── Refresh Token Mutex ───────────────────────────────────────────────────────
// يمنع مشكلة REUSE DETECTED: لو عدة طلبات وصلوا بـ 401 في نفس الوقت،
// كلهم ينتظرون نفس عملية الـ refresh بدل إرسال طلبات متعددة بنفس الـ token.
let _refreshPromise: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  // لو في refresh جاري بالفعل، انتظره بدل إطلاق طلب جديد
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = _doRefresh().finally(() => {
    _refreshPromise = null;
  });

  return _refreshPromise;
}

async function _doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.success && data.accessToken) {
      saveTokens(data.accessToken, data.refreshToken || refreshToken);
      return data.accessToken;
    }
  } catch {
    // network error
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authenticated fetch — attaches JWT Bearer token + CSRF token automatically.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const method = (options.method || 'GET').toUpperCase();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  // منع الـ HTTP caching لضمان بيانات حديثة دائماً (يحل مشكلة 304 في Railway)
  if (method === 'GET' || method === 'HEAD') {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    headers['Pragma'] = 'no-cache';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  // أضف CSRF token للطلبات التي تُعدِّل البيانات
  if (!SAFE_METHODS.has(method)) {
    const csrfToken = await ensureCsrfToken();
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }
  }

  let response = await fetch(url, { ...options, headers, credentials: 'include' });

  // ── Auto-refresh on 401 ────────────────────────────────────────────────────
  if (response.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, { ...options, headers, credentials: 'include' });
    }
    if (response.status === 401) {
      clearTokens();
      window.location.href = '/';
    }
  }

  return response;
}
