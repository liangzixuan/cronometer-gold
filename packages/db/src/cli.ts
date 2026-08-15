import "dotenv/config";

import { createDatabaseFromEnvironment } from "./client.js";
import { runMigrations } from "./migrator.js";

const database = createDatabaseFromEnvironment();

try {
  const migrationDirectory = process.env.DB_MIGRATIONS_DIR;
  const result = await runMigrations(
    database,
    migrationDirectory === undefined ? {} : { directory: migrationDirectory },
  );

  if (result.applied.length === 0) {
    process.stdout.write("Database is current; no migrations applied.\n");
  } else {
    process.stdout.write(
      `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}\n`,
    );
  }
} finally {
  await database.destroy();
}
