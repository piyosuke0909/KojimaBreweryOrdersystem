import { readdirSync, readFileSync } from 'node:fs';

/** Exercise the same complete schema as a freshly migrated Worker database. */
export function migrateTestDatabase(database: { exec(sql: string): unknown }) {
  const directory = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
}
