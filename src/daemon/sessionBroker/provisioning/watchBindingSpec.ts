import { z } from "zod/v4";
import type { ResolvedExactDeviceSpecification } from "../../../devices/exactDeviceProvisioning";
import { ActionableError } from "../../../models/ActionableError";
import type { DeviceInfo } from "../../../models/index";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { WatchSimulatorInventory } from "../../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { assertWatchSpecInCatalog } from "../../../utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import { logger } from "../../../utils/logger";
import {
  watchBindingSpecSchema,
  type WatchBindingSpec,
} from "../../../utils/provisionDeviceSpecSchemas";

/**
 * Broker watch bindings' spec handling (#15882): an Apple Watch simulator is matched, resolved and
 * created by its exact watchOS runtime and Apple Watch device type only. It is never read as an
 * iOS spec: no "any model" default, no form-factor inference and no display cutout apply.
 */

/** The host's watch catalog (installed watchOS runtimes and Apple Watch device types). */
export type WatchBindingCatalog = Pick<WatchSimulatorInventory, "readCatalog">;

/** `unknown` means the watch's configuration could not be read; it never justifies deletion. */
export type WatchSpecMatch = "match" | "mismatch" | "unknown";

/** A watch matches when its runtime and device type both equal the requested ones. */
export function matchesWatchSimulator(
  device: DeviceInfo,
  spec: { runtime: string; deviceType?: string },
): WatchSpecMatch {
  // An unavailable watch (runtime unmounted, another Xcode) proves nothing about its
  // configuration, and a spec without a device type is not a watch spec: neither is a mismatch.
  if (
    device.isAvailable === false ||
    device.runtime === undefined ||
    device.deviceType === undefined ||
    spec.deviceType === undefined
  ) {
    return "unknown";
  }
  return device.runtime === spec.runtime && device.deviceType === spec.deviceType
    ? "match"
    : "mismatch";
}

export type WatchSpecResolution =
  | { kind: "resolved"; resolvedSpec: ResolvedExactDeviceSpecification }
  | { kind: "unsupported"; code: "spec_unsupported" | "runtime_incompatible"; message: string }
  | { kind: "unresolved"; message: string };

/**
 * Validate a requested watch spec against the host's watch catalog before anything is created:
 * a runtime or device type the catalog does not list is `spec_unsupported`, naming the listed
 * ones; a listed but unavailable runtime is `runtime_incompatible`, as for iOS. No catalog (not
 * macOS) cannot host a watch at all; an unreadable catalog is retryable `unresolved`.
 */
export async function resolveWatchBindingSpec(
  catalog: WatchBindingCatalog | undefined,
  requested: unknown,
  signal?: AbortSignal,
): Promise<WatchSpecResolution> {
  const parsed = watchBindingSpecSchema.safeParse(requested);
  if (!parsed.success) {
    return {
      kind: "unsupported",
      code: "spec_unsupported",
      message: `A watchOS binding spec names exactly runtime and deviceType: ${z.prettifyError(parsed.error)}`,
    };
  }
  if (!catalog) {
    return {
      kind: "unsupported",
      code: "spec_unsupported",
      message: "Apple Watch simulators exist only on macOS hosts with Xcode's simctl.",
    };
  }
  let listed: Awaited<ReturnType<WatchBindingCatalog["readCatalog"]>>;
  try {
    listed = await catalog.readCatalog(signal);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[Bindings] watch catalog unreadable: ${errorMessage(error)}`, error);
    return {
      kind: "unresolved",
      message: `The Apple Watch simulator catalog could not be read: ${errorMessage(error)}`,
    };
  }
  const spec: WatchBindingSpec = parsed.data;
  try {
    assertWatchSpecInCatalog(spec, listed);
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    const runtime = listed.runtimes.find((entry) => entry.identifier === spec.runtime);
    const typeListed = listed.deviceTypes.some((entry) => entry.identifier === spec.deviceType);
    return {
      kind: "unsupported",
      code:
        typeListed && runtime && !runtime.isAvailable ? "runtime_incompatible" : "spec_unsupported",
      message: error.message,
    };
  }
  return {
    kind: "resolved",
    // A watch has no cutout classification; provisionDevice reports the same.
    resolvedSpec: { runtime: spec.runtime, deviceType: spec.deviceType, displayCutout: "unknown" },
  };
}
