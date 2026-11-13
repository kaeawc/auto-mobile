import { validateContext } from "./catalog";
import { normalizeSessionDeviceRequirement } from "./normalization";
import { parseSessionDeviceRequirement } from "./parsing";
import { resolveSessionDeviceProfile } from "./resolution";
import { failure, success } from "./result";
import type {
  DefaultedSessionDeviceRequirement,
  EffectiveOsSelector,
  NormalizedSessionDeviceRequirement,
  RequirementResult,
  ResolvedSessionDeviceProfile,
  SessionDeviceCatalog,
  SessionRequirementDefaults,
  SessionRequirementError,
} from "./types";

/** Where the OS a requirement resolves to came from (#18180). */
export type ResolvedOsSource = "request" | "device-type-default" | "platform-default";

/** An installed runtime (iOS runtime id) or system image (Android package) and its OS version. */
export interface CapabilityRuntime {
  runtime: string;
  osVersion: string;
}

export interface CapabilityResolvedOs {
  source: ResolvedOsSource;
  /** The effective OS predicate after defaults were applied. */
  selector: EffectiveOsSelector;
  /** Present when the requirement is satisfiable: the release acquisition would create on. */
  osVersion?: string;
  runtime?: string;
}

/**
 * What a session requirement would resolve to on this host, computed by the same
 * normalization and resolution acquisition runs, without acquiring anything (#18180).
 */
export interface SessionRequirementCapability {
  platform: "ios" | "android";
  policyVersion: string;
  catalog: { source: string; revision: string };
  /** Absent only when the requirement could not be normalized (for example unknown hardware). */
  resolvedOs?: CapabilityResolvedOs;
  satisfiable: boolean;
  /** Why the requirement is not satisfiable now; the code acquisition would refuse with. */
  reason?: SessionRequirementError;
  /** Installed releases that can serve this hardware selector when named exactly. */
  installedRuntimes: CapabilityRuntime[];
  /** The same hardware with the OS omitted resolves on this host ("default-capable"). */
  defaultOsSatisfiable: boolean;
  /** Some installed release can serve the hardware ("device-type-capable"). */
  anyOsSatisfiable: boolean;
}

function resolve(
  request: DefaultedSessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): {
  normalized: RequirementResult<NormalizedSessionDeviceRequirement>;
  resolved: RequirementResult<ResolvedSessionDeviceProfile>;
} {
  const normalized = normalizeSessionDeviceRequirement(request, defaults, catalog);
  return {
    normalized,
    resolved: normalized.ok
      ? resolveSessionDeviceProfile(normalized.value, defaults, catalog)
      : normalized,
  };
}

function resolvedRuntime(profile: ResolvedSessionDeviceProfile): CapabilityRuntime {
  return profile.platform === "ios"
    ? { runtime: profile.profile.runtimeId, osVersion: profile.profile.osVersion }
    : { runtime: profile.profile.systemImagePackage, osVersion: profile.profile.osVersion };
}

function osSource(requirement: NormalizedSessionDeviceRequirement): ResolvedOsSource {
  if (requirement.original.os.kind !== "omitted") {
    return "request";
  }
  return requirement.provenance.osDefaultArchetype === undefined
    ? "platform-default"
    : "device-type-default";
}

function installedVersions(catalog: SessionDeviceCatalog): string[] {
  if (catalog.platform === "watchos") {
    return [];
  }
  const releases: readonly { installed: boolean; osVersion?: string }[] = catalog.releases;
  return [
    ...new Set(
      releases.flatMap((release) =>
        release.installed && release.osVersion !== undefined ? [release.osVersion] : [],
      ),
    ),
  ];
}

/** Each installed release named exactly, through the real resolution: the ones that resolve. */
function servingRuntimes(
  request: DefaultedSessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): CapabilityRuntime[] {
  return installedVersions(catalog).flatMap((version) => {
    const { resolved } = resolve({ ...request, os: { kind: "exact", version } }, defaults, catalog);
    return resolved.ok ? [resolvedRuntime(resolved.value)] : [];
  });
}

/** A watch request is exact: there is no OS default to resolve, so the query refuses it. */
export function watchRequirementCapabilityRefusal(): RequirementResult<never> {
  return failure(
    "invalid_request",
    "A watchOS requirement names its exact runtime and device type; it has no OS default to resolve.",
    { field: "platform" },
  );
}

/**
 * Read-only capability answer for a session requirement (#18180). Fails (instead of answering)
 * when the request is malformed or the host cannot answer: no defaults for the platform, or a
 * catalog that is not ready (`catalog_unavailable`, as when the host has no iOS tooling).
 */
export function querySessionRequirementCapability(
  input: unknown,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): RequirementResult<SessionRequirementCapability> {
  const parsed = parseSessionDeviceRequirement(input);
  if (!parsed.ok) {
    return parsed;
  }
  const request = parsed.value;
  if (request.platform === "watchos") {
    return watchRequirementCapabilityRefusal();
  }
  const context = validateContext(request.platform, defaults, catalog);
  if (!context.ok) {
    return context;
  }
  const { normalized, resolved } = resolve(request, defaults, catalog);
  const installedRuntimes = servingRuntimes(request, defaults, catalog);
  const defaultOsSatisfiable =
    request.os.kind === "omitted"
      ? resolved.ok
      : resolve({ ...request, os: { kind: "omitted" } }, defaults, catalog).resolved.ok;
  return success({
    platform: request.platform,
    policyVersion: defaults.policyVersion,
    catalog: { source: catalog.provenance.source, revision: catalog.provenance.revision },
    ...(normalized.ok
      ? {
          resolvedOs: {
            source: osSource(normalized.value),
            selector: normalized.value.effective.os,
            ...(resolved.ok ? resolvedRuntime(resolved.value) : {}),
          },
        }
      : {}),
    satisfiable: resolved.ok,
    ...(resolved.ok ? {} : { reason: resolved.error }),
    installedRuntimes,
    defaultOsSatisfiable,
    anyOsSatisfiable: installedRuntimes.length > 0,
  });
}
