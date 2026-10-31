import { describe, expect, test } from "bun:test";
import {
  AndroidCtrlProxyApkInstaller,
  type AndroidCtrlProxyApkInstallerHost,
} from "../../src/ctrlProxy/AndroidCtrlProxyApkInstaller";
import { CtrlProxyApkStageError } from "../../src/ctrlProxy/CtrlProxyApkStageError";
import { CtrlProxyApkInstallError } from "../../src/ctrlProxy/CtrlProxyApkInstallError";
import type { BootedDevice, ExecResult } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { createExecResult } from "../../src/utils/execResult";
import { wrapCommandError } from "../../src/utils/CommandError";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeAndroidInstallSettleProbe } from "../fakes/FakeAndroidInstallSettleProbe";

const emptyReason = () =>
  Object.assign(new Error("adb: failed to install control-proxy.apk: "), {
    stdout: "Performing Streamed Install\n",
    stderr: "adb: failed to install control-proxy.apk: \n",
  });

// Verbatim output captured from the freshly booted AAOS Play Store image.
const capturedEmptyReason = () =>
  Object.assign(
    new Error(
      "adb: failed to install /var/folders/cc/5cjn1v792wq3ts082kyl5j200000gn/T/auto-mobile-few54p/control-proxy.apk:",
    ),
    {
      code: 1,
      stdout: "Performing Streamed Install",
      stderr:
        "adb: failed to install /var/folders/cc/5cjn1v792wq3ts082kyl5j200000gn/T/auto-mobile-few54p/control-proxy.apk:",
    },
  );

