// Bun test preload: route all DB-backed tests at the isolated test database so the
// destructive truncate/insert tests can never touch real synced data.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
