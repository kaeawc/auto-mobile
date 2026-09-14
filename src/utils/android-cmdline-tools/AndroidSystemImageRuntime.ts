import { normalizeAndroidArchitecture } from "./AvdConfigReader";

export interface ParsedAndroidSystemImageRuntime {
  apiLevel: number;
  apiIdentifier: string;
  tag: string;
  abi: string;
  architecture: string;
  systemImagePackage: string;
}

export function parseAndroidSystemImageRuntime(
  runtime: string,
): ParsedAndroidSystemImageRuntime | undefined {
  const parts = runtime.split(";");
  if (parts.length !== 4 || parts[0] !== "system-images") {
    return undefined;
  }
  const apiMatch = /^android-(\d+(?:\.\d+)*)$/.exec(parts[1] ?? "");
  const tag = parts[2];
  const architecture = parts[3];
  if (!apiMatch || !tag || !architecture) {
    return undefined;
  }
  const apiIdentifier = apiMatch[1];
  const apiComponents = apiIdentifier.split(".").map(Number);
  const apiLevel = apiComponents[0];
  if (
    apiLevel === undefined ||
    apiLevel <= 0 ||
    apiComponents.some((component) => !Number.isSafeInteger(component) || component < 0)
  ) {
    return undefined;
  }
  return {
    apiLevel,
    apiIdentifier,
    tag,
    abi: architecture,
    architecture: normalizeAndroidArchitecture(architecture) ?? architecture,
    systemImagePackage: runtime,
  };
}
