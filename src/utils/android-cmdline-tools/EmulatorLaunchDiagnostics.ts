import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { trackAmbient } from "../PerfContext";
import type { Timer } from "../SystemTimer";
import { ActionableError, type ExecResult } from "../../models";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { boundedEmulatorOutputTail, type LaunchFailureCategory } from "./EmulatorLauncher";
import type { EarlyExitStatus } from "./EmulatorLaunchSupport";
import {
  detectArchitecturePanic,
  detectCorruptImage,
  detectDisplayError,
  detectSandboxMprotect,
} from "./emulatorLaunchFailure";
import { redactAndroidCommandOutput } from "./redactAndroidCommandOutput";

export const ACCEL_CHECK_TIMEOUT_MS = 3_000;

export interface ArchitectureCompatibilityResult {
  compatible: boolean;
  hostArch: string;
  avdArch?: string;
  reason?: string;
}

function outputFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
}

function withSuggestion(prefix: string, message?: string, suggestion?: string): ActionableError {
  let msg = `${prefix}${message}`;
  if (suggestion) {
    msg += `\n\nSuggestion: ${suggestion}`;
  }
  return new ActionableError(msg);
}

/** Sandbox/JIT entitlement failure (mprotect) as an actionable error, or null. */
export function sandboxFailure(output: string): ActionableError | null {
  const result = detectSandboxMprotect(output);
  if (!result.isSandboxError) {
    return null;
  }
  return new ActionableError(
    [
      `Emulator failed to start: ${result.message}`,
      result.suggestion ? `Suggestion: ${result.suggestion}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

/** Classify output of an emulator that exited into a known actionable failure, or null. */
export function classifyEmulatorExitOutput(combinedOutput: string): ActionableError | null {
  const sandboxError = sandboxFailure(combinedOutput);
  const corruptResult = detectCorruptImage(combinedOutput);
  const displayResult = detectDisplayError(combinedOutput);
  if (sandboxError) {
    return sandboxError;
  }
  if (corruptResult.isCorrupt) {
    return withSuggestion(
      "Emulator failed to start: ",
      corruptResult.message,
      corruptResult.suggestion,
    );
  }
  if (displayResult.isDisplayError) {
    return withSuggestion(
      "Emulator failed to start: ",
      displayResult.message,
      displayResult.suggestion,
    );
  }
  const panicResult = detectArchitecturePanic(combinedOutput);
  return panicResult.isPanic
    ? new ActionableError(`Emulator failed to start: ${panicResult.message}`)
    : null;
}

export function appendCategory(error: ActionableError, category: LaunchFailureCategory) {
  return new ActionableError(`${error.message}\n\ncategory=${category}`);
}

export function formatEarlyExitError(
  avdName: string,
  { code, signal, category }: EarlyExitStatus,
  output: string,
  accelCheckOutput: string,
): ActionableError {
  const header = [
    `Emulator process exited with code: ${code}${signal ? ` (signal: ${signal})` : ""} (AVD '${avdName}'`,
    category ? `; category=${category}` : "",
    ")",
  ].join("");
  const sections = [
    header,
    output.trim() ? `Diagnostic:\n${output.trim()}` : "",
    accelCheckOutput.trim() ? `emulator -accel-check:\n${accelCheckOutput.trim()}` : "",
  ].filter(Boolean);
  return new ActionableError(sections.join("\n"));
}

/** ARM64 hosts (Apple Silicon) cannot run x86/x86_64 AVDs; everything else may be attempted. */
export function isArchitectureCompatible(hostArch: string, avdArch: string): boolean {
  return !(
    (hostArch === "arm64" || hostArch === "aarch64") &&
    (avdArch === "x86" || avdArch === "x86_64")
  );
}

function diagnosticOutputFromError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const output = error as { stdout?: unknown; stderr?: unknown };
  return boundedEmulatorOutputTail(
    redactAndroidCommandOutput(
      [outputFromUnknown(output.stdout), outputFromUnknown(output.stderr)]
        .filter(Boolean)
        .join("\n"),
    ),
  );
}

/** Members resolved through the client at call time (the other extracted units' convention). */
export interface EmulatorLaunchDiagnosticsHost {
  timer(): Timer;
  emulatorPath(): string;
  hostArchitecture(): string;
  avdConfigReader(): AvdConfigReader;
  execAsync(file: string, args: string[], signal?: AbortSignal): Promise<ExecResult>;
}

/** Diagnostic probes run around an emulator launch: `-accel-check` and host/AVD architecture. */
export interface EmulatorLaunchDiagnostics {
  runAccelerationCheck(): Promise<string>;
  checkArchitectureCompatibility(
    avdName: string,
    avdConfig?: AvdConfig | null,
  ): Promise<ArchitectureCompatibilityResult>;
}

export class DefaultEmulatorLaunchDiagnostics implements EmulatorLaunchDiagnostics {
  constructor(private readonly host: EmulatorLaunchDiagnosticsHost) {}

  runAccelerationCheck(): Promise<string> {
    // Diagnostic `emulator -accel-check` probe (up to a 3s bound) run on an
    // inconclusive cold-boot failure. It bypasses the executeCommand funnel, so
    // give it its own ambient leaf — wrapped around the whole method, outside
    // its internal Promise.race, so the added async turn can't perturb the
    // race's FakeTimer timing (see PerfContext).
    return trackAmbient("emulator -accel-check", () => this.runAccelerationCheckInner());
  }

  private async runAccelerationCheckInner(): Promise<string> {
    const controller = new AbortController();
    const probe = Promise.resolve()
      .then(() =>
        this.host.execAsync(this.host.emulatorPath(), ["-accel-check"], controller.signal),
      )
      .then(
        (result) =>
          boundedEmulatorOutputTail(
            redactAndroidCommandOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
          ),
        (error) => diagnosticOutputFromError(error),
      );
    const timedOut = Symbol("emulator acceleration timeout");
    try {
      return await raceWithDeadline(probe, {
        timer: this.host.timer(),
        timeoutMs: ACCEL_CHECK_TIMEOUT_MS,
        label: "Emulator acceleration check",
        timeoutError: () => {
          controller.abort();
          return timedOut;
        },
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.debug(`Emulator acceleration check timed out after ${ACCEL_CHECK_TIMEOUT_MS}ms`);
      return "";
    }
  }

  async checkArchitectureCompatibility(
    avdName: string,
    avdConfig?: AvdConfig | null,
  ): Promise<ArchitectureCompatibilityResult> {
    const hostArch = this.host.hostArchitecture();
    try {
      const config =
        avdConfig === undefined ? await this.host.avdConfigReader().readConfig(avdName) : avdConfig;
      const avdArch = config?.architecture;
      if (!avdArch) {
        // Missing config metadata is non-fatal; the launch attempt provides definitive diagnostics.
        return {
          compatible: true,
          hostArch,
          reason: "Could not determine AVD architecture, allowing attempt",
        };
      }
      const compatible = isArchitectureCompatible(hostArch, avdArch);
      const reason = compatible
        ? undefined
        : `Host architecture '${hostArch}' cannot run AVD with architecture '${avdArch}'`;
      return { compatible, hostArch, avdArch, reason };
    } catch (error) {
      // If we can't check, we'll let the emulator start attempt proceed and catch errors there
      logger.debug(
        `Could not check architecture compatibility for ${avdName}: ${errorMessage(error)}`,
      );
      return {
        compatible: true,
        hostArch,
        reason: "Could not verify compatibility, allowing attempt",
      };
    }
  }
}
