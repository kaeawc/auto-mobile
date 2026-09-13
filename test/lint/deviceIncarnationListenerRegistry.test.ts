import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("VM restore incarnation listener registry", () => {
  test("keeps every known per-serial state owner registered", () => {
    const expected: Readonly<Record<string, string>> = {
      "ctrlproxy-client": "src/features/observe/android/AndroidCtrlProxyClient.ts",
      "ctrlproxy-manager": "src/utils/CtrlProxyManager.ts",
      "observe-window-cache": "src/features/action/TerminateApp.ts",
      "installed-apps": "src/server/appResources.ts",
      "performance-monitoring": "src/features/performance/PerformanceMonitor.ts",
      "session-readiness": "src/daemon/daemonState.ts",
    };

    for (const [name, file] of Object.entries(expected)) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain("registerDeviceIncarnationListener");
      expect(source).toContain(`name: \"${name}\"`);
    }
  });
});
