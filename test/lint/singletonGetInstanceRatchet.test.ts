import { typeScriptFiles, relativePosix, readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { countSingletonGetInstanceCalls } from "./singletonGetInstanceCalls";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
// Parsing every src file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

/**
 * #11806: collaborators are passed in from the composition roots instead of being fetched with
 * `X.getInstance()`. These roots may resolve singletons freely; every other src file counts.
 */
const COMPOSITION_ROOTS: ReadonlySet<string> = new Set([
  "src/index.ts",
  "src/daemon/daemon.ts",
  "src/server/index.ts",
]);

/**
 * Remaining `<Class>.getInstance(` calls outside the composition roots, totalled per receiver so
 * moving a call between files does not trip the ratchet. A total may only shrink: lower it in
 * the PR that injects the dependency instead. `DaemonState` also has its own zero-baseline guard
 * (`daemonStateGetInstanceRatchet.test.ts`) for everything but `daemonContext.ts`.
 */
const REMAINING_GET_INSTANCE_CALLS: Readonly<Record<string, number>> = {
  AndroidAvdProvenanceCache: 8,
  AndroidCtrlProxyClient: 82,
  AndroidCtrlProxyManager: 12,
  clients: 1,
  CriticalSectionCoordinator: 2,
  DaemonState: 1,
  FailureRecorder: 1,
  FeatureFlagService: 11,
  ImageCache: 4,
  IosCtrlProxyBuilder: 2,
  IOSCtrlProxyClient: 64,
  IOSCtrlProxyManager: 11,
  NavigationGraphManager: 16,
  NavigationScreenshotManager: 4,
  NetworkState: 14,
  PlatformDeviceManagerFactory: 14,
  PrototypeAgentProvider: 1,
  RecompositionTracker: 14,
  ScreenCaptureHelperProvider: 4,
  ServerConfig: 1,
  TelemetryRecorder: 9,
  VideoServerJarProvider: 3,
};

describe("countSingletonGetInstanceCalls", () => {
  test("counts calls per receiver in every call form", () => {
    const source = [
      "A.getInstance();",
      "A?.getInstance(device);",
      'B["getInstance"]();',
      "(B.getInstance)();",
      "C.getInstance().field;",
    ].join("\n");
    expect(Object.fromEntries(countSingletonGetInstanceCalls("x.ts", source))).toEqual({
      A: 2,
      B: 2,
      C: 1,
    });
  });

  test("ignores non-calls and receivers that are not a named class", () => {
    const source = [
      "type T = ReturnType<typeof A.getInstance>;",
      "// A.getInstance()",
      'const s = "A.getInstance()";',
      "const f = A.getInstance;",
      "this.getInstance();",
      "a.b.getInstance();",
      "A.resetInstance();",
    ].join("\n");
    expect(countSingletonGetInstanceCalls("x.ts", source).size).toBe(0);
  });
});

describe("singleton getInstance() ratchet outside the composition roots (#11806)", () => {
  const totals: Record<string, number> = {};

  beforeAll(() => {
    for (const file of typeScriptFiles(SRC_DIR)) {
      const relative = relativePosix(REPO_ROOT, file);
      if (COMPOSITION_ROOTS.has(relative)) {
        continue;
      }
      for (const [receiver, count] of countSingletonGetInstanceCalls(
        relative,
        readGuardFile(file),
      )) {
        totals[receiver] = (totals[receiver] ?? 0) + count;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no receiver gains getInstance() calls", () => {
    const grown = Object.entries(totals)
      .filter(([receiver, count]) => count > (REMAINING_GET_INSTANCE_CALLS[receiver] ?? 0))
      .map(([receiver, count]) => `${receiver}: ${count}`);
    expect(
      grown,
      "Take the collaborator as a constructor or register* dependency instead of calling getInstance().",
    ).toEqual([]);
  });

  test("the remaining totals are tight, so removing a call must lower them", () => {
    expect(totals).toEqual(REMAINING_GET_INSTANCE_CALLS);
  });
});
