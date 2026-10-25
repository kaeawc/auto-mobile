/**
 * Detection of the macOS software-rendering fallback in Android Emulator 37.2+
 * (https://issuetracker.google.com/issues/567150701).
 *
 * With `-gpu auto` the emulator now selects a software renderer on macOS, because the
 * deprecated host OpenGL drivers cannot provide the GLES 3.1 features newer system
 * images require. Nothing fails; the emulator just runs at roughly 10 FPS. An explicit
 * host or ANGLE GPU mode avoids the fallback.
 */

/** First emulator release reported to fall back to software rendering on macOS. */
export const MIN_SOFTWARE_FALLBACK_EMULATOR_VERSION = [37, 2] as const;

export type GpuModeSource = "avd-config" | "launch-args" | "default";

export interface EffectiveGpuMode {
  /** The mode in effect, or `"auto"` when nothing selects one. */
  mode: string;
  source: GpuModeSource;
}

export interface SoftwareRenderingRisk {
  emulatorVersion: string;
  gpu: EffectiveGpuMode;
}

/** Extract `[major, minor, patch]` from `emulator -version` output. */
export function parseEmulatorVersion(output: string): [number, number, number] | null {
  const match = /Android emulator version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function emulatorVersionFallsBackToSoftware(version: readonly number[]): boolean {
  const [minMajor, minMinor] = MIN_SOFTWARE_FALLBACK_EMULATOR_VERSION;
  const [major = 0, minor = 0] = version;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Resolve the GPU mode a launch would use. Command-line flags win over `config.ini`, and
 * `-feature GuestAngle` selects ANGLE as the GLES driver without a `-gpu` flag.
 */
export function resolveEffectiveGpuMode(
  avdGpuMode: string | undefined,
  launchArgs: readonly string[] = [],
): EffectiveGpuMode {
  const gpuFlag = launchArgs.indexOf("-gpu");
  const flagValue = gpuFlag >= 0 ? launchArgs[gpuFlag + 1] : undefined;
  if (flagValue) {
    return { mode: flagValue, source: "launch-args" };
  }
  const featureIndex = launchArgs.indexOf("-feature");
  if (featureIndex >= 0 && launchArgs[featureIndex + 1]?.split(",").includes("GuestAngle")) {
    return { mode: "angle", source: "launch-args" };
  }
  const configured = avdGpuMode?.trim();
  if (configured) {
    return { mode: configured, source: "avd-config" };
  }
  return { mode: "auto", source: "default" };
}

/**
 * Whether an AVD launched on this host would silently use software rendering. Returns null
 * when the host, emulator version, or GPU mode rules the fallback out.
 */
export function detectSoftwareRenderingFallback(input: {
  platform: NodeJS.Platform;
  emulatorVersionOutput: string;
  avdGpuMode: string | undefined;
  launchArgs?: readonly string[];
}): SoftwareRenderingRisk | null {
  if (input.platform !== "darwin") {
    return null;
  }
  const version = parseEmulatorVersion(input.emulatorVersionOutput);
  if (!version || !emulatorVersionFallsBackToSoftware(version)) {
    return null;
  }
  const gpu = resolveEffectiveGpuMode(input.avdGpuMode, input.launchArgs);
  // "auto" is the reported trigger; any explicit mode is the user's own choice.
  if (gpu.mode !== "auto") {
    return null;
  }
  return { emulatorVersion: version.join("."), gpu };
}

export const SOFTWARE_RENDERING_RECOMMENDATION =
  "Set the AVD's Graphics acceleration to Hardware in Android Studio (hw.gpu.mode=host), " +
  'or launch with AUTOMOBILE_EMULATOR_ARGS=\'["-gpu","host"]\' or \'["-feature","GuestAngle"]\'. ' +
  "Host rendering may break Google sign-in and limits snapshots; Google plans to restore it " +
  "as the default (issuetracker.google.com/issues/567150701).";

export function softwareRenderingMessage(emulatorVersion: string, avdNames: string[]): string {
  return (
    `Emulator ${emulatorVersion} on macOS falls back to software rendering with GPU mode ` +
    `"auto", which runs at roughly 10 FPS. Affected AVD(s): ${avdNames.join(", ")}`
  );
}
