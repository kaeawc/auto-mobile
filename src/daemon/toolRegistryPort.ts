import { ActionableError } from "../models/ActionableError";
import type { DeviceReadiness } from "./readiness/DeviceReadiness";

/** The slice of a registered tool the daemon reads. */
export interface DaemonRegisteredTool {
  readonly defaultEnabled?: boolean;
  isDeviceReadOnlyCall?(args: unknown): boolean;
}

/**
 * The tool registry as the daemon sees it. The daemon owns this interface; the server's
 * `ToolRegistry` is installed once at its composition root, so the daemon never imports the
 * server tier.
 */
export interface DaemonToolRegistryPort {
  setDeviceReadiness(readiness: DeviceReadiness): void;
  isUserConfigurableTool(name: string): boolean;
  getRegisteredTool(name: string): DaemonRegisteredTool | undefined;
  callInternal(
    name: string,
    args: Record<string, unknown>,
    request: { signal: AbortSignal | undefined },
  ): Promise<unknown>;
}

let installed: DaemonToolRegistryPort | undefined;

/** Installs `port` for the daemon and returns it, so a registry can install itself where it is created. */
export function installDaemonToolRegistryPort<T extends DaemonToolRegistryPort>(port: T): T {
  installed = port;
  return port;
}

/** Fails loudly: a daemon path that needs the registry must never silently run without it. */
export function daemonToolRegistry(): DaemonToolRegistryPort {
  if (!installed) {
    throw new ActionableError(
      "The tool registry is not installed in this process. Load the server tool registry (src/server/toolRegistry) before using daemon tool dispatch.",
    );
  }
  return installed;
}
