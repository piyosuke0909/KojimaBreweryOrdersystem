const attemptKey = 'kojima-line-login-attempt';
const attemptLifetime = 5 * 60 * 1000;
let memoryAttempt = 0;

/** Resolve LIFF's deep link without changing the URL before SDK initialization. */
export function lineEntryPath(href: string): string {
  const url = new URL(href);
  const state = url.searchParams.get('liff.state');
  if (state) {
    try {
      const target = new URL(state, url.origin);
      if (target.origin === url.origin) return target.pathname;
    } catch { /* Let the SDK handle malformed state; never redirect to another origin. */ }
  }
  return url.pathname;
}

export function requiresLineAuthentication(href: string): boolean {
  const path = lineEntryPath(href);
  return path === '/' || /^\/(invite|order|orders)(\/|$)/.test(path);
}

export function hasLineAuthenticationResult(href: string): boolean {
  const query = new URL(href).searchParams;
  return query.has('error') || query.has('liff.error') || query.has('liffOAuth2Error') || query.has('code');
}

/** Called only after an explicit retry, so SDK denial callbacks do not repeat. */
export function withoutLineAuthenticationErrors(href: string): string {
  const url = new URL(href);
  for (const key of ['error', 'error_description', 'error_uri', 'liff.error', 'liffOAuth2Error']) url.searchParams.delete(key);
  return url.href;
}

export function claimAutomaticLineLogin(): boolean {
  let previous = memoryAttempt;
  try { previous = Math.max(previous, Number(sessionStorage.getItem(attemptKey)) || 0); } catch { /* Private browsing can disable storage. */ }
  const now = Date.now();
  if (previous > now - attemptLifetime && previous <= now) return false;
  memoryAttempt = now;
  try { sessionStorage.setItem(attemptKey, String(now)); } catch { /* The in-memory guard still prevents repeated redirects in this page. */ }
  return true;
}

export function clearAutomaticLineLogin() {
  memoryAttempt = 0;
  try { sessionStorage.removeItem(attemptKey); } catch { /* No authentication data is stored here. */ }
}
