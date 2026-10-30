/** Resolve Android bare database names in the app's default databases directory. */
export function resolveAndroidDatabasePath(appId: string, databasePath: string): string {
  return databasePath.length > 0 &&
    !databasePath.includes("/") &&
    !databasePath.includes("\\") &&
    databasePath !== "." &&
    databasePath !== ".."
    ? `/data/data/${appId}/databases/${databasePath}`
    : databasePath;
}
