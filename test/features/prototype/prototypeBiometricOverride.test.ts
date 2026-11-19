import { describe, expect, test } from "bun:test";
import {
  PrototypeBiometricOverrideError,
  prototypeBiometricOverride,
  routePrototypeBiometric,
  type PrototypeBiometricOverride,
  type PrototypeBiometricReply,
  type PrototypeBiometricRoute,
  type PrototypeBiometricTarget,
} from "../../../src/features/prototype/prototypeBiometricOverride";
import { biometricAuthResultSchema } from "../../../src/server/biometricToolOutputSchemas";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

class FakeRoute implements PrototypeBiometricRoute {
  readonly delivered: Array<{ id: string; override: PrototypeBiometricOverride; ttlMs: number }> =
    [];
  constructor(
    private readonly shown: PrototypeBiometricTarget | undefined,
    private readonly reply: PrototypeBiometricReply | Error = { success: true },
  ) {}
  async target(): Promise<PrototypeBiometricTarget | undefined> {
    return this.shown;
  }
  async deliver(
    _device: BootedDevice,
    id: string,
    override: PrototypeBiometricOverride,
    ttlMs: number,
  ): Promise<PrototypeBiometricReply> {
    this.delivered.push({ id, override, ttlMs });
    if (this.reply instanceof Error) {
      throw this.reply;
    }
    return this.reply;
  }
}

const vault = { id: "vault", acceptsOverride: true };

describe("prototypeBiometricOverride", () => {
  test("cancel is cancelled whatever the error code", () => {
    expect(prototypeBiometricOverride("cancel")).toEqual({ code: "cancelled" });
  });

  test("error codes map like the Android runtime's prompt callback", () => {
    const cases: Array<[number, PrototypeBiometricOverride]> = [
      [5, { code: "cancelled" }],
      [10, { code: "cancelled" }],
      [7, { code: "unavailable", reason: "lockout" }],
      [9, { code: "unavailable", reason: "lockout" }],
      [11, { code: "unavailable", reason: "not_enrolled" }],
      [14, { code: "unavailable", reason: "not_enrolled" }],
      [1, { code: "unavailable", reason: "no_hardware" }],
      [12, { code: "unavailable", reason: "no_hardware" }],
      [3, { code: "platform_error", errorCode: 3 }],
    ];
    for (const [code, expected] of cases) {
      expect(prototypeBiometricOverride("error", code)).toEqual(expected);
    }
  });

  test("an error without a code is a platform_error", () => {
    expect(prototypeBiometricOverride("error")).toEqual({ code: "platform_error" });
  });
});

describe("routePrototypeBiometric", () => {
  test("no route or no prototype target keeps the SDK path", async () => {
    expect(await routePrototypeBiometric(undefined, device, { action: "cancel" })).toBeUndefined();
    const route = new FakeRoute(undefined);
    expect(await routePrototypeBiometric(route, device, { action: "cancel" })).toBeUndefined();
    expect(route.delivered).toEqual([]);
  });

  test("match, fail and enrollment never route to the prototype", async () => {
    const route = new FakeRoute(vault);
    for (const action of ["match", "fail", "enroll", "unenroll"]) {
      expect(await routePrototypeBiometric(route, device, { action })).toBeUndefined();
    }
    expect(route.delivered).toEqual([]);
  });

  test("cancel delivers cancelled with the default TTL and a schema-valid result", async () => {
    const route = new FakeRoute(vault);
    const result = await routePrototypeBiometric(route, device, { action: "cancel" });
    expect(route.delivered).toEqual([
      { id: "vault", override: { code: "cancelled" }, ttlMs: 5000 },
    ]);
    expect(result).toMatchObject({
      success: true,
      action: "cancel",
      route: "prototype",
      prototypeId: "vault",
      outcome: { code: "cancelled" },
    });
    expect(biometricAuthResultSchema.safeParse(result).success).toBe(true);
  });

  test("error lockout delivers unavailable/lockout with the caller's TTL", async () => {
    const route = new FakeRoute(vault);
    const result = await routePrototypeBiometric(route, device, {
      action: "error",
      errorCode: 7,
      ttlMs: 900,
      modality: "fingerprint",
    });
    expect(route.delivered[0]).toEqual({
      id: "vault",
      override: { code: "unavailable", reason: "lockout" },
      ttlMs: 900,
    });
    expect(result?.message).toContain("unavailable (lockout)");
    expect(result).toMatchObject({ errorCode: 7, modality: "fingerprint" });
    expect(biometricAuthResultSchema.safeParse(result).success).toBe(true);
  });

  test("a prototype runtime without the override is refused as unsupported", async () => {
    const route = new FakeRoute({ id: "vault", acceptsOverride: false });
    const error = await routePrototypeBiometric(route, device, {
      action: "error",
      errorCode: 11,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrototypeBiometricOverrideError);
    const typed = error as PrototypeBiometricOverrideError;
    expect(typed.failure).toBe("unsupported");
    expect(typed.override).toEqual({ code: "unavailable", reason: "not_enrolled" });
    expect(route.delivered).toEqual([]);
  });

  test("a refused delivery is a rejected override error", async () => {
    const route = new FakeRoute(vault, { success: false, error: "no prompt pending" });
    const error = await routePrototypeBiometric(route, device, { action: "cancel" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PrototypeBiometricOverrideError);
    expect((error as PrototypeBiometricOverrideError).failure).toBe("rejected");
    expect((error as Error).message).toContain("no prompt pending");
  });

  test("a transport failure is wrapped in an ActionableError", async () => {
    const route = new FakeRoute(vault, new Error("socket closed"));
    const error = await routePrototypeBiometric(route, device, { action: "cancel" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toBe(
      "Failed to deliver biometric cancelled to prototype vault: socket closed",
    );
  });
});
