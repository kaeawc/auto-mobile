import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIRECTORY_OVERRIDES = [
  ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR", "data"],
  ["AUTOMOBILE_LOG_DIR", "AUTO_MOBILE_LOG_DIR", "logs"],
  ["AUTOMOBILE_COORDINATION_DIR", "AUTO_MOBILE_COORDINATION_DIR", "coord"],
  // Device allocation claims ignore the coordination dir (#10708); keep them off the real home.
  [
    "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
    "AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR",
    "adb-servers",
  ],
] as const;

/** Pure env transformation: each directory is independent; explicit values survive unchanged. */
export function isolatedTestDirectoryEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const [primary, twin, child] of DIRECTORY_OVERRIDES) {
    if (env[primary]?.trim()) {
      continue;
    }
    if (env[twin]?.trim()) {
      // Production resolvers use ??, so a blank primary would shadow the explicit twin.
      delete isolated[primary];
      continue;
    }
    isolated[primary] = path.join(root, child);
  }
  return isolated;
}

// Only Node built-ins precede this setup. In particular, do not import production
// modules here: logger and daemon constants can bind paths during module evaluation.
export const testDirectoryRoot = mkdtempSync(path.join(os.tmpdir(), "am-test-"));
for (const [, , child] of DIRECTORY_OVERRIDES) {
  mkdirSync(path.join(testDirectoryRoot, child), { mode: 0o700 });
}
const isolatedEnv = isolatedTestDirectoryEnv(process.env, testDirectoryRoot);
// Name the data directory this preload assigned (mirrors UNIT_TEST_ISOLATED_DATA_DIR_ENV in
// src/features/observe/Window.ts, which cannot be imported before production modules bind
// paths): process isolation must not opt every unit test into the window disk cache (#9487).
if (isolatedEnv.AUTOMOBILE_DATA_DIR !== process.env.AUTOMOBILE_DATA_DIR) {
  process.env.AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR = isolatedEnv.AUTOMOBILE_DATA_DIR;
}
Object.assign(process.env, isolatedEnv);
// Object.assign cannot remove a blank primary that shadows a legacy override.
for (const [primary, twin] of DIRECTORY_OVERRIDES) {
  if (!process.env[primary]?.trim() && process.env[twin]?.trim()) {
    delete process.env[primary];
  }
}
export function cleanupTestDirectories(): void {
  try {
    rmSync(testDirectoryRoot, { recursive: true, force: true });
  } catch {
    // Best effort: filesystem cleanup must not block process exit.
  }
}
process.once("exit", cleanupTestDirectories);
