import { existsSync } from "node:fs";
import { defaultTimer } from "../SystemTimer";
import { logger } from "../logger";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  validateRequiredTools,
} from "./detection";
import {
  AvdManagerClient,
  type AvdManagerExecutionOptions,
} from "./AvdManagerClient";
import {
  SdkManagerClient,
  type SdkManagerCommandResult,
  type SdkManagerClientDependencies,
} from "./SdkManagerClient";
import { parseAndroidSystemImageRuntime } from "./AndroidSystemImageRuntime";
import { invalidateAndroidInventoryProvenanceAndCatalog } from "../AndroidInventoryInvalidation";

/** Dependencies shared by the functional AVD facade and its two typed clients. */
export type AvdManagerDependencies = Omit<
  SdkManagerClientDependencies,
  "timer" | "environment" | "platform"
>;

// Route the facade's default spawn through the shared host-process seam too, so
// production paths that reach AvdManagerClient/SdkManagerClient through this
// facade (and AvdManagerService) go through the single process-execution funnel
// rather than a directly-imported `child_process.spawn` (issue #5459). The
// executor's `spawn` is a plain passthrough, and the dependency stays injectable.
const facadeHostProcessExecutor = new DefaultHostCommandExecutor();

const createDefaultDependencies = (): AvdManagerDependencies => ({
  spawn: (command, args, options) => facadeHostProcessExecutor.spawn(command, args, options),
  existsSync,
  logger,
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  validateRequiredTools,
});

function createSdkManagerClient(dependencies: AvdManagerDependencies): SdkManagerClient {
  return new SdkManagerClient({
    ...dependencies,
    timer: defaultTimer,
    environment: process.env,
    platform: process.platform,
  });
}

function failureDiagnostics(result: SdkManagerCommandResult): string {
  const output = result.stderr || result.stdout || "Unknown sdkmanager failure";
  return result.outputTruncated ? `${output}\n[output truncated]` : output;
}

/** Accept Android SDK licenses through the dedicated sdkmanager boundary. */
export async function acceptLicenses(dependencies = createDefaultDependencies()): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const result = await createSdkManagerClient(dependencies).acceptLicenses();
    if (result.exitCode === 0) {
      return { success: true, message: "Android SDK licenses accepted" };
    }
    return { success: false, message: `License acceptance failed: ${failureDiagnostics(result)}` };
  } catch (error) {
    const message = `Failed to accept licenses: ${(error as Error).message}`;
    dependencies.logger.warn(message, error);
    return { success: false, message };
  }
}

/** List downloadable system images through the dedicated sdkmanager boundary. */
export async function listSystemImages(
  filter?: SystemImageFilter,
  dependencies = createDefaultDependencies(),
): Promise<SystemImage[]> {
  const result = await createSdkManagerClient(dependencies).list();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list system images: ${failureDiagnostics(result)}`);
  }
  return parseSystemImages(result.stdout, filter);
}

/** List installed system images through the dedicated sdkmanager boundary. */
export async function listInstalledSystemImages(
  filter?: SystemImageFilter,
  dependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<SystemImage[]> {
  const client = createSdkManagerClient(dependencies);
  let result = await client.listInstalled({ signal });
  if (result.exitCode !== 0) {
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    if (/unknown option|unrecognized option|invalid option|unknown argument/i.test(diagnostics)) {
      dependencies.logger.warn(
        "sdkmanager --list_installed is not supported; falling back to sdkmanager --list",
      );
      result = await client.list({ signal });
    } else {
      throw new Error(`Failed to list installed system images: ${failureDiagnostics(result)}`);
    }
  }
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list installed system images: ${failureDiagnostics(result)}`);
  }
  return parseSystemImages(result.stdout, filter, "installed");
}

/** Download and install a system image through the dedicated sdkmanager boundary. */
export async function installSystemImage(
  packageName: string,
  acceptLicense = true,
  dependencies = createDefaultDependencies(),
): Promise<{ success: boolean; message: string }> {
  try {
    const result = await createSdkManagerClient(dependencies).installPackage(packageName, {
      acceptLicenses: acceptLicense,
    });
    if (result.exitCode === 0) {
      invalidateAndroidInventoryProvenanceAndCatalog();
      return { success: true, message: `System image ${packageName} installed successfully` };
    }
    return { success: false, message: `Installation failed: ${failureDiagnostics(result)}` };
  } catch (error) {
    const message = `Failed to install system image ${packageName}: ${(error as Error).message}`;
    dependencies.logger.warn(message, error);
    return { success: false, message };
  }
}

