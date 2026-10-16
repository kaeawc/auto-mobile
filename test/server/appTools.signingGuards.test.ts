import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installAppSchema, uninstallAppSchema } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SigningGuardError } from "../../src/models/SigningGuardError";
import { SIGNER_A } from "../helpers/signedApkFixtures";
import { createAppToolsHarness } from "../helpers/appToolsHarness";

const appTools = createAppToolsHarness();

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };

describe("install/uninstall signing guard arguments", () => {
  beforeEach(() => {
    appTools.reset();
  });
  afterEach(() => {
    appTools.clear();
  });

  test("schemas accept well-formed digests and reject malformed or empty lists", () => {
    expect(
      uninstallAppSchema.safeParse({ appId: "a.b", expectedSigningSha256: [SIGNER_A] }).success,
    ).toBe(true);
    expect(
      installAppSchema.safeParse({
        artifactPath: "/x.apk",
        expectedSigningSha256: [SIGNER_A],
        allowDestructiveRecovery: false,
      }).success,
    ).toBe(true);
    expect(
      uninstallAppSchema.safeParse({ appId: "a.b", expectedSigningSha256: ["abc"] }).success,
    ).toBe(false);
    expect(uninstallAppSchema.safeParse({ appId: "a.b", expectedSigningSha256: [] }).success).toBe(
      false,
    );
  });

  test("uninstallApp forwards the guard; without one the call shape is unchanged", async () => {
    const calls: unknown[][] = [];
    appTools.configure("uninstallApp", {
      createUninstallApp: () => ({
        execute: async (...args) => {
          calls.push(args);
          return { success: true, packageName: "a.b", keepData: false, wasInstalled: true };
        },
      }),
    });
    const handler = ToolRegistry.getTool("uninstallApp")?.deviceAwareHandler;
    await handler?.(device, { appId: "a.b", expectedSigningSha256: [SIGNER_A] });
    await handler?.(device, { appId: "a.b" });
    expect((calls[0]?.[1] as UninstallAppCall | undefined)?.guard).toEqual({
      expectedSigningSha256: [SIGNER_A],
    });
    expect((calls[1]?.[1] as UninstallAppCall | undefined)?.guard).toBeUndefined();
  });

  test("installApp forwards guards and surfaces a typed refusal", async () => {
    const calls: unknown[][] = [];
    appTools.configure("installApp", {
      createInstallApp: () => ({
        execute: async (...args) => {
          calls.push(args);
          throw new SigningGuardError("mismatch", "signed by a different key", {
            appId: "a.b",
            userId: 0,
            expectedSha256: [SIGNER_A],
          });
        },
      }),
    });
    const handler = ToolRegistry.getTool("installApp")?.deviceAwareHandler;
    await expect(
      handler?.(device, {
        artifactPath: "/x.apk",
        expectedSigningSha256: [SIGNER_A],
        allowDestructiveRecovery: false,
      }),
    ).rejects.toBeInstanceOf(SigningGuardError);
    expect((calls[0]?.[1] as InstallAppCall | undefined)?.guard).toEqual({
      expectedSigningSha256: [SIGNER_A],
      allowDestructiveRecovery: false,
    });
  });
});
