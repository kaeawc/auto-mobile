import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../../src/models";
import type { ExecResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import {
  createLockScreenFaultInjector,
  LOCK_SCREEN_FAULT_KEY,
  LOCK_SCREEN_TEST_PIN,
  resolveLockScreenFaultInjector,
} from "../../../src/features/deviceCondition/lockScreenFaultInjectors";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";

class LockDevice extends FakeAdbExecutor {
  credential: string | undefined;
  failSet = false;
  throwRawNoCredentialVerify = false;

  override async execute(args: string[]): Promise<ExecResult> {
    const command = args.join(" ");
    let stdout = "";
    if (command.endsWith("get-disabled")) {
      stdout = this.credential ? "false" : "true";
    } else if (command.endsWith(`verify --old ${LOCK_SCREEN_TEST_PIN}`)) {
      if (this.credential === LOCK_SCREEN_TEST_PIN) {
        stdout = "Lock credential verified successfully";
      } else {
        if (!this.credential && this.throwRawNoCredentialVerify) {
          throw new Error(
            `Command failed: ... cmd lock_settings verify --old ${LOCK_SCREEN_TEST_PIN}\nexit code: 255`,
          );
        }
        stdout = this.credential
          ? `Old password '${LOCK_SCREEN_TEST_PIN}' didn't match`
          : "Old password provided but user has no password";
        return this.result(
          stdout,
          `Command failed: adb shell ${command}\nexit code: 255\nstdout: ${stdout}`,
        );
      }
    } else if (command.endsWith(`set-pin ${LOCK_SCREEN_TEST_PIN}`)) {
      this.credential = LOCK_SCREEN_TEST_PIN;
      if (this.failSet) {
        return this.result("", "set failed");
      }
      stdout = `Pin set to '${LOCK_SCREEN_TEST_PIN}'`;
    } else if (command.endsWith(`clear --old ${LOCK_SCREEN_TEST_PIN}`)) {
      this.credential = undefined;
      stdout = "Lock credential cleared";
    }
    return this.result(stdout);
  }

  private result(stdout: string, error = ""): ExecResult {
    return {
      stdout,
      stderr: "",
      error: error || undefined,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (s) => stdout.includes(s),
    };
  }
}

const pin = (adb: LockDevice) => createLockScreenFaultInjector(adb);

describe("faults.lockScreen", () => {
  test("sets the PIN from none and reset clears it", async () => {
    const adb = new LockDevice();
    const outcome = await pin(adb).apply("pin");
    expect(adb.credential).toBe(LOCK_SCREEN_TEST_PIN);
    await outcome.reset?.();
    expect(adb.credential).toBeUndefined();
  });
  test("an owned PIN is unchanged and reset is idempotent", async () => {
    const adb = new LockDevice();
    const injector = pin(adb);
    const first = await injector.apply("pin");
    const second = await injector.apply("pin");
    expect(second.status).toBe("unchanged");
    await first.reset?.();
    const commands = adb.getExecutedCommands();
    await first.reset?.();
    expect(adb.getExecutedCommands()).toEqual(commands);
  });
  test("rejects unknown credentials", async () => {
    const adb = new LockDevice();
    adb.credential = "other";
    await expect(pin(adb).apply("pin")).rejects.toThrow("credential AutoMobile does not know");
  });
  test("treats a wrong-PIN verify as no owned PIN", async () => {
    const adb = new LockDevice();
    adb.credential = "other";
    await expect(pin(adb).apply("pin")).rejects.toThrow("credential AutoMobile does not know");
  });
  test("none clears owned PIN without a reset and is unchanged when already clear", async () => {
    const adb = new LockDevice();
    const injector = pin(adb);
    await injector.apply("pin");
    expect((await injector.apply("none")).reset).toBeUndefined();
    expect(adb.credential).toBeUndefined();
    expect((await injector.apply("none")).status).toBe("unchanged");
  });
  test("none is unchanged when raw adb verify reports no credential", async () => {
    const adb = new LockDevice();
    adb.throwRawNoCredentialVerify = true;
    expect((await pin(adb).apply("none")).status).toBe("unchanged");
  });
  test("failed set retains ownership for cleanup", async () => {
    const adb = new LockDevice();
    adb.failSet = true;
    const injector = pin(adb);
    let owed: OwedResetError | undefined;
    try {
      await injector.apply("pin");
    } catch (error) {
      if (error instanceof OwedResetError) {
        owed = error;
      }
    }
    expect(owed).toBeDefined();
    await owed?.owedReset();
    expect(adb.credential).toBeUndefined();
    expect(await injector.isClean()).toBe(true);
  });
  test("resolver is Android-only, key-specific, and cached by device", () => {
    const device = { deviceId: "emulator-1", platform: "android" } as BootedDevice;
    const other = { deviceId: "ios-1", platform: "ios" } as BootedDevice;
    const adb = new LockDevice();
    const adbFactory: AdbClientFactory = { create: () => adb };
    const deps = { adbFactory, cache: new Map() };
    const resolved = resolveLockScreenFaultInjector(device, LOCK_SCREEN_FAULT_KEY, deps);
    expect(resolved).toBeDefined();
    expect(resolveLockScreenFaultInjector(device, LOCK_SCREEN_FAULT_KEY, deps)).toBe(resolved);
    expect(resolveLockScreenFaultInjector(device, "faults.storage", deps)).toBeUndefined();
    expect(resolveLockScreenFaultInjector(other, LOCK_SCREEN_FAULT_KEY, deps)).toBeUndefined();
  });
  test("schema accepts supported values only", () => {
    for (const value of ["pin", "none", "unset"]) {
      expect(deviceConditionInputSchema.safeParse({ faults: { lockScreen: value } }).success).toBe(
        true,
      );
    }
    expect(
      deviceConditionInputSchema.safeParse({ faults: { lockScreen: "password" } }).success,
    ).toBe(false);
  });
});
