const TEST_FILE_ENTRYPOINT = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The running script: the current test file under `bun test`, `dist/src/index.js` (or the compiled binary) otherwise. */
export function currentProcessEntrypoint(): string | undefined {
  // src/ is type-checked without Bun's globals; read `Bun.main` structurally.
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  return bun?.main ?? process.argv[1];
}

/**
 * Whether this process is the `bun test` runner itself. `NODE_ENV=test` alone is
 * not enough: it is inherited by every CLI/daemon child a real-device
 * integration test spawns (`execFile`, `daemonProcessEnvironment`), and those
 * children must reach the real device or database. Under `bun test`, `Bun.main`
 * is the test file being run; in a spawned child it is the child's own
 * entrypoint, which no environment inheritance can turn into a test file.
 */
export function isBunTestRunnerProcess(
  env: NodeJS.ProcessEnv,
  entrypoint: string | undefined,
): boolean {
  return (
    env.NODE_ENV === "test" && entrypoint !== undefined && TEST_FILE_ENTRYPOINT.test(entrypoint)
  );
}
