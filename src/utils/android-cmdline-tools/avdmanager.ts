import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { defaultTimer } from "../SystemTimer";
import { logger } from "../logger";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  validateRequiredTools,
} from "./detection";
import { AvdManagerClient, type AvdManagerExecutionOptions } from "./AvdManagerClient";
import {
  SdkManagerClient,
  type SdkManagerCommandResult,
  type SdkManagerClientDependencies,
} from "./SdkManagerClient";

/** Dependencies shared by the functional AVD facade and its two typed clients. */
export type AvdManagerDependencies = Omit<
  SdkManagerClientDependencies,
  "timer" | "environment" | "platform"
>;

const createDefaultDependencies = (): AvdManagerDependencies => ({
  spawn,
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
    dependencies.logger.error(message);
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
  const result = await createSdkManagerClient(dependencies).list({ signal });
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
    const result = await createSdkManagerClient(dependencies).installPackage(packageName, { acceptLicenses: acceptLicense });
    if (result.exitCode === 0) {
      return { success: true, message: `System image ${packageName} installed successfully` };
    }
    return { success: false, message: `Installation failed: ${failureDiagnostics(result)}` };
  } catch (error) {
    const message = `Failed to install system image ${packageName}: ${(error as Error).message}`;
    dependencies.logger.error(message);
    return { success: false, message };
  }
}

/** List AVDs through the dedicated avdmanager boundary. */
export async function listDeviceImages(dependencies = createDefaultDependencies()): Promise<AvdInfo[]> {
  return createAvdManagerClient(dependencies).listDeviceImages();
}

/** Create an AVD through the dedicated avdmanager boundary. */
export async function createAvd(
  params: CreateAvdParams,
  dependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string; avdName?: string }> {
  return createAvdManagerClient(dependencies).createAvd(params, { signal });
}

/** Delete an AVD through the dedicated avdmanager boundary. */
export async function deleteAvd(
  name: string,
  dependencies: AvdManagerDependencies = createDefaultDependencies(),
  options: AvdManagerExecutionOptions = {},
): Promise<{ success: boolean; message: string }> {
  return createAvdManagerClient(dependencies).deleteAvd(name, options);
}

/** List device profiles through the dedicated avdmanager boundary. */
export async function listDevices(dependencies = createDefaultDependencies()): Promise<DeviceProfile[]> {
  return createAvdManagerClient(dependencies).listDevices();
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
    if (trimmedLine.includes("Available Packages:")) {currentSection = "available"; continue;}
    if (trimmedLine.includes("Installed packages:")) {currentSection = "installed"; continue;}
    if (trimmedLine.includes("Available Updates:")) {currentSection = null; continue;}
    if (currentSection !== section || !trimmedLine.startsWith("system-images;")) {continue;}
    const parts = trimmedLine.split(/\s+/);
    const packageName = parts[0].split("|")[0];
    const packageParts = packageName.split(";");
    if (packageParts.length < 4) {continue;}
    const image: SystemImage = {
      packageName,
      apiLevel: Number.parseInt(packageParts[1].replace("android-", ""), 10),
      tag: packageParts[2],
      abi: packageParts[3],
      versionInfo: parts.slice(1).join(" "),
    };
    if (!filter || matchesFilter(image, filter)) {images.push(image);}
  }
  return images;
}

function matchesFilter(image: SystemImage, filter: SystemImageFilter): boolean {
  return (!filter.apiLevel || image.apiLevel === filter.apiLevel) &&
    (!filter.tag || image.tag === filter.tag) &&
    (!filter.abi || image.abi === filter.abi);
}

export interface SystemImageFilter { apiLevel?: number; tag?: string; abi?: string; }
export type SdkManagerSection = "available" | "installed";
export interface SystemImage { packageName: string; apiLevel: number; tag: string; abi: string; versionInfo: string; }
export interface CreateAvdParams { name: string; package: string; device?: string; force?: boolean; path?: string; tag?: string; abi?: string; }
export interface AvdInfo { name: string; path?: string; target?: string; basedOn?: string; error?: string; }
export interface DeviceProfile { id: string; name?: string; oem?: string; }

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
