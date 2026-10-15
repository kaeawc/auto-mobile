import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Existing hooks are a ratchet: remove allowances as callers migrate to injection.
const ALLOWLIST: Record<string, number> = {
  "appFileService.ts": 2,
  "appResources.ts": 1,
  "appTools.ts": 18,
  "bootedDeviceResources.ts": 2,
  "deviceReadinessProxyProvider.ts": 1,
  "deviceSnapshotManager.ts": 1,
  "deviceTools.ts": 2,
  "emulatorLossIncidentResources.ts": 2,
  "interactionTools.ts": 40,
  "observationResources.ts": 2,
  "preferenceTools.ts": 1,
  "storageResources.ts": 1,
  "storageTools.ts": 2,
  "toolOutputResources.ts": 2,
  "videoRecordingManager.ts": 1,
  "videoRecordingTools.ts": 3,
  "webrtcStreamManager.ts": 1,
};
const SERVER_DIR = join(import.meta.dir, "../../src/server");

describe("server tool test seams", () => {
  test("does not add process-global factory or dependency hooks", () => {
    const violations: string[] = [];
    for (const file of readdirSync(SERVER_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort()) {
      const source = readFileSync(join(SERVER_DIR, file), "utf8");
      const count = [
        ...source.matchAll(
          /export function (set|reset)[A-Z]\w*(Factory|ForTesting|ForTests|Dependencies)\b/g,
        ),
      ].length;
      const allowed = ALLOWLIST[file] ?? 0;
      if (count > allowed) {
        violations.push(`${file}: ${count} hooks exceeds allowance ${allowed}`);
      }
    }
    expect(
      violations,
      "Inject dependencies via register*/create*Handler instead of exported set/reset test hooks.",
    ).toEqual([]);
  });
});
