import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeviceInfo } from "../models";
import { ActionableError } from "../models";
import type { DeviceCreationGate } from "./deviceCreationGate";
import type { PlatformDeviceManager } from "./deviceUtils";
import type { AvdConfigReader } from "./android-cmdline-tools/AvdConfigReader";
import {
  FileAvdConfigReader,
  resolveAndroidAvdHome,
} from "./android-cmdline-tools/AvdConfigReader";
import { AvdManagerClient } from "./android-cmdline-tools/AvdManagerClient";
import type { CreateAvdParams } from "./android-cmdline-tools/avdmanager";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";

export interface AndroidDeviceSpecification {
  runtime: string;
  deviceType: string;
  configuration?: {
    memoryMb?: number;
  };
}

export interface IosDeviceSpecification {
  runtime: string;
  deviceType: string;
}

export type ExactDeviceSpecification = AndroidDeviceSpecification | IosDeviceSpecification;

export interface ExactDeviceProvisionRequest {
  platform: "android" | "ios";
  name: string;
  deviceId?: string;
  spec: ExactDeviceSpecification;
  /** Reconcile mutable configuration only for a replay of the same operation. */
  reconcileExistingConfiguration?: boolean;
  /** Persist ownership immediately before creating a previously absent device. */
  onBeforeCreate?: () => Promise<void>;
  signal?: AbortSignal;
}

export interface ExactProvisionedDevice {
  device: DeviceInfo;
  created: boolean;
  resolvedSpec: ExactDeviceSpecification;
}

export type ProvisionDeviceFailureCode =
  | "creation_not_allowed"
  | "identity_conflict"
  | "timeout"
  | "platform_command_failed";

export class ProvisionDeviceError extends ActionableError {
  constructor(
    public readonly code: ProvisionDeviceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionDeviceError";
  }
}

export interface ExactAndroidAvdClient {
  createAvd(
    params: CreateAvdParams,
    options?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; message: string; avdName?: string }>;
}

export interface ExactIosSimulatorClient {
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface AndroidAvdConfigWriter {
  setMemoryMb(avdName: string, memoryMb: number): Promise<void>;
}

interface FileAndroidAvdConfigWriterDependencies {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  environment: NodeJS.ProcessEnv;
  homeDirectory: () => string;
}

function defaultAndroidAvdConfigWriterDependencies(): FileAndroidAvdConfigWriterDependencies {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
    environment: process.env,
    homeDirectory: homedir,
  };
}

/**
 * Applies a small, typed subset of AVD hardware configuration after
 * `avdmanager create avd`. The caller creates only default-path AVDs, so the
 * standard AVD-home location is authoritative here.
 */
export class FileAndroidAvdConfigWriter implements AndroidAvdConfigWriter {
  constructor(
    private readonly dependencies: FileAndroidAvdConfigWriterDependencies =
      defaultAndroidAvdConfigWriterDependencies(),
  ) {}

