import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  installAppSchema,
  registerAppTools,
  resetInstallAppToolDependencies,
  resetUninstallAppToolDependencies,
  setInstallAppToolDependencies,
  setUninstallAppToolDependencies,
  uninstallAppSchema,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SigningGuardError } from "../../src/models/SigningGuardError";
import { SIGNER_A } from "../helpers/signedApkFixtures";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };

describe("install/uninstall signing guard arguments", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerAppTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
    resetInstallAppToolDependencies();
    resetUninstallAppToolDependencies();
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
    setUninstallAppToolDependencies({
      createUninstallApp: () => ({
        execute: async (...args) => {
          calls.push(args.slice(0, 5));
          return { success: true, packageName: "a.b", keepData: false, wasInstalled: true };
        },
      }),
    });
    const handler = ToolRegistry.getTool("uninstallApp")?.deviceAwareHandler;
    await handler?.(device, { appId: "a.b", expectedSigningSha256: [SIGNER_A] });
    await handler?.(device, { appId: "a.b" });
    expect(calls[0]?.[4]).toEqual({ expectedSigningSha256: [SIGNER_A] });
    expect(calls[1]).toHaveLength(4);
  });

  test("installApp forwards guards and surfaces a typed refusal", async () => {
    const calls: unknown[][] = [];
    setInstallAppToolDependencies({
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
    expect(calls[0]?.[3]).toEqual({
      expectedSigningSha256: [SIGNER_A],
      allowDestructiveRecovery: false,
    });
  });
});