class FakeInstallerHost implements AndroidCtrlProxyApkInstallerHost {
  readonly adb = new FakeAdbExecutor();
  readonly timer = new FakeTimer();
  readonly fileDownloader = new FakeFileDownloader();
  readonly checksumCalculator = new FakeChecksumCalculator();
  readonly device: BootedDevice = {
    name: "fresh AAOS",
    deviceId: "emulator-5554",
    platform: "android",
    formFactor: "automotive",
  };
  readonly events: string[] = [];
  outcomes: Array<Error | ExecResult> = [createExecResult("Success", "")];
  attempts = 0;
  ownershipReads = 0;
  onExecute: (() => void) | undefined;
  deviceError: Error | undefined;
  grantError: Error | undefined;
  assertPinnedVersionVerifiable(): void {}
  getApkPathOverride(): null {
    return null;
  }
  async consumePrefetchedApk(): Promise<boolean> {
    return false;
  }
  async getExpectedChecksum(): Promise<string> {
    return "";
  }
  async cleanupApk(): Promise<void> {}
  async assertNotDrivenByOtherDaemon(): Promise<void> {
    this.ownershipReads++;
  }
  clearAvailabilityCache(): void {}
  async executeApkStage(): Promise<ExecResult> {
    this.events.push("install");
    this.attempts++;
    this.onExecute?.();
    const next = this.outcomes.length > 1 ? this.outcomes.shift()! : this.outcomes[0]!;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
  async grantPostInstallPermissions(): Promise<void> {
    await this.grantLocalNetworkAfterInstall();
  }
  async grantLocalNetworkAfterInstall(): Promise<void> {
    this.events.push("grant");
    if (this.grantError) {
      throw this.grantError;
    }
  }
  statusInspectionDeviceError(): Error | undefined {
    return this.deviceError;
  }
  async getApiLevel(): Promise<[number | null, boolean]> {
    return [35, true];
  }
  async setupUser(): Promise<number | undefined> {
    return 10;
  }
}

function fixture(formFactor: BootedDevice["formFactor"] = "automotive", autoAdvance = true) {
  const host = new FakeInstallerHost();
  host.device.formFactor = formFactor;
  if (autoAdvance) {
    host.timer.enableAutoAdvance();
  }
  const probe = new FakeAndroidInstallSettleProbe(host.events);
  const installer = new AndroidCtrlProxyApkInstaller(host, {
    settleProbe: probe,
    installBackoff: sequenceBackoff([10, 20]),
  });
  return { host, probe, installer };
}

describe("CtrlProxy install settling and retries", () => {
  test.each(["automotive", "watch"] as const)(
    "%s empty-reason install retries then succeeds, settling before each install",
    async (formFactor) => {
      const { host, installer } = fixture(formFactor);
      host.outcomes = [emptyReason(), createExecResult("Success", "")];
      await installer.install("/fake/control-proxy.apk");
      expect(host.attempts).toBe(2);
      const signals =
        formFactor === "automotive"
          ? ["pm path android", "sys.boot_completed", "foreground user"]
          : ["pm path android", "sys.boot_completed"];
      expect(host.events).toEqual([...signals, "install", ...signals, "install", "grant"]);
      expect(host.timer.now()).toBe(10);
    },
  );

  test.each([
    "INSTALL_FAILED_USER_RESTRICTED",
    "INSTALL_FAILED_INSUFFICIENT_STORAGE",
    "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    "INSTALL_FAILED_VERSION_DOWNGRADE",
    "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES",
    "INSTALL_FAILED_SHARED_USER_INCOMPATIBLE",
    "INSTALL_FAILED_INVALID_APK",
    "INSTALL_FAILED_DEXOPT",
  ])("permanent %s is never retried", async (code) => {
    const { host, installer } = fixture();
    host.outcomes = [new Error(`adb: failed to install x.apk: Failure [${code}: blocked]`)];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(code);
    expect(host.attempts).toBe(1);
  });

  test.each([
    new CtrlProxyApkStageError("install timed out"),
    new CtrlProxyApkStageError("install cancelled"),
    new CtrlProxyApkInstallError("blocked", undefined),
  ])("typed terminal error %s is never retried", async (failure) => {
    const { host, installer } = fixture();
    host.outcomes = [failure];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toBe(failure);
    expect(host.attempts).toBe(1);
  });

  test("device-level errors are never retried", async () => {
    const { host, installer } = fixture();
    host.deviceError = new ActionableError("device offline");
    host.outcomes = [emptyReason()];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toBe(host.deviceError);
    expect(host.attempts).toBe(1);
  });

  test.each(["INSTALL_FAILED_INTERNAL_ERROR", "INSTALL_FAILED_NOT_READY"])(
    "transient %s is retried",
    async (code) => {
      const { host, installer } = fixture();
      host.outcomes = [new Error(`Failure [${code}]`), createExecResult("Success", "")];
      await installer.install("/fake/control-proxy.apk");
      expect(host.attempts).toBe(2);
    },
  );

  test("attempt cap reports full stdout and stderr, including output beyond excerpt limits", async () => {
    const { host, installer } = fixture();
    const failure = emptyReason();
    failure.stdout = "prefix" + "x".repeat(500) + "\nstdout end\n";
    host.outcomes = [
      wrapCommandError(failure, { command: "adb", args: ["install", "/fake/control-proxy.apk"] }),
    ];
    const pending = installer.install("/fake/control-proxy.apk");
    await expect(pending).rejects.toThrow("attempt 3/3");
    await expect(pending).rejects.toThrow("stdout:");
    await expect(pending).rejects.toThrow(failure.stdout);
    await expect(pending).rejects.toThrow("stderr:");
    await expect(pending).rejects.toThrow(failure.stderr);
    expect(host.attempts).toBe(3);
    expect(host.timer.now()).toBe(30);
  });

  test("a nonzero install result reported on stderr retries too", async () => {
    const { host, installer } = fixture();
    host.outcomes = [
      createExecResult("Performing Streamed Install", "adb: failed to install x.apk: "),
      createExecResult("Success", ""),
    ];
    await installer.install("/fake/control-proxy.apk");
    expect(host.attempts).toBe(2);
  });

  test("a retry waits for the framework to settle again before installing", async () => {
    const { host, probe, installer } = fixture("watch");
    host.outcomes = [emptyReason(), createExecResult("Success", "")];
    probe.packageReady = [true, false, true];
    await installer.install("/fake/control-proxy.apk");
    expect(host.events).toEqual([
      "pm path android",
      "sys.boot_completed",
      "install",
      "pm path android",
      "pm path android",
      "sys.boot_completed",
      "install",
      "grant",
    ]);
    expect(host.timer.now()).toBe(260);
  });

  test("an unsettled first boot fails before any install attempt", async () => {
    const { host, probe, installer } = fixture();
    probe.bootReady = [false];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(
      "sys.boot_completed",
    );
    expect(host.attempts).toBe(0);
    expect(host.timer.now()).toBe(30_000);
  });

  test("post-install permission failures never retry a successful install", async () => {
    const { host, installer } = fixture();
    host.grantError = new ActionableError("permission setup failed");
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toBe(host.grantError);
    expect(host.attempts).toBe(1);
  });

  test("default installer wires the real probe using only fake adb commands", async () => {
    const host = new FakeInstallerHost();
    host.timer.enableAutoAdvance();
    host.adb.setCommandResponse("pm path android", createExecResult("package:/framework.apk", ""));
    host.adb.setCommandResponse("getprop sys.boot_completed", createExecResult("1", ""));
    host.adb.setCommandResponse("am get-current-user", createExecResult("10", ""));
    await new AndroidCtrlProxyApkInstaller(host).install("/fake/control-proxy.apk");
    expect(host.attempts).toBe(1);
    expect(host.adb.getExecutedCommands().slice(0, 3)).toEqual([
      "shell pm path android",
      "shell getprop sys.boot_completed",
      "shell am get-current-user",
    ]);
  });

  test("phone first attempt uses only the entry ownership read", async () => {
    const { host, installer } = fixture("phone");
    await installer.install("/fake/control-proxy.apk");
    expect(host.ownershipReads).toBe(1);
    expect(host.attempts).toBe(1);
  });

  test.each(["automotive", "watch"] as const)(
    "%s retains entry and per-attempt ownership reads",
    async (formFactor) => {
      const { host, installer } = fixture(formFactor);
      host.outcomes = [emptyReason(), createExecResult("Success", "")];
      await installer.install("/fake/control-proxy.apk");
      expect(host.ownershipReads).toBe(3);
    },
  );

  test.each([1, 2])(
    "phone preserves stage errors on attempt %s when the signal aborts",
    async (attempt) => {
      const { host, installer } = fixture("phone");
      const controller = new AbortController();
      const reason = new Error("acquisition deadline reached");
      const failure = new CtrlProxyApkStageError(
        "CtrlProxy APK install cancelled: acquisition deadline reached",
        { cause: reason },
      );
      host.outcomes = attempt === 1 ? [failure] : [capturedEmptyReason(), failure];
      host.onExecute = () => {
        if (host.attempts === attempt) {
          controller.abort(reason);
        }
      };
      await expect(
        runWithAbortSignal(controller.signal, () => installer.install("/fake/control-proxy.apk")),
      ).rejects.toBe(failure);
      expect(host.attempts).toBe(attempt);
      expect(host.ownershipReads).toBe(attempt);
    },
  );

  test.each([
    new CtrlProxyApkStageError("CtrlProxy APK install timed out"),
    new CtrlProxyApkStageError("CtrlProxy APK install cancelled"),
    new ActionableError("request aborted"),
  ])("phone preserves terminal error identity: %s", async (failure) => {
    const { host, installer } = fixture("phone");
    host.outcomes = [failure];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toBe(failure);
    expect(host.attempts).toBe(1);
  });

  test("phone keeps the original wrapping for a non-empty install failure", async () => {
    const { host, installer } = fixture("phone");
    const failure = new Error("Failure [INSTALL_FAILED_INTERNAL_ERROR]");
    host.outcomes = [failure];
    const pending = installer.install("/fake/control-proxy.apk");
    await expect(pending).rejects.toMatchObject({
      message: "Failed to install APK: Failure [INSTALL_FAILED_INTERNAL_ERROR]",
      cause: failure,
    });
    expect(host.attempts).toBe(1);
  });

  test("phone retries the captured empty streamed-install failure without probing", async () => {
    const { host, probe, installer } = fixture("phone");
    host.outcomes = [capturedEmptyReason(), createExecResult("Success", "")];
    await installer.install("/fake/control-proxy.apk");
    expect(host.attempts).toBe(2);
    expect(probe.calls).toEqual([]);
    expect(host.adb.getExecutedCommands()).toEqual([]);
    expect(host.timer.now()).toBe(10);
    expect(host.ownershipReads).toBe(2);
  });

  test("a missing booted form factor still retries the captured failure", async () => {
    const { host, probe, installer } = fixture("phone");
    host.device.formFactor = undefined;
    host.outcomes = [capturedEmptyReason(), createExecResult("Success", "")];
    await installer.install("/fake/control-proxy.apk");
    expect(host.attempts).toBe(2);
    expect(probe.calls).toEqual([]);
  });

  test("phone exhausts the bounded attempts with raw streams and exit code", async () => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    host.outcomes = [failure];
    const pending = installer.install("/fake/control-proxy.apk");
    await expect(pending).rejects.toThrow("Failed to install APK");
    await expect(pending).rejects.toThrow("attempt 3/3");
    await expect(pending).rejects.toThrow("exit code: 1");
    await expect(pending).rejects.toThrow(failure.stdout);
    await expect(pending).rejects.toThrow(failure.stderr);
    expect(host.attempts).toBe(3);
    expect(host.timer.now()).toBe(30);
  });

  test.each([
    "Failure [INSTALL_FAILED_INVALID_APK: blocked]",
    "Failure [unknown reason]",
    "device still authorizing",
    "device offline",
    "adb: error: closed",
    "adb: protocol fault (couldn't read status)",
  ])("phone does not retry an install with a reason: %s", async (reason) => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    failure.message += `\n${reason}`;
    host.outcomes = [failure];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(reason);
    expect(host.attempts).toBe(1);
  });

