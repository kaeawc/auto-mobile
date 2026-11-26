import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IOS_DISPOSABLE_APP_TEMPLATE } from "../../../../../src/features/prototype/disposableApp/ios/iosDisposableAppTemplate";
import { selectDisposableAppTemplate } from "../../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import type { PrototypeJson } from "../../../../../src/features/prototype/prototypeJson";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

function spec(extra: Record<string, unknown>): PrototypeJson {
  return {
    id: "viewer",
    window: { placement: { type: "fullscreen" } },
    root: { type: "text", text: "Hi" },
    ...extra,
  } as PrototypeJson;
}

describe("iOS disposable-app template capabilities (#19369)", () => {
  test("the Viewer's system registry wires the secure storage and notifications modules", () => {
    // The Viewer app builds its registry with
    // makeSystemRegistry(notifications:), defined here.
    const registry = readFileSync(
      path.join(
        repoRoot,
        "ios/prototype-agent/Sources/AutoMobilePrototypeAgent/UIPasteboardPrototypeClipboard.swift",
      ),
      "utf8",
    );
    expect(registry).toContain("makeSystemRegistry(");
    expect(registry).toContain("secureStorage: KeychainPrototypeSecureValueStore()");
    expect(registry).toContain("notifications: notifications");
  });

  test("accepts a spec that needs secure storage and notifications", () => {
    const needsModules = spec({
      requires: { platform: ["secureStorage", "notifications"] },
      state: { token: "" },
      storage: { version: 1, keys: ["state:token"], secure: ["state:token"] },
    });
    expect(selectDisposableAppTemplate(needsModules, [IOS_DISPOSABLE_APP_TEMPLATE]).name).toBe(
      "base",
    );
  });
});