  async setMemoryMb(avdName: string, memoryMb: number): Promise<void> {
    if (!Number.isInteger(memoryMb) || memoryMb <= 0) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Android AVD memoryMb must be a positive integer; got ${memoryMb}.`,
      );
    }
    const avdHome = resolveAndroidAvdHome(
      this.dependencies.environment,
      this.dependencies.homeDirectory(),
    );
    const configPath = join(avdHome, `${avdName}.avd`, "config.ini");
    const content = await this.dependencies.readFile(configPath, "utf8");
    const lines = content.split(/\r?\n/);
    let replaced = false;
    const updated = lines.map((line) => {
      if (line.startsWith("hw.ramSize=")) {
        replaced = true;
        return `hw.ramSize=${memoryMb}`;
      }
      return line;
    });
    if (!replaced) {
      if (updated.at(-1) !== "") {
        updated.push("");
      }
      updated.push(`hw.ramSize=${memoryMb}`, "");
    }
    await this.dependencies.writeFile(configPath, updated.join("\n"), "utf8");
  }
}

export interface ExactDeviceProvisioner {
  provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice>;
}

export interface DefaultExactDeviceProvisionerDependencies {
  listDeviceImages: PlatformDeviceManager["listDeviceImages"];
  isCreationAllowed: DeviceCreationGate["isCreationAllowed"];
  avdManager: ExactAndroidAvdClient;
  androidConfigReader: AvdConfigReader;
  androidConfigWriter: AndroidAvdConfigWriter;
  iosSimulator: ExactIosSimulatorClient;
}

function requestedAndroidRuntime(runtime: string): {
  apiLevel: number;
  tag: string;
  architecture: string;
} | undefined {
  const parts = runtime.split(";");
  if (parts.length !== 4 || parts[0] !== "system-images") {
    return undefined;
  }
  const apiMatch = /^android-(\d+)$/.exec(parts[1] ?? "");
  if (!apiMatch || !parts[2] || !parts[3]) {
    return undefined;
  }
  return {
    apiLevel: Number(apiMatch[1]),
    tag: parts[2],
    architecture: parts[3] === "arm64-v8a" ? "arm64" : parts[3],
  };
}

function sameAndroidDeviceIdentity(
  spec: AndroidDeviceSpecification,
  config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>,
): boolean {
  const runtime = requestedAndroidRuntime(spec.runtime);
  if (!runtime || !config) {
    return false;
  }
  if (
    config.apiLevel !== runtime.apiLevel ||
    config.tag !== runtime.tag ||
    config.architecture !== runtime.architecture ||
    config.deviceName !== spec.deviceType
  ) {
    return false;
  }
  return true;
}

function sameAndroidSpecification(
  spec: AndroidDeviceSpecification,
  config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>,
): boolean {
  return sameAndroidDeviceIdentity(spec, config) && (
    spec.configuration?.memoryMb === undefined ||
    config?.ramSizeMb === spec.configuration.memoryMb
  );
}

const exactProvisioningLocks = new Map<string, Promise<void>>();

async function runWithExactProvisioningLock<T>(
  platform: "android" | "ios",
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${platform}:${name}`;
  const previous = exactProvisioningLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  exactProvisioningLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (exactProvisioningLocks.get(key) === current) {
      exactProvisioningLocks.delete(key);
    }
  }
}

/**
 * Exact virtual-device creation used by trusted controllers. It intentionally
 * never falls back to a "close enough" image, runtime, or device profile.
 */
export class DefaultExactDeviceProvisioner implements ExactDeviceProvisioner {
  constructor(private readonly dependencies: DefaultExactDeviceProvisionerDependencies) {}

  async provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice> {
    return await runWithExactProvisioningLock(
      request.platform,
      request.name,
      async () => await this.provisionLocked(request),
    );
  }

