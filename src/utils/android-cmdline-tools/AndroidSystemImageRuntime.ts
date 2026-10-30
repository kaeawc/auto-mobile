import { normalizeAndroidArchitecture } from "./AvdConfigReader";

export interface ParsedAndroidSystemImageRuntime {
  apiLevel: number;
  apiIdentifier: string;
  /** SDK extension level of an `android-<api>-ext<N>` image (#15959); absent for a base image. */
  extensionLevel?: number;
  tag: string;
  abi: string;
  architecture: string;
  systemImagePackage: string;
}

type ParsedApiSegment = Pick<
  ParsedAndroidSystemImageRuntime,
  "apiLevel" | "apiIdentifier" | "extensionLevel"
>;

/**
 * The API identity of a package's `android-<api>` segment. SDK extension images name it
 * `android-<api>-ext<N>` (#15959); the API level is still the leading number.
 */
function parseApiSegment(segment: string): ParsedApiSegment | undefined {
  const match = /^android-(\d+(?:\.\d+)*)(?:-ext(\d+))?$/.exec(segment);
  if (!match) {
    return undefined;
  }
  const apiIdentifier = match[1];
  const apiComponents = apiIdentifier.split(".").map(Number);
  const apiLevel = apiComponents[0];
  const extensionLevel = match[2] === undefined ? undefined : Number(match[2]);
  if (
    apiLevel === undefined ||
    apiLevel <= 0 ||
    apiComponents.some((component) => !Number.isSafeInteger(component) || component < 0) ||
    (extensionLevel !== undefined && (!Number.isSafeInteger(extensionLevel) || extensionLevel <= 0))
  ) {
    return undefined;
  }
  return { apiLevel, apiIdentifier, ...(extensionLevel === undefined ? {} : { extensionLevel }) };
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
    ...api,
    tag,
    abi: architecture,
    architecture: normalizeAndroidArchitecture(architecture) ?? architecture,
    systemImagePackage: runtime,
  };
}
