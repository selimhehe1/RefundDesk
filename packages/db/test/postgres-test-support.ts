import { readdir, readFile } from "node:fs/promises";

const MIGRATION_DIRECTORY_PATTERN = /^\d+_[a-z0-9_]+$/u;

export async function readOrderedMigrationSql(): Promise<readonly string[]> {
  const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrationDirectories = entries
    .filter((entry) => entry.isDirectory() && MIGRATION_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  return Promise.all(
    migrationDirectories.map((directory) =>
      readFile(new URL(`${directory}/migration.sql`, migrationsDirectory), "utf8"),
    ),
  );
}
