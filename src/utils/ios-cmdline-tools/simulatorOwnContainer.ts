import { SimulatorContainerUnresolvedError } from "./SimulatorContainerUnresolvedError";
export { SimulatorContainerUnresolvedError } from "./SimulatorContainerUnresolvedError";
import { homedir } from "node:os";
import { posix } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { IOS_SIMULATOR_UUID_PATTERN } from "./iosDeviceType";
import { resolveDeviceSetRoot } from "./SimulatorTccSqliteClient";
import {
  nodeSimulatorResidueFileSystem,
  type SimulatorResidueFileSystem,
} from "./SimulatorResidueReader";
import {
  parseSimulatorContainerPath,
  parseSimulatorGroupContainerPath,
} from "./simulatorContainerPath";

type OwnershipReason = "outside-device-set" | "foreign-device-unproven";
export class SimulatorContainerOwnershipError extends ActionableError {
  constructor(
    readonly reason: OwnershipReason,
    readonly deviceId: string,
    readonly bundleId: string,
    readonly reportedPath: string,
  ) {
    super(
      `iOS simulator container ownership refused (${reason}) for ${bundleId} on ${deviceId}: unproven file path. Confirm the target simulator and reinstall the app or recreate its clone before retrying.`,
    );
  }
}

export interface SimulatorContainerOwnershipOptions {
  deviceSetRoot?: string;
  identity?: Pick<SimulatorResidueFileSystem, "containerIdentifier">;
}
export type SimulatorContainerChoice =
  | { container: "data" }
  | { container: "group"; groupId: string };
interface AppContainerOptions extends SimulatorContainerOwnershipOptions {
  deviceId: string;
  bundleId: string;
  run: (args: string[]) => Promise<{ stdout: string }>;
}

export type ResolveOwnAppContainerOptions = AppContainerOptions & SimulatorContainerChoice;

/** Own paths are accepted directly; cloned registrations need matching clone metadata. */
export async function resolveOwnAppContainer(
  options: ResolveOwnAppContainerOptions,
): Promise<string> {
  const { deviceId, bundleId, run } = options;
  const containerArg = options.container === "data" ? "data" : options.groupId;
  // Execute outside any catch: callers retain their command failure mapping and retries.
  const reportedPath = (
    await run(["get_app_container", deviceId, bundleId, containerArg])
  ).stdout.trim();
  const refuse = (reason: OwnershipReason): never => {
    throw new SimulatorContainerOwnershipError(reason, deviceId, bundleId, reportedPath);
  };
  if (!reportedPath) {
    throw new SimulatorContainerUnresolvedError(deviceId, bundleId);
  }
  const root = options.deviceSetRoot ?? resolveDeviceSetRoot(homedir());
  const parse =
    options.container === "data" ? parseSimulatorContainerPath : parseSimulatorGroupContainerPath;
  const parsed = parse(reportedPath, root);
  if (!parsed || !IOS_SIMULATOR_UUID_PATTERN.test(deviceId)) {
    return refuse("outside-device-set");
  }
  const ownPath = posix.join(
    root,
    deviceId,
    "data/Containers",
    options.container === "data" ? "Data/Application" : "Shared/AppGroup",
    parsed.containerUuid,
  );
  if (parsed.udid.toLowerCase() !== deviceId.toLowerCase()) {
    const identity = options.identity ?? nodeSimulatorResidueFileSystem;
    if (
      (await identity.containerIdentifier(ownPath)) !==
      (options.container === "data" ? bundleId : options.groupId)
    ) {
      return refuse("foreign-device-unproven");
    }
  }
  // Rebuild only from the confined root and validated UUIDs, preserving target device casing.
  return ownPath;
}

export function resolveOwnAppDataContainer(options: AppContainerOptions): Promise<string> {
  return resolveOwnAppContainer({ ...options, container: "data" });
}

export function resolveOwnAppGroupContainer(
  options: AppContainerOptions & { groupId: string },
): Promise<string> {
  return resolveOwnAppContainer({ ...options, container: "group" });
}
