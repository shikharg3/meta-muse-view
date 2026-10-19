/**
 * Whether a request's Host may reach the CSV import (`/import`). Fails closed: an empty allow-list
 * (IMPORT_HOSTS unset) turns the feature off on every host.
 *
 * This scopes the page to the droplet's bare IP; it is not the security boundary. The Host header
 * is client-controlled, and admin sign-in is still what protects the import.
 */
export function isImportHost(host: string | null | undefined, allowed: readonly string[]): boolean {
  if (!host || allowed.length === 0) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return allowed.includes(name);
}