  test("phone retries wrapped command errors without losing their raw streams", async () => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    host.outcomes = [wrapCommandError(failure, { command: "adb", args: ["install"] })];
    const pending = installer.install("/fake/control-proxy.apk");
    await expect(pending).rejects.toThrow("attempt 3/3");
    await expect(pending).rejects.toThrow("exit code: 1");
    await expect(pending).rejects.toThrow(failure.stdout);
    await expect(pending).rejects.toThrow(failure.stderr);
    expect(host.attempts).toBe(3);
  });

  test("phone does not retry transport diagnostics inside a wrapped command error", async () => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    failure.message = "adb: error: closed";
    host.outcomes = [wrapCommandError(failure, { command: "adb", args: ["install"] })];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(
      "adb: error: closed",
    );
    expect(host.attempts).toBe(1);
  });

  test.each([
    "Failure [INSTALL_FAILED_INVALID_APK: blocked]",
    "device still authorizing",
    "device offline",
    "adb: error: closed",
    "unrelated error:",
  ])("phone does not retry additional stderr: %s", async (reason) => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    failure.stderr += `\n${reason}`;
    host.outcomes = [failure];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(
      "Failed to install APK",
    );
    expect(host.attempts).toBe(1);
  });

  test("phone does not retry a header-only failure without the streamed-install marker", async () => {
    const { host, installer } = fixture("phone");
    const failure = capturedEmptyReason();
    failure.stdout = "";
    host.outcomes = [failure];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toThrow(
      "Failed to install APK",
    );
    expect(host.attempts).toBe(1);
  });

  test("phone preserves the status-inspection device error without retrying", async () => {
    const { host, installer } = fixture("phone");
    host.deviceError = new ActionableError("device offline");
    host.outcomes = [capturedEmptyReason()];
    await expect(installer.install("/fake/control-proxy.apk")).rejects.toBe(host.deviceError);
    expect(host.attempts).toBe(1);
  });

  test("phone cancellation during backoff prevents a second install", async () => {
    const { host, probe, installer } = fixture("phone", false);
    host.outcomes = [capturedEmptyReason()];
    const controller = new AbortController();
    const pending = runWithAbortSignal(controller.signal, () =>
      installer.install("/fake/control-proxy.apk"),
    );
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
    }
    expect(host.attempts).toBe(1);
    controller.abort(new Error("phase deadline reached"));
    await expect(pending).rejects.toThrow("phase deadline reached");
    host.timer.advanceTime(60_000);
    expect(host.attempts).toBe(1);
    expect(probe.calls).toEqual([]);
    expect(host.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("abort during retry delay prevents another gate or install", async () => {
    const { host, probe, installer } = fixture("automotive", false);
    host.outcomes = [emptyReason()];
    const controller = new AbortController();
    const pending = runWithAbortSignal(controller.signal, () =>
      installer.install("/fake/control-proxy.apk"),
    );
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
    }
    expect(host.attempts).toBe(1);
    const probes = probe.calls.length;
    controller.abort();
    await expect(pending).rejects.toThrow(/abort|cancel/i);
    host.timer.advanceTime(60_000);
    expect(host.attempts).toBe(1);
    expect(probe.calls).toHaveLength(probes);
    expect(host.timer.getPendingTimeoutCount()).toBe(0);
  });
});
