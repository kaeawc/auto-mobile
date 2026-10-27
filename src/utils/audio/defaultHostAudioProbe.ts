import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../logger";
import { loadCoreAudioHal } from "./coreAudioHal";
import { HostAudioProbe, type HostAudioSnapshot } from "./hostAudio";

let override: HostAudioProbe | undefined;
let productionProbe: HostAudioProbe | undefined;

function createProductionProbe(): HostAudioProbe {
  if (process.platform !== "darwin") {
    // Only macOS hosts run iOS simulators; a Linux/ALSA backend is not implemented (#13626).
    return new HostAudioProbe(undefined, process.platform);
  }
  try {
    return new HostAudioProbe(loadCoreAudioHal(), process.platform);
  } catch (error) {
    logger.warn(`CoreAudio is not readable; host audio is not probed: ${errorMessage(error)}`);
    return new HostAudioProbe(undefined, process.platform, "CoreAudio could not be loaded.");
  }
}

/**
 * The daemon's host audio probe: CoreAudio on macOS, cached for the daemon's lifetime and
 * re-probed when a default device changes. Under `bun test` (NODE_ENV=test) it reports "not
 * probed" so unit tests never read the real machine's audio; tests inject a fake with
 * [setHostAudioProbeForTesting].
 */
export function hostAudioSnapshot(): HostAudioSnapshot {
  if (override) {
    return override.snapshot();
  }
  if (readEnvRaw(AMBIENT_ENV.NODE_ENV) === "test") {
    return new HostAudioProbe(
      undefined,
      process.platform,
      "Host audio is not probed in tests.",
    ).snapshot();
  }
  productionProbe ??= createProductionProbe();
  return productionProbe.snapshot();
}

/** Re-probe on demand, for example after installing a loopback driver. */
export function refreshHostAudio(): HostAudioSnapshot {
  if (override) {
    return override.refresh();
  }
  productionProbe ??= createProductionProbe();
  return productionProbe.refresh();
}

export function setHostAudioProbeForTesting(probe: HostAudioProbe | undefined): void {
  override = probe;
}
