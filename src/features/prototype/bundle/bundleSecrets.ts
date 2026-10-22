import { isIP } from "node:net";
import { logger } from "../../../utils/logger";
import { classifyAddress, StrictEgressPolicy } from "../prototypeEgressPolicy";
import { record } from "../prototypeTemplate";
import { parseBundleJson } from "./bundleJson";
import { BUNDLE_MAX_SPEC_BYTES } from "./bundleContract";

export interface BundleSecretWarning {
  code: "credential_header" | "credential_query" | "private_host";
  path: string;
}
function urlWarnings(value: string, path: string): BundleSecretWarning[] {
  try {
    const url = new URL(value);
    const warnings: BundleSecretWarning[] = [];
    for (const key of url.searchParams.keys()) {
      if (["token", "key", "secret", "sig"].includes(key.toLowerCase())) {
        warnings.push({ code: "credential_query", path: `${path}.query.${key}` });
      }
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      !new StrictEgressPolicy(new Set()).permitsHostname(host) ||
      (isIP(host) && classifyAddress(host) !== "public")
    ) {
      warnings.push({ code: "private_host", path });
    }
    return warnings;
  } catch (error) {
    // Template URLs need not be literal valid URLs; preflight is advisory and must not block sharing.
    logger.debug("Cannot scan non-literal request URL", error);
    return [];
  }
}
/** Warnings identify fields, never copy credentials into UI/log messages. No DNS or raw-text scan. */
export function scanBundleForSecrets(specBytes: Uint8Array): BundleSecretWarning[] {
  if (specBytes.length > BUNDLE_MAX_SPEC_BYTES) {
    return [];
  }
  try {
    const value = parseBundleJson(specBytes, "spec_invalid_json", "spec.json");
    const pending: { value: unknown; path: string }[] = [{ value, path: "$" }];
    const warnings: BundleSecretWarning[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      const object = record(current.value);
      if (object?.type === "request") {
        warnings.push(...requestWarnings(object, current.path));
      }
      pending.push(...children(current.value, current.path));
    }
    return warnings;
  } catch (error) {
    // Invalid specs are rejected by export; advisory scans never raise a second failure.
    logger.debug("Cannot scan invalid prototype bundle spec", error);
    return [];
  }
}
function requestWarnings(action: Record<string, unknown>, path: string): BundleSecretWarning[] {
  const warnings: BundleSecretWarning[] = [];
  for (const name of Object.keys(record(action.headers) ?? {})) {
    if (["authorization", "cookie", "x-api-key"].includes(name.toLowerCase())) {
      warnings.push({ code: "credential_header", path: `${path}.headers.${name}` });
    }
  }
  if (typeof action.url === "string") {
    warnings.push(...urlWarnings(action.url, `${path}.url`));
  }
  return warnings;
}

function children(value: unknown, path: string): { value: unknown; path: string }[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).map(([key, child]) => ({ value: child, path: `${path}.${key}` }));
}
