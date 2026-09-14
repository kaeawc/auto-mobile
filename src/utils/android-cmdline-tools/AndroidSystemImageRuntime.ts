import { normalizeAndroidArchitecture } from "./AvdConfigReader";

export interface ParsedAndroidSystemImageRuntime {
  apiLevel: number;
  tag: string;
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
  const apiComponents = apiMatch[1].split(".").map(Number);
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
    tag,
    architecture: normalizeAndroidArchitecture(architecture) ?? architecture,
    systemImagePackage: runtime,
  };
}
