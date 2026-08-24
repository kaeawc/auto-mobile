import { ActionableError } from "../models";
import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import { getDeviceCreationGate } from "../utils/deviceCreationGate";
import { DeviceBootService, type DeviceBootRequest } from "../utils/deviceBootService";
import { DefaultDeviceMatcher } from "../utils/deviceMatcher";
import { createDefaultDeviceProvisioner } from "../utils/deviceProvisioning";
import { MultiPlatformDeviceManager } from "../utils/deviceUtils";
import { createCiIosBootConfiguration } from "../utils/deviceBootRecovery";

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ActionableError(`${flag} requires a value.`);
  }
  return value;
}

/** Parse the narrow daemon-free boot command. It intentionally has no session or CtrlProxy options. */
export function parseBootDeviceArgs(args: string[]): DeviceBootRequest {
  const request: Partial<DeviceBootRequest> = { preferRunning: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    index += applyBootDeviceArgument(request, args, index, arg);
  }
  if (request.platform !== "android" && request.platform !== "ios") {
    throw new ActionableError("--platform must be android or ios.");
  }
  return request as DeviceBootRequest;
}

function applyBootDeviceArgument(
  request: Partial<DeviceBootRequest>,
  args: string[],
  index: number,
  flag: string,
): number {
  const valueFields: Record<string, keyof DeviceBootRequest> = {
    "--platform": "platform",
    "--device-id": "deviceId",
    "--name": "name",
    "--min-os-version": "minOsVersion",
    "--max-os-version": "maxOsVersion",
  };
  const field = valueFields[flag];
  if (field) {
    (request as Record<string, unknown>)[field] = readValue(args, index, flag);
    return 1;
  }
  if (flag === "--timeout-ms") {
    const parsed = Number(readValue(args, index, flag));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ActionableError("--timeout-ms must be a positive number.");
    }
    request.timeoutMs = parsed;
    return 1;
  }
  if (flag === "--create-if-missing") {
    request.createIfMissing = true;
    return 0;
  }
  if (flag === "--no-prefer-running") {
    request.preferRunning = false;
    return 0;
  }
  throw new ActionableError(`Unknown boot-device argument: ${flag}`);
}

/**
 * Boot a device without starting the daemon, opening Simulator, allocating a
 * session, downloading CtrlProxy, or initializing an automation runner.
 */
export async function runBootDeviceCommand(args: string[]): Promise<void> {
  const parsedRequest = parseBootDeviceArgs(args);
  const ciConfiguration = await createCiIosBootConfiguration(parsedRequest);
  const service = new DeviceBootService({
    deviceManager: ciConfiguration?.deviceManager ?? new MultiPlatformDeviceManager(),
    deviceMatcher: new DefaultDeviceMatcher(),
    deviceCreationGate: getDeviceCreationGate(),
    deviceProvisioner: ciConfiguration?.deviceProvisioner ?? createDefaultDeviceProvisioner(),
    matchingStrategy: DEVICE_POOL_MATCHING,
    bootRecovery: ciConfiguration?.recovery,
  });
  const result = await service.boot(ciConfiguration?.request ?? parsedRequest);
  console.log(
    JSON.stringify({
      deviceId: result.device.deviceId,
      name: result.device.name,
      platform: result.device.platform,
      osVersion: result.device.osVersion ?? result.device.iosVersion,
      source: result.source,
      processId: result.processId,
      provisioned: result.provisioned,
    }),
  );
}
