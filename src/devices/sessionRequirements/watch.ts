import { z } from "zod/v4";
import { watchProvisionDeviceSpecSchema } from "../../utils/provisionDeviceSpecSchemas";
import { failure, success } from "./result";
import type {
  DevicePredicateMatch,
  NormalizedWatchSessionDeviceRequirement,
  RequirementResult,
  SessionDeviceProfile,
  WatchSessionDeviceCatalog,
  WatchSessionDeviceRequirement,
} from "./types";

/**
 * Apple Watch session requests (#15882). A watch request names one exact configuration,
 * provisionDevice's watch spec (`spec.runtime` + `spec.deviceType`): there is no host default,
 * archetype or OS predicate to apply, so normalization validates it against the installed watch
 * catalog and the result is already the exact creation profile.
 */

/** Parses the watch branch of a session device requirement; `schemaVersion` is checked by the caller. */
export function parseWatchSessionDeviceRequirement(
  value: Record<string, unknown>,
): RequirementResult<WatchSessionDeviceRequirement> {
  // provisionDevice's own watch spec schema: the same two exact identifiers, nothing else.
  const spec = watchProvisionDeviceSpecSchema.safeParse(value.spec);
  if (!spec.success) {
    return failure(
      "invalid_request",
      `spec must name exactly a watchOS runtime and an Apple Watch deviceType: ${z.prettifyError(spec.error)}`,
      { field: "spec" },
    );
  }
  return success({ schemaVersion: 1, platform: "watchos", spec: spec.data });
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none installed";
}

/**
 * Validates an exact watch request against the installed watch catalog before any pool or native
 * work. A device type or runtime the catalog does not list, or a listed runtime that is not
 * available, is refused naming the available ones. A host with no watch catalog (not macOS) is a
 * permanent `unsupported_hardware`; an unreadable catalog is transient `catalog_unavailable`.
 */
export function normalizeWatchSessionDeviceRequirement(
  request: WatchSessionDeviceRequirement,
  catalog: WatchSessionDeviceCatalog,
): RequirementResult<NormalizedWatchSessionDeviceRequirement> {
  if (catalog.platform !== "watchos") {
    return failure("invalid_config", "Requirement and catalog must both target watchos.");
  }
  if (catalog.provenance.state === "not-installed") {
    return failure(
      "unsupported_hardware",
      catalog.provenance.message ??
        "Apple Watch simulators exist only on macOS hosts with Xcode's simctl.",
      { field: "platform" },
    );
  }
  if (catalog.provenance.state !== "ready") {
    return failure(
      "catalog_unavailable",
      catalog.provenance.message ?? "The Apple Watch simulator catalog is unavailable.",
      { transient: true },
    );
  }
  const { runtime, deviceType } = request.spec;
  if (!catalog.deviceTypes.some((entry) => entry.deviceType === deviceType)) {
    return failure(
      "unsupported_hardware",
      `Unknown Apple Watch device type '${deviceType}'. Available: ` +
        listOrNone(catalog.deviceTypes.map((entry) => entry.deviceType)),
      { field: "spec.deviceType" },
    );
  }
  const installed = catalog.runtimes.filter((entry) => entry.installed);
  if (!installed.some((entry) => entry.runtime === runtime)) {
    const listed = catalog.runtimes.some((entry) => entry.runtime === runtime);
    return failure(
      "missing_installed_runtime",
      `${listed ? "Unavailable" : "Unknown"} watchOS runtime '${runtime}'. Available: ` +
        listOrNone(installed.map((entry) => entry.runtime)),
      { field: "spec.runtime" },
    );
  }
  return success({
    platform: "watchos",
    original: request,
    profile: { platform: "watchos", metadataState: "current", runtime, deviceType },
    catalogSource: catalog.provenance.source,
    catalogRevision: catalog.provenance.revision,
  });
}

/** A pooled watch serves a watch request only with the same runtime and device type. */
export function matchWatchSessionDevice(
  requirement: NormalizedWatchSessionDeviceRequirement,
  candidate: SessionDeviceProfile,
): DevicePredicateMatch {
  if (candidate.platform !== "watchos") {
    return { kind: "mismatch", reason: "platform" };
  }
  if (candidate.metadataState !== "current") {
    return { kind: "mismatch", reason: "stale-metadata" };
  }
  if (candidate.deviceType !== requirement.profile.deviceType) {
    return { kind: "mismatch", reason: "hardware" };
  }
  return candidate.runtime === requirement.profile.runtime
    ? { kind: "match" }
    : { kind: "mismatch", reason: "os" };
}
