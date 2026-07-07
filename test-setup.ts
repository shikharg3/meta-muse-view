// Bun test preload: route all DB-backed tests at the isolated test database so the
// destructive truncate/insert tests can never touch real synced data.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Pure-logic tests (no real DB) still need env() to parse; provide safe fallbacks. Real DB tests set
// TEST_DATABASE_URL (above) or DATABASE_URL, so this placeholder is only used when nothing queries.
process.env.APP_ENCRYPTION_KEY ||= "a".repeat(64);
process.env.DATABASE_URL ||= "postgres://localhost/placeholder";
// Tests must not inherit an ambient basic-auth credential — it would replace the session gate.
delete process.env.BASIC_AUTH_USER;
delete process.env.BASIC_AUTH_PASS;