/** List AVDs through the dedicated avdmanager boundary. */
export async function listDeviceImages(
  dependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<AvdInfo[]> {
  return createAvdManagerClient(dependencies).listDeviceImages({ signal });
}

/** Create an AVD through the dedicated avdmanager boundary. */
export async function createAvd(
  params: CreateAvdParams,
  dependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string; avdName?: string }> {
  let result: Awaited<ReturnType<AvdManagerClient["createAvd"]>>;
  try {
    result = await createAvdManagerClient(dependencies).createAvd(params, { signal });
  } catch (error) {
    // Any thrown create (interrupted, timed out, or cancelled by the abort signal)
    // may have left the AVD on disk; list it fresh for rollback (#11186).
    invalidateAndroidInventoryProvenanceAndCatalog();
    throw error;
  }
  if (result.success) {
    invalidateAndroidInventoryProvenanceAndCatalog();
  }
  return result;
}

/** Delete an AVD through the dedicated avdmanager boundary. */
export async function deleteAvd(
  name: string,
  dependencies: AvdManagerDependencies = createDefaultDependencies(),
  options: AvdManagerExecutionOptions = {},
): Promise<{ success: boolean; message: string }> {
  const result = await createAvdManagerClient(dependencies).deleteAvd(name, options);
  if (result.success) {
    invalidateAndroidInventoryProvenanceAndCatalog();
  }
  return result;
}

/** List device profiles through the dedicated avdmanager boundary. */
export async function listDevices(
  dependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<DeviceProfile[]> {
  return createAvdManagerClient(dependencies).listDevices({ signal });
}

function createAvdManagerClient(dependencies: AvdManagerDependencies): AvdManagerClient {
  return new AvdManagerClient({
    ...dependencies,
    timer: defaultTimer,
    environment: process.env,
    platform: process.platform,
  });
}

/** Parse one section of sdkmanager --list output into typed system-image data. */
export function parseSystemImages(
  output: string,
  filter?: SystemImageFilter,
  section: SdkManagerSection = "available",
): SystemImage[] {
  const images: SystemImage[] = [];
  let currentSection: SdkManagerSection | null = null;
  for (const line of output.split("\n")) {
    const trimmedLine = line.trim();
    const headerSection = parseSystemImageSectionHeader(trimmedLine);
    if (headerSection !== undefined) {
      currentSection = headerSection;
      continue;
    }
    if (currentSection !== section) {
      continue;
    }
    const image = parseSystemImageRow(trimmedLine);
    if (!image || (filter && !matchesFilter(image, filter))) {
      continue;
    }
    images.push(image);
  }
  return images;
}

function parseSystemImageSectionHeader(line: string): SdkManagerSection | null | undefined {
  const normalizedLine = line.toLowerCase();
  if (normalizedLine.includes("available packages:")) {
    return "available";
  }
  if (normalizedLine.includes("installed packages:")) {
    return "installed";
  }
  if (normalizedLine.includes("available updates:")) {
    return null;
  }
  return undefined;
}

function parseSystemImageRow(line: string): SystemImage | undefined {
  if (/^(?:path\s*\|\s*version|[-|\s]+)$/i.test(line)) {
    return undefined;
  }
  const pipeIndex = line.indexOf("|");
  const rawPackageName = (pipeIndex >= 0 ? line.slice(0, pipeIndex) : line).trim().split(/\s+/)[0];
  if (
    !rawPackageName ||
    (!rawPackageName.startsWith("system-images/") && !rawPackageName.startsWith("system-images;"))
  ) {
    return undefined;
  }
  const packageName = rawPackageName.replaceAll("/", ";");
  const parsedRuntime = parseAndroidSystemImageRuntime(packageName);
  if (!parsedRuntime) {
    return undefined;
  }
  return {
    packageName,
    apiLevel: parsedRuntime.apiLevel,
    apiIdentifier: parsedRuntime.apiIdentifier,
    tag: parsedRuntime.tag,
    abi: parsedRuntime.abi,
    versionInfo: line.split(/\s+/).slice(1).join(" "),
  };
}

function matchesFilter(image: SystemImage, filter: SystemImageFilter): boolean {
  return (
    (!filter.apiLevel || image.apiLevel === filter.apiLevel) &&
    (!filter.tag || image.tag === filter.tag) &&
    (!filter.abi || image.abi === filter.abi)
  );
}

export interface SystemImageFilter {
  apiLevel?: number;
  tag?: string;
  abi?: string;
}
export type SdkManagerSection = "available" | "installed";
export interface SystemImage {
  packageName: string;
  /** Exact dotted API identity from the package (for example, "36.1"). */
  apiIdentifier: string;
  /** Integer major API used for capability, minSdk, and range checks. */
  apiLevel: number;
  tag: string;
  abi: string;
  versionInfo: string;
}
export interface CreateAvdParams {
  name: string;
  package: string;
  device?: string;
  force?: boolean;
  path?: string;
  tag?: string;
  abi?: string;
}
export interface AvdInfo {
  name: string;
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
}
export interface DeviceProfile {
  id: string;
  name?: string;
  oem?: string;
}

export const COMMON_SYSTEM_IMAGES = {
  API_35: {
    GOOGLE_APIS_ARM64: "system-images;android-35;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-35;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-35;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-35;google_apis_playstore;x86_64",
  },
  API_34: {
    GOOGLE_APIS_ARM64: "system-images;android-34;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-34;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-34;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-34;google_apis_playstore;x86_64",
  },
  API_33: {
    GOOGLE_APIS_ARM64: "system-images;android-33;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-33;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-33;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-33;google_apis_playstore;x86_64",
  },
} as const;

export const COMMON_DEVICES = {
  PIXEL_4: "pixel_4",
  PIXEL_6: "pixel_6",
  PIXEL_7: "pixel_7",
  NEXUS_5X: "Nexus 5X",
  MEDIUM_PHONE: "Medium Phone",
  SMALL_PHONE: "Small Phone",
} as const;
