import { expect, test } from "bun:test";
import { ResetKeychain } from "../../../src/features/action/ResetKeychain";
import type {
  KeystoreFault,
  KeystoreFaultBackend,
  KeystoreFaultMethod,
  KeystoreFaultRequest,
} from "../../../src/features/storage/keystoreFault";
import type { KeystoreResetBackend } from "../../../src/features/storage/keystoreReset";
import { resetKeychainResultSchema } from "../../../src/server/appToolOutputSchemas";
import { resetKeychainSchema } from "../../../src/server/appToolsSchemas";

const android = { platform: "android" as const, deviceId: "emulator-5554", name: "emu" };

class FakeFaultBackend implements KeystoreFaultBackend {
  readonly calls: [string, KeystoreFaultMethod, KeystoreFaultRequest][] = [];
  constructor(private readonly reply: Partial<KeystoreFault> = {}) {}
  async updateKeystoreFaults(
    packageName: string,
    method: KeystoreFaultMethod,
    request: KeystoreFaultRequest,
  ): Promise<KeystoreFault> {
    this.calls.push([packageName, method, request]);
    return {
      schemaVersion: 1,
      capability: "storage.keystore",
      bridgeAvailable: true,
      requestedScope: request.scope,
      requestedAlias: request.alias,
      requestedKind: request.kind,
      outcome: "ok",
      ...this.reply,
    };
  }
}

const unusedReset: KeystoreResetBackend = {
  async resetKeystore() {
    throw new Error("reset must not run for a fault action");
  },
};

test("injectFault forwards the selector, kind and delay and returns the provider result", async () => {
  const faults = new FakeFaultBackend();
  const result = await new ResetKeychain(android, null, unusedReset, faults).execute({
    appId: "com.example",
    action: "injectFault",
    scope: "login",
    kind: "DELAY",
    delayMs: 500,
    explicitlyTargeted: true,
  });
  expect(faults.calls).toEqual([
    [
      "com.example",
      "injectFault",
      { scope: "login", alias: undefined, kind: "DELAY", delayMs: 500 },
    ],
  ]);
  expect(result).toMatchObject({
    success: true,
    action: "injectFault",
    outcome: "ok",
    requestedKind: "DELAY",
    platform: "android",
    scope: "app",
    exceededRequestedScope: false,
  });
  expect(resetKeychainResultSchema.safeParse(result).success).toBe(true);
});

test("clearFaults by alias calls the provider and never the reset backend", async () => {
  const faults = new FakeFaultBackend();
  const result = await new ResetKeychain(android, null, unusedReset, faults).execute({
    appId: "com.example",
    action: "clearFaults",
    alias: "token",
    explicitlyTargeted: true,
  });
  expect(faults.calls.map(([, method]) => method)).toEqual(["clearFaults"]);
  expect(result).toMatchObject({ success: true, action: "clearFaults", requestedAlias: "token" });
});

test("a provider refusal is unsuccessful and fits the advertised output schema", async () => {
  const faults = new FakeFaultBackend({
    outcome: "scope_not_declared",
    reason: "SCOPE_NOT_DECLARED",
  });
  const result = await new ResetKeychain(android, null, null, faults).execute({
    appId: "com.example",
    action: "injectFault",
    scope: "undeclared",
    kind: "KEY_STORE_EXCEPTION",
    explicitlyTargeted: true,
  });
  expect(result.success).toBe(false);
  expect(result.message).toBe(
    "Android Keystore injectFault: scope_not_declared (SCOPE_NOT_DECLARED).",
  );
  expect(resetKeychainResultSchema.safeParse(result).success).toBe(true);
});

test("invalid selectors and faults get the provider's refusal without a device call", async () => {
  const faults = new FakeFaultBackend();
  const action = new ResetKeychain(android, null, null, faults);
  const empty = await action.execute({
    appId: "com.example",
    action: "clearFaults",
    scope: " ",
    explicitlyTargeted: true,
  });
  const delay = await action.execute({
    appId: "com.example",
    action: "injectFault",
    alias: "token",
    kind: "DELAY",
    explicitlyTargeted: true,
  });
  expect(empty).toMatchObject({
    success: false,
    outcome: "invalid_selector",
    reason: "EMPTY_SELECTOR",
  });
  expect(delay).toMatchObject({
    success: false,
    outcome: "invalid_selector",
    reason: "INVALID_FAULT",
  });
  expect(resetKeychainResultSchema.safeParse(delay).success).toBe(true);
  expect(faults.calls).toHaveLength(0);
});

test("fault actions keep reset's targeting and confirm:false gates", async () => {
  const faults = new FakeFaultBackend();
  const action = new ResetKeychain(android, null, null, faults);
  const base = {
    appId: "com.example",
    action: "injectFault" as const,
    scope: "login",
    kind: "PROVIDER_EXCEPTION",
  };
  await expect(action.execute({ ...base, explicitlyTargeted: false })).rejects.toThrow(
    "explicit device target",
  );
  await expect(
    action.execute({ ...base, confirm: false, explicitlyTargeted: true }),
  ).rejects.toThrow("confirm is false");
  expect(faults.calls).toHaveLength(0);
});

test("kind or delayMs without injectFault is refused", async () => {
  const action = new ResetKeychain(android, null, unusedReset, new FakeFaultBackend());
  await expect(
    action.execute({
      appId: "com.example",
      scope: "login",
      kind: "DELAY",
      explicitlyTargeted: true,
    }),
  ).rejects.toThrow("only to action: injectFault");
  await expect(
    action.execute({
      appId: "com.example",
      action: "clearFaults",
      scope: "login",
      delayMs: 5,
      explicitlyTargeted: true,
    }),
  ).rejects.toThrow("only to action: injectFault");
});

test("fault actions are refused on iOS", async () => {
  const ios = { platform: "ios" as const, deviceId: "SIM-1", name: "sim" };
  const simctl = {
    async executeCommandArgs(): Promise<never> {
      throw new Error("simctl must not run");
    },
  };
  await expect(
    new ResetKeychain(ios, simctl).execute({
      appId: "com.example",
      action: "clearFaults",
      scope: "login",
      explicitlyTargeted: true,
    }),
  ).rejects.toThrow("only on Android");
});

test("a valid request without a fault transport is an actionable availability error", async () => {
  await expect(
    new ResetKeychain(android, null, null, null).execute({
      appId: "com.example",
      action: "clearFaults",
      scope: "login",
      explicitlyTargeted: true,
    }),
  ).rejects.toThrow("Android Keystore clearFaults is unavailable in this entry point.");
});

test("tool schema accepts fault actions and bounds kind and delayMs", () => {
  const parse = (args: object) =>
    resetKeychainSchema.safeParse({ appId: "com.example", scope: "login", ...args }).success;
  expect(parse({ action: "injectFault", kind: "DELAY", delayMs: 10_000 })).toBe(true);
  expect(parse({ action: "clearFaults" })).toBe(true);
  expect(parse({ action: "injectFault", kind: "delay" })).toBe(false);
  expect(parse({ action: "injectFault", kind: "DELAY", delayMs: 0 })).toBe(false);
  expect(parse({ action: "injectFault", kind: "DELAY", delayMs: 10_001 })).toBe(false);
  expect(parse({ action: "wipe" })).toBe(false);
});