  private async provisionLocked(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice> {
    const images = await this.dependencies.listDeviceImages(request.platform);
    const existing = this.findExisting(images, request);
    if (existing) {
      await this.assertExistingMatches(request, existing);
      return {
        device: existing,
        created: false,
        resolvedSpec: request.spec,
      };
    }

    if (!this.dependencies.isCreationAllowed(true)) {
      throw new ProvisionDeviceError(
        "creation_not_allowed",
        `Device creation is disabled; cannot provision exact ${request.platform} device '${request.name}'.`,
      );
    }

    await request.onBeforeCreate?.();
    if (request.platform === "android") {
      return await this.createAndroid(request, request.spec as AndroidDeviceSpecification);
    }
    return await this.createIos(request, request.spec as IosDeviceSpecification);
  }

  private findExisting(
    images: DeviceInfo[],
    request: ExactDeviceProvisionRequest,
  ): DeviceInfo | undefined {
    if (request.platform !== "ios") {
      return images.find((image) =>
        image.name === request.name ||
        (request.deviceId !== undefined && image.deviceId === request.deviceId),
      );
    }

    if (request.deviceId !== undefined) {
      return images.find((image) => image.deviceId === request.deviceId);
    }

    const candidates = images.filter((image) => image.name === request.name);
    const spec = request.spec as IosDeviceSpecification;
    return candidates.find((image) =>
      image.isAvailable !== false &&
      image.runtime === spec.runtime &&
      image.deviceType === spec.deviceType,
    ) ?? candidates.find((image) =>
      image.runtime === spec.runtime &&
      image.deviceType === spec.deviceType,
    ) ?? candidates[0];
  }

  private async assertExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): Promise<void> {
    if (existing.platform !== request.platform) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Requested ${request.platform} device '${request.name}' conflicts with existing ${existing.platform} device.`,
      );
    }
    if (existing.name !== request.name) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Requested device name '${request.name}' conflicts with existing '${existing.name}' for the supplied identity.`,
      );
    }

    if (request.platform === "android") {
      await this.assertAndroidExistingMatches(request, existing);
      return;
    }

    this.assertIosExistingMatches(request, existing);
  }

  private async assertAndroidExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): Promise<void> {
    const spec = request.spec as AndroidDeviceSpecification;
    const config = await this.dependencies.androidConfigReader.readConfig(existing.name);
    if (sameAndroidSpecification(spec, config)) {
      return;
    }
    if (
      request.reconcileExistingConfiguration &&
      spec.configuration?.memoryMb !== undefined &&
      sameAndroidDeviceIdentity(spec, config)
    ) {
      await this.dependencies.androidConfigWriter.setMemoryMb(existing.name, spec.configuration.memoryMb);
      const reconciled = await this.dependencies.androidConfigReader.readConfig(existing.name);
      if (sameAndroidSpecification(spec, reconciled)) {
        return;
      }
    }
    throw new ProvisionDeviceError(
      "identity_conflict",
      `Existing Android AVD '${existing.name}' does not match the requested runtime, device type, and configuration.`,
    );
  }

  private assertIosExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): void {
    const spec = request.spec as IosDeviceSpecification;
    if (existing.isAvailable === false) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Existing iOS simulator '${existing.name}' is unavailable: ${existing.availabilityError ?? "CoreSimulator marked it unavailable"}.`,
      );
    }
    if (existing.runtime !== spec.runtime || existing.deviceType !== spec.deviceType) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Existing iOS simulator '${existing.name}' does not match the requested runtime and device type.`,
      );
    }
  }

  private async createAndroid(
    request: ExactDeviceProvisionRequest,
    spec: AndroidDeviceSpecification,
  ): Promise<ExactProvisionedDevice> {
    const created = await this.dependencies.avdManager.createAvd({
      name: request.name,
      package: spec.runtime,
      device: spec.deviceType,
    }, { signal: request.signal });
    if (!created.success) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Failed to create Android AVD '${request.name}': ${created.message}`,
      );
    }
    if (spec.configuration?.memoryMb !== undefined) {
      await this.dependencies.androidConfigWriter.setMemoryMb(request.name, spec.configuration.memoryMb);
    }
    return {
      created: true,
      device: {
        name: request.name,
        platform: "android",
        isRunning: false,
      },
      resolvedSpec: spec,
    };
  }

  private async createIos(
    request: ExactDeviceProvisionRequest,
    spec: IosDeviceSpecification,
  ): Promise<ExactProvisionedDevice> {
    const deviceId = await this.dependencies.iosSimulator.createSimulator(
      request.name,
      spec.deviceType,
      spec.runtime,
      request.signal,
    );
    return {
      created: true,
      device: {
        name: request.name,
        platform: "ios",
        deviceId,
        isRunning: false,
        runtime: spec.runtime,
        deviceType: spec.deviceType,
      },
      resolvedSpec: spec,
    };
  }
}

export function createDefaultExactDeviceProvisioner(
  deviceManager: PlatformDeviceManager,
  deviceCreationGate: DeviceCreationGate,
  androidConfigWriter: AndroidAvdConfigWriter = new FileAndroidAvdConfigWriter(),
): ExactDeviceProvisioner {
  return new DefaultExactDeviceProvisioner({
    listDeviceImages: deviceManager.listDeviceImages.bind(deviceManager),
    isCreationAllowed: deviceCreationGate.isCreationAllowed.bind(deviceCreationGate),
    avdManager: new AvdManagerClient(),
    androidConfigReader: new FileAvdConfigReader(),
    androidConfigWriter,
    iosSimulator: new SimCtlClient(null),
  });
}
