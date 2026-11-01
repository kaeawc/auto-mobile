import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { ResetKeychain } from "../../../src/features/action/ResetKeychain";
import {
  keystoreResetSchema,
  type KeystoreReset,
} from "../../../src/features/storage/keystoreReset";
import { resetKeychainResultSchema } from "../../../src/server/appToolOutputSchemas";
import { resetKeychainSchema } from "../../../src/server/appToolsSchemas";

const device = { platform: "android" as const, deviceId: "test", name: "test" };
const state: KeystoreReset = {
  schemaVersion: 1,
  capability: "storage.keystore",
  outcome: "ok",
  bridgeAvailable: true,
  status: "deleted",
  deletedCount: 1,
  requestedScope: "login",
  aliases: [{ alias: "token", outcome: "deleted" }],
};
test("Android scoped reset forwards selectors without confirmation", async () => {
  const calls: unknown[] = [];
  const action = new ResetKeychain(device, null, {
    async resetKeystore(...args) {
      calls.push(args);
      return state;
    },
  });
  const result = await action.execute({
    appId: "com.example",
    scope: "login",
    explicitlyTargeted: true,
  });
  expect(calls).toEqual([["com.example", "login", undefined]]);
  expect(result).toMatchObject({
    success: true,
    scope: "app",
    exceededRequestedScope: false,
    status: "deleted",
    deletedCount: 1,
  });
});
test("Android empty selector and ambient targeting never call facade", async () => {
  let calls = 0;
  const action = new ResetKeychain(device, null, {
    async resetKeystore() {
      calls++;
      return state;
    },
  });
  await expect(action.execute({ appId: "com.example", explicitlyTargeted: true })).rejects.toThrow(
    "scope or alias",
  );
  await expect(
    action.execute({ appId: "com.example", scope: "login", explicitlyTargeted: false }),
  ).rejects.toThrow("explicit device target");
  await expect(
    action.execute({ appId: "com.example", scope: " ", alias: " ", explicitlyTargeted: true }),
  ).rejects.toThrow("scope or alias");
  expect(calls).toBe(0);
});
for (const status of ["partial", "failed"] as const) {
  test(`Android ${status} is unsuccessful`, async () => {
    const action = new ResetKeychain(device, null, {
      async resetKeystore() {
        return { ...state, status };
      },
    });
    expect(
      (await action.execute({ appId: "com.example", alias: "token", explicitlyTargeted: true }))
        .success,
    ).toBe(false);
  });
}
test("reset schema strips unexpected fields including alias key material", () => {
  expect(
    keystoreResetSchema.parse({
      ...state,
      key: "secret",
      aliases: [{ alias: "token", outcome: "deleted", key: "secret" }],
    }),
  ).toEqual(state);
});
test("tool accepts scope or alias without confirm", () => {
  expect(resetKeychainSchema.safeParse({ appId: "com.example", scope: "login" }).success).toBe(
    true,
  );
  expect(resetKeychainSchema.safeParse({ appId: "com.example", alias: "token" }).success).toBe(
    true,
  );
});

test("Android request refusal is unsuccessful and fits the advertised output schema", async () => {
  const action = new ResetKeychain(device, null, {
    async resetKeystore() {
      return {
        schemaVersion: 1,
        capability: "storage.keystore",
        bridgeAvailable: true,
        outcome: "authorization_denied",
        reason: "MUTATION_NOT_ALLOWED",
        requestedAlias: "token",
        deletedCount: 0,
      };
    },
  });
  const result = await action.execute({
    appId: "com.example",
    alias: "token",
    explicitlyTargeted: true,
  });
  expect(result.success).toBe(false);
  expect(result.aliases).toBeUndefined();
  expect(resetKeychainResultSchema.safeParse(result).success).toBe(true);
});

test("tool selectors retain exact declared identifiers", () => {
  expect(
    resetKeychainSchema.parse({ appId: "com.example", scope: " login ", alias: " token " }),
  ).toMatchObject({ scope: " login ", alias: " token " });
});

test("Android reset without an injected backend throws an actionable availability error", async () => {
  const action = new ResetKeychain(device);
  const reset = action.execute({
    appId: "com.example",
    scope: "login",
    explicitlyTargeted: true,
  });
  await expect(reset).rejects.toBeInstanceOf(ActionableError);
  await expect(reset).rejects.toThrow("Android Keystore reset is unavailable in this entry point.");
});

test("Android refuses an explicit confirm: false before calling the facade (#16274)", async () => {
  let calls = 0;
  const action = new ResetKeychain(device, null, {
    async resetKeystore() {
      calls++;
      return state;
    },
  });
  await expect(
    action.execute({
      appId: "com.example",
      scope: "login",
      confirm: false,
      explicitlyTargeted: true,
    }),
  ).rejects.toThrow("Set confirm: true to proceed");
  expect(calls).toBe(0);
  await action.execute({
    appId: "com.example",
    scope: "login",
    confirm: true,
    explicitlyTargeted: true,
  });
  expect(calls).toBe(1);
});
