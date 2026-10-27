import { ActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ensureAndroidRoot } from "../../utils/android-cmdline-tools/ensureAndroidRoot";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import type { DeviceClockAdapter } from "./DeviceClock";

/** All clock device command strings are owned by this adapter. */
export class AndroidDeviceClockAdapter implements DeviceClockAdapter {
  constructor(
    private readonly adb: AdbCommandRunner,
    private readonly signal?: AbortSignal,
  ) {}
  async canRoot(): Promise<boolean> {
    const id = await this.command("shell id");
    return (
      id.includes("uid=0(root)") || (await this.command("shell getprop ro.debuggable")) === "1"
    );
  }
  async ensureRoot(): Promise<
    { success: true; rootedByUs: boolean } | { success: false; error: string }
  > {
    const before = await this.command("shell id");
    if (before.includes("uid=0(root)")) {
      return { success: true, rootedByUs: false };
    }
    if ((await this.command("shell getprop ro.debuggable")) !== "1") {
      return {
        success: false,
        error: "Non-debuggable/Play Store emulator does not allow root ADB.",
      };
    }
    const result = await ensureAndroidRoot(this.adb, this.signal);
    return result.success ? { success: true, rootedByUs: true } : result;
  }
  async unroot(): Promise<void> {
    // `adb unroot` restarts adbd, so the transport can drop mid-command and report an error
    // although adbd came back unrooted. Wait for the device and judge by the read-back (#10771).
    let unrootError: unknown;
    try {
      await this.command("unroot");
    } catch (error) {
      this.signal?.throwIfAborted();
      unrootError = error;
    }
    await this.command("wait-for-device", 60_000);
    if (unrootError === undefined) {
      return;
    }
    if ((await this.command("shell id")).includes("uid=0(root)")) {
      throw unrootError;
    }
  }
  private async command(command: string, timeoutMs = 30_000): Promise<string> {
    this.signal?.throwIfAborted();
    const result = await this.adb.executeCommand(command, {
      timeoutMs,
      noRetry: true,
      signal: this.signal,
    });
    this.signal?.throwIfAborted();
    if (
      result.error ||
      result.stderr.trim() ||
      outputLooksLikeShellFailure(result.stdout, result.stderr)
    ) {
      throw new ActionableError(`Device clock command failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }
  async readInstantMs(): Promise<number> {
    const value = await this.command("shell date +%s");
    const milliseconds = Number(value) * 1000;
    if (
      !/^-?\d+$/.test(value) ||
      !Number.isSafeInteger(milliseconds) ||
      !Number.isFinite(new Date(milliseconds).getTime())
    ) {
      throw new ActionableError(
        "Device date +%s did not return a valid epoch second. Check device shell support.",
      );
    }
    return milliseconds;
  }
  async readAutomaticTime(): Promise<0 | 1> {
    const value = await this.command("shell settings get global auto_time");
    if (value !== "0" && value !== "1") {
      throw new ActionableError("Device auto_time must report 0 or 1 before changing its clock.");
    }
    return value === "1" ? 1 : 0;
  }
  async setAutomaticTime(value: 0 | 1): Promise<void> {
    await this.command(`shell settings put global auto_time ${value}`);
  }
  async setInstantMs(instantMs: number): Promise<void> {
    await this.command(`shell date -u @${Math.floor(instantMs / 1000)}`);
  }
}
