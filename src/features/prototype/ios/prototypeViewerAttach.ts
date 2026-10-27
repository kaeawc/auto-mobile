import {
  resolveOwnAppDataContainer,
  SimulatorContainerOwnershipError,
  SimulatorContainerUnresolvedError,
  type SimulatorContainerOwnershipOptions,
} from "../../../utils/ios-cmdline-tools/simulatorOwnContainer";
import { posix } from "node:path";
import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../../../utils/filesystem/DefaultFileSystem";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY } from "../../observe/android/ctrlProxyProtocol";
import {
  connectPrototypeAgent,
  NodePrototypeAgentConnector,
  type PrototypeAgentClient,
  type PrototypeAgentConnector,
} from "./prototypeAgentClient";
import type { PrototypeAgentConnect } from "./prototypeAgentInjection";
import {
  parsePrototypeViewerEndpoint,
  PROTOTYPE_VIEWER_ENDPOINT_RELATIVE_PATH,
} from "./prototypeViewerEndpoint";
import { PrototypeViewerConnections } from "./PrototypeViewerConnections";
import { BufferedViewerClient } from "./BufferedViewerClient";
import { HandshakeReplaySocket } from "./HandshakeReplaySocket";
export { PrototypeViewerConnections } from "./PrototypeViewerConnections";
export { CompositePrototypeAgentConnections } from "./CompositePrototypeAgentConnections";

// Simulator and prototype container paths are POSIX on every host OS.
const { join } = posix;

export interface PrototypeViewerRecord {
  bundleId: string;
  client: PrototypeAgentClient;
}

export interface PrototypeViewerLaunchAttacher {
  attach(device: BootedDevice, bundleId: string): Promise<unknown>;
}

export const prototypeViewerConnections = new PrototypeViewerConnections();

export interface PrototypeViewerAttacherDependencies {
  containers: { dataContainer(deviceId: string, bundleId: string): Promise<string> };
  files: { readText(path: string): Promise<string | undefined> };
  connect: PrototypeAgentConnect;
  connections: PrototypeViewerConnections;
}

export class PrototypeViewerAttacher implements PrototypeViewerLaunchAttacher {
  private readonly inFlight = new Map<string, Promise<PrototypeAgentClient>>();
  constructor(private readonly deps: PrototypeViewerAttacherDependencies) {}

  attach(device: BootedDevice, bundleId: string): Promise<PrototypeAgentClient> {
    const key = JSON.stringify([device.deviceId, bundleId]);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.attachViewer(device, bundleId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async attachViewer(
    device: BootedDevice,
    bundleId: string,
  ): Promise<PrototypeAgentClient> {
    if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
      throw new ActionableError(
        "Prototype viewers run on simulators only; choose a booted iOS simulator.",
      );
    }
    const existing = this.deps.connections.get(device.deviceId, bundleId);
    if (existing !== undefined) {
      return existing;
    }
    const container = (await this.deps.containers.dataContainer(device.deviceId, bundleId)).trim();
    if (!container) {
      throw new ActionableError(
        "No data container for the prototype viewer; install it on this simulator and retry.",
      );
    }
    const text = await this.deps.files.readText(
      join(container, PROTOTYPE_VIEWER_ENDPOINT_RELATIVE_PATH),
    );
    if (text === undefined) {
      throw new ActionableError(
        "no endpoint file: the viewer is not running or has exited cleanly; open it from the home screen (launchApp) and retry",
      );
    }
    const { port, token } = parsePrototypeViewerEndpoint(text);
    // Free a different viewer's single host slot before opening its replacement.
    this.deps.connections.releaseDevice(device.deviceId);
    let client: PrototypeAgentClient;
    try {
      client = await this.deps.connect(port, token);
    } catch (error) {
      throw new ActionableError(
        "Could not attach to the prototype viewer: the token may be stale (viewer relaunched) or another host is already attached (the viewer accepts one host at a time). Open the viewer and retry.",
        { cause: error },
      );
    }
    if (!client.handshake.capabilities.includes(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY)) {
      client.close();
      throw new ActionableError(
        "The endpoint is not a prototype viewer: missing prototype_persistence_replay_v1; open the viewer and retry.",
      );
    }
    const buffered =
      client instanceof BufferedViewerClient ? client : new BufferedViewerClient(client);
    this.deps.connections.record(device.deviceId, { bundleId, client: buffered });
    return buffered;
  }
}

export interface PrototypeViewerProductionDependencies {
  containerOwnership?: SimulatorContainerOwnershipOptions;
  simctl?: Pick<SimCtlClient, "executeCommandArgs">;
  files?: Pick<FileSystem, "readFile" | "existsSync">;
  connector?: PrototypeAgentConnector;
  timer?: Timer;
  connections?: PrototypeViewerConnections;
}

/** Production adapters remain lazy: constructing an attacher performs no device or file I/O. */
export function createPrototypeViewerAttacher(
  deps: PrototypeViewerProductionDependencies = {},
): PrototypeViewerAttacher {
  const simctl = deps.simctl ?? new SimCtlClient();
  const files = deps.files ?? new DefaultFileSystem();
  const connector = deps.connector ?? new NodePrototypeAgentConnector();
  return new PrototypeViewerAttacher({
    containers: {
      dataContainer: async (deviceId, bundleId) => {
        try {
          return await resolveOwnAppDataContainer({
            ...deps.containerOwnership,
            deviceId,
            bundleId,
            run: (args) => simctl.executeCommandArgs(args),
          });
        } catch (error) {
          if (error instanceof SimulatorContainerUnresolvedError) {
            // The attacher owns the existing missing-container guidance.
            logger.debug("Simulator returned an empty prototype viewer data container path");
            return "";
          }
          if (error instanceof SimulatorContainerOwnershipError) {
            throw error;
          }
          throw new ActionableError(
            "Could not resolve the prototype viewer data container; check that it is installed on this simulator.",
            { cause: error },
          );
        }
      },
    },
    files: {
      readText: async (path) => {
        if (!files.existsSync(path)) {
          return undefined;
        }
        try {
          return await files.readFile(path, "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            // The viewer can remove its endpoint between the existence check and read.
            logger.debug("Prototype viewer endpoint disappeared before it could be read.");
            return undefined;
          }
          throw new ActionableError(
            "Could not read the prototype viewer endpoint file; check its permissions and retry.",
            { cause: error },
          );
        }
      },
    },
    connect: async (port, token) => {
      const socket = new HandshakeReplaySocket(await connector.connect(port));
      try {
        const raw = await connectPrototypeAgent({
          port,
          token,
          connector: { connect: async () => socket },
          timer: deps.timer ?? defaultTimer,
        });
        const buffered = new BufferedViewerClient(raw);
        socket.release();
        return buffered;
      } catch (error) {
        socket.end();
        throw new ActionableError(
          "Prototype viewer authentication failed; reopen the viewer and retry.",
          { cause: error },
        );
      }
    },
    connections: deps.connections ?? prototypeViewerConnections,
  });
}
