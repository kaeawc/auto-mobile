import { normalizeAndroidArchitecture } from "./AvdConfigReader";

export interface ParsedAndroidSystemImageRuntime {
  apiLevel: number;
  apiIdentifier: string;
  /** SDK extension level of an `android-<api>-ext<N>` package; absent for the base image. */
  extensionLevel?: number;
  tag: string;
  abi: string;
  architecture: string;
  systemImagePackage: string;
}

/** The numeric API identity of a package's API segment and its optional SDK extension level. */
function parseApiSegment(
  segment: string,
): { apiIdentifier: string; apiLevel: number; extensionLevel?: number } | undefined {
  const apiMatch = /^android-(\d+(?:\.\d+)*)(?:-ext(\d+))?$/.exec(segment);
  if (!apiMatch) {
    return undefined;
  }
  const apiIdentifier = apiMatch[1];
  const apiComponents = apiIdentifier.split(".").map(Number);
  const apiLevel = apiComponents[0];
  if (apiLevel <= 0 || !apiComponents.every(isNonNegativeSafeInteger)) {
    return undefined;
  }
  if (apiMatch[2] === undefined) {
    return { apiIdentifier, apiLevel };
  }
  const extensionLevel = Number(apiMatch[2]);
  return Number.isSafeInteger(extensionLevel) && extensionLevel > 0
    ? { apiIdentifier, apiLevel, extensionLevel }
    : undefined;
}

function isNonNegativeSafeInteger(component: number): boolean {
  return Number.isSafeInteger(component) && component >= 0;
}

export function parseAndroidSystemImageRuntime(
  runtime: string,
): ParsedAndroidSystemImageRuntime | undefined {
  const parts = runtime.split(";");
  if (parts.length !== 4 || parts[0] !== "system-images") {
    return undefined;
  }
  const api = parseApiSegment(parts[1] ?? "");
  const tag = parts[2];
  const architecture = parts[3];
  if (!api || !tag || !architecture) {
    return undefined;
  }
  return {
    apiLevel: api.apiLevel,
    apiIdentifier: api.apiIdentifier,
    ...(api.extensionLevel === undefined ? {} : { extensionLevel: api.extensionLevel }),
    tag,
    abi: architecture,
    architecture: normalizeAndroidArchitecture(architecture) ?? architecture,
    systemImagePackage: runtime,
  };
}
