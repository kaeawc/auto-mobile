import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * These are the package-scoped device-shell command forms changed in this
 * boundary pass. The files also contain older, unrelated command construction
 * (notably activity discovery), so this deliberately guards these exact sinks.
 */
const protectedCommands = [
  [
    "src/features/action/LaunchApp.ts",
    "shell am start --user ${userId} -n",
    "shellQuote(`${packageName}/",
  ],
  ["src/features/action/LaunchApp.ts", "shell monkey -p", "shellQuote(packageName)"],
  ["src/features/action/ClearAppData.ts", "shell pm clear", "shellQuote(packageName)"],
  ["src/features/action/TerminateApp.ts", "shell am force-stop", "shellQuote(packageName)"],
  ["src/features/action/UninstallApp.ts", "shell am force-stop", "shellQuote(packageName)"],
  ["src/features/action/UninstallApp.ts", "shell pm uninstall", "shellQuote(packageName)"],
  ["src/features/database/DatabaseInspector.ts", "shell content call --uri", "shellQuote(uri)"],
  ["src/utils/ContentHashProvider.ts", "shell pm path ${packageId}", "shellQuote(packageId)"],
  ["src/utils/ContentHashProvider.ts", "apkPaths.map((p)", "shellQuote(p)"],
  ["src/utils/CtrlProxyManager.ts", "shell sha256sum", "shellQuote(apkPath)"],
  ["src/server/systemTrayHelpers.ts", "shell dumpsys package", "shellQuote(appId)"],
  ["src/features/utility/PostNotification.ts", "query-receivers --brief", "shellQuote(appId)"],
  ["src/utils/AppLifecycleMonitor.ts", "shell pidof", "shellQuote(packageName)"],
  ["src/utils/DeepLinkManager.ts", "shell dumpsys package", "shellQuote(appId)"],
  [
    "src/features/memory/MemoryMetricsCollector.ts",
    "shell dumpsys meminfo",
    "shellQuote(packageName)",
  ],
  ["src/features/memory/MemoryMetricsCollector.ts", "shell pidof", "shellQuote(packageName)"],
  ["src/features/memory/MemoryMetricsCollector.ts", "shell kill -USR1", "shellQuote(pid)"],
  [
    "src/features/memory/MemoryMetricsCollector.ts",
    "shell logcat -d -v epoch",
    "shellQuote(resolvedPid)",
  ],
  [
    "src/features/performance/PerformanceAudit.ts",
    "shell dumpsys gfxinfo",
    "shellQuote(packageName)",
  ],
  ["src/features/performance/PerformanceAudit.ts", "shell pidof", "shellQuote(packageName)"],
  ["src/features/performance/PerformanceAudit.ts", "shell ps -T -p", "shellQuote(pid)"],
  ["src/features/performance/PerformanceAudit.ts", "shell cat /proc/${", "shellQuote(pid)"],
  [
    "src/features/performance/PerformanceMonitor.ts",
    "shell dumpsys gfxinfo",
    "shellQuote(device.packageName)",
  ],
  [
    "src/features/performance/PerformanceMonitor.ts",
    "shell pidof",
    "shellQuote(device.packageName)",
  ],
  ["src/features/performance/PerformanceMonitor.ts", "shell cat /proc/${", "shellQuote(pid)"],
  [
    "src/features/performance/TouchLatencyTracker.ts",
    "shell dumpsys gfxinfo",
    "shellQuote(packageName)",
  ],
  ["src/features/action/LaunchApp.ts", "shell pm dump", "shellQuote(packageName)"],
  ["src/features/action/LaunchApp.ts", "shell pm list packages -f", "shellQuote(packageName)"],
  [
    "src/features/action/TerminateApp.ts",
    "shell pm list packages --user",
    "shellQuote(packageName)",
  ],
  [
    "src/features/action/RestoreSnapshot.ts",
    "shell am start -a android.intent.action.MAIN",
    "shellQuote(packageName)",
  ],
  [
    "src/features/action/InstallApp.ts",
    "shell pm list packages --user ${targetUserId}",
    "shellQuote(packageNameForCommand)",
  ],
  ["src/features/observe/GetAppMetadata.ts", "shell dumpsys package", "shellQuote(packageName)"],
  ["src/features/observe/AwaitIdle.ts", "shell dumpsys gfxinfo", "shellQuote(packageName)"],
  ["src/features/observe/Idle.ts", "shell dumpsys gfxinfo", "shellQuote(packageName)"],
] as const;

describe("package-scoped Android device-shell boundary", () => {
  test("requires shellQuote at every hardened command sink", () => {
    const failures = protectedCommands.flatMap(([file, prefix, required]) => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      return lines
        .filter((line) => line.includes(prefix) && !line.includes(required))
        .map((line) => `${file}: ${line.trim()}`);
    });

    expect(failures).toEqual([]);
  });
});
