/**
 * Whether a request's Host may reach the IP-only pages (`/import`, `/adset-reports`). Fails closed:
 * an empty allow-list (IMPORT_HOSTS unset) turns them off on every host.
 *
 * This scopes the pages to the droplet's bare IP; it is not the security boundary. The Host header
 * is client-controlled, and admin sign-in is still what protects them.
 */
export function isImportHost(host: string | null | undefined, allowed: readonly string[]): boolean {
  if (!host || allowed.length === 0) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return allowed.includes(name);
}
