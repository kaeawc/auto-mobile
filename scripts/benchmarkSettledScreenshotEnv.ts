import nodePath, { type posix } from "node:path";

type BenchmarkPathApi = Pick<typeof posix, "isAbsolute" | "join" | "resolve">;

export type BenchmarkChildEnv = Record<string, string | undefined>;

function privatePaths(runDir: string, pathApi: BenchmarkPathApi): Record<string, string> {
  // Resolve both sides with the same flavour; drive-absolute win32 roots are cwd-independent.
  if (!pathApi.isAbsolute(runDir) || pathApi.resolve(runDir) === pathApi.resolve(runDir, "..")) {
    throw new Error("Benchmark run directory must be an absolute, non-root path.");
  }
  // Include the longest auxiliary socket basename, not just d.sock and w.sock.
  const longestSocket = pathApi.join(runDir, "observation-stream.sock");
  if (Buffer.byteLength(longestSocket, "utf8") >= 100) {
    throw new Error(
      "Benchmark socket paths must be shorter than 100 bytes; use a shorter run directory.",
    );
  }
  return {
    AUTOMOBILE_DAEMON_SOCKET_PATH: pathApi.join(runDir, "d.sock"),
    AUTOMOBILE_DAEMON_PID_FILE_PATH: pathApi.join(runDir, "d.pid"),
    AUTOMOBILE_DAEMON_LOCK_FILE_PATH: pathApi.join(runDir, "d.lock"),
    AUTOMOBILE_AUX_SOCKET_DIR: runDir,
    AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: pathApi.join(runDir, "w.sock"),
    AUTOMOBILE_DATA_DIR: pathApi.join(runDir, "data"),
    AUTOMOBILE_LOG_DIR: pathApi.join(runDir, "logs"),
    AUTOMOBILE_DB_PATH: pathApi.join(runDir, "auto-mobile.db"),
    AUTOMOBILE_DAEMON_LAUNCH_CWD: runDir,
  };
}

function legacyKeys(paths: Record<string, string>): string[] {
  return [...Object.keys(paths), "AUTOMOBILE_DB_DIR"].map((key) =>
    key.replace("AUTOMOBILE_", "AUTO_MOBILE_"),
  );
}

/** No parent mutation or environment reads; coordination and device settings stay inherited. */
export function buildBenchmarkChildEnv(
  parentEnv: BenchmarkChildEnv,
  runDir: string,
  pathApi: BenchmarkPathApi = nodePath,
): BenchmarkChildEnv {
  const paths = privatePaths(runDir, pathApi);
  const env = { ...parentEnv };
  // Daemon launch metadata and timing selectors must not leak from the parent.
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTOMOBILE_DAEMON_") || key.startsWith("AUTO_MOBILE_DAEMON_")) {
      delete env[key];
    }
  }
  Object.assign(env, paths);
  delete env.AUTOMOBILE_DB_DIR;
  for (const key of legacyKeys(paths)) {
    delete env[key];
  }
  return env;
}

/** Require the exact private paths, preventing even accidental within-directory retargeting. */
export function assertPrivateDaemonNamespace(
  env: BenchmarkChildEnv,
  runDir: string,
  pathApi: BenchmarkPathApi = nodePath,
): Record<string, string> {
  const paths = privatePaths(runDir, pathApi);
  for (const [key, expected] of Object.entries(paths)) {
    if (env[key] !== expected) {
      throw new Error(`Refusing benchmark child launch: ${key} must be ${expected}.`);
    }
  }
  for (const key of ["AUTOMOBILE_DB_DIR", ...legacyKeys(paths)]) {
    if (Object.hasOwn(env, key)) {
      throw new Error(`Refusing benchmark child launch: ${key} must be absent.`);
    }
  }
  return paths;
}

export function assertServerBuilt(serverPath: string, exists: boolean): void {
  if (!exists) {
    throw new Error(`Benchmark server entry is missing: ${serverPath}; run "bun run build" first.`);
  }
}
