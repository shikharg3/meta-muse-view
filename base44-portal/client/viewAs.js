import { base44 } from '@/api/base44Client';

/**
 * "View as client": which portal login this browser tab is previewing, if any.
 *
 * Held in sessionStorage — one tab, gone when it closes — and read at call time by `callPortal`,
 * which routes every portal op through the admin-only `viewPortalAs` staff op while it is set. The
 * server decides what the preview shows and who may see it; this module only remembers the choice.
 *
 * Entering and leaving are full page loads on purpose. Every portal screen caches its reads under
 * keys that do not name the viewer, so a soft navigation would go on showing the client's figures
 * to the admin afterwards (or the admin's to the preview) until each cache expired. A reload is the
 * one reset that cannot miss a key.
 */
const KEY = 'admin.viewAs';

/** `{ email, label, from }` while previewing, else null. */
export function getViewAs() {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) || 'null');
    return v && typeof v.email === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Open the portal as `email`. `label` is what the banner calls them; Exit returns to this page. */
export function startViewAs({ email, label }) {
  const from = window.location.pathname + window.location.search;
  window.sessionStorage.setItem(KEY, JSON.stringify({ email, label: label || email, from }));
  window.location.assign('/');
}

/** Leave the preview, back to `to` or to where it was started from. */
export function endViewAs(to) {
  const from = getViewAs()?.from;
  clearViewAs();
  window.location.assign(to || from || '/admin/users');
}

/** Forget the preview without navigating. */
export function clearViewAs() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing was stored */
  }
}

/**
 * Every AI Intelligence thread is kept under this prefix (`components/portal/ai/aiThread.js`).
 * Spelled out here rather than imported so this module stays free of portal UI imports.
 */
const AI_THREADS = 'portal.ai.';

/**
 * Sign out, ending any preview first so whoever signs in next in this tab starts as themselves —
 * and without the AI Intelligence threads, which sessionStorage would otherwise keep for them.
 */
export function signOut() {
  clearViewAs();
  try {
    const store = window.sessionStorage;
    const keys = Array.from({ length: store.length }, (_, i) => store.key(i));
    for (const k of keys) if (k?.startsWith(AI_THREADS)) store.removeItem(k);
  } catch {
    /* storage unavailable — nothing was stored */
  }
  base44.auth.logout();
}
