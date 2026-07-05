import { cpSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DB_RUNTIME_FILES = ["eventTables.ts"] as const;

export interface CopyDatabaseRuntimeFilesOptions {
  projectRoot: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function copyDatabaseRuntimeFiles({
  projectRoot,
  log = console.log,
  warn = console.warn,
}: CopyDatabaseRuntimeFilesOptions): void {
  const dbSource = join(projectRoot, "src", "db");
  const dbDest = join(projectRoot, "dist", "src", "db");
  const migrationsSource = join(dbSource, "migrations");
  const migrationsDest = join(dbDest, "migrations");

  if (existsSync(migrationsSource)) {
    mkdirSync(migrationsDest, { recursive: true });
    cpSync(migrationsSource, migrationsDest, { recursive: true });
    log("✓ Copied database migrations");
  } else {
    warn(`Database migrations not found at ${migrationsSource}`);
  }

  mkdirSync(dbDest, { recursive: true });
  for (const file of DB_RUNTIME_FILES) {
    const source = join(dbSource, file);
    if (!existsSync(source)) {
      warn(`Database runtime file not found at ${source}`);
      continue;
    }
    cpSync(source, join(dbDest, file));
  }
  log("✓ Copied database runtime files");
}
