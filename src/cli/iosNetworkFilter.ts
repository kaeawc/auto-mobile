import { ActionableError } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import type { NetworkFilterInstallState } from "../features/networkFilter/networkFilterApp";
import type {
  NetworkFilterHostStatus,
  NetworkFilterInstallResult,
} from "../features/networkFilter/NetworkFilterInstaller";

/**
 * Exit codes mirror `scripts/ios/build-network-filter-probe.sh activate`
 * (#6897): 0 ready, 3 approval required, 4 restart required, 1 anything else,
 * 2 usage error.
 */
export const NETWORK_FILTER_EXIT_CODES: Record<NetworkFilterInstallState, number> = {
  ready: 0,
  approval_required: 3,
  restart_required: 4,
  unavailable: 1,
  failed: 1,
};
export const NETWORK_FILTER_USAGE_EXIT_CODE = 2;

export const IOS_NETWORK_FILTER_USAGE =
  "Usage: auto-mobile --ios-network-filter install [--upgrade] | status";

export type IosNetworkFilterCommand =
  | { command: "install"; upgrade: boolean }
  | { command: "status" };

export function parseIosNetworkFilterArgs(args: string[]): IosNetworkFilterCommand {
  const [command, ...rest] = args;
  if (command === "install") {
    const unknown = rest.filter((arg) => arg !== "--upgrade");
    if (unknown.length > 0) {
      throw new ActionableError(`Unknown argument ${unknown[0]}. ${IOS_NETWORK_FILTER_USAGE}`);
    }
    return { command: "install", upgrade: rest.includes("--upgrade") };
  }
  if (command === "status" && rest.length === 0) {
    return { command: "status" };
  }
  throw new ActionableError(IOS_NETWORK_FILTER_USAGE);
}

export interface IosNetworkFilterCommandDeps {
  install(options: { upgrade: boolean }): Promise<NetworkFilterInstallResult>;
  status(): Promise<NetworkFilterHostStatus>;
  platform: NodeJS.Platform;
  write(line: string): void;
}

async function createDefaultDeps(): Promise<IosNetworkFilterCommandDeps> {
  const { NetworkFilterInstaller, NetworkFilterStatusInspector } =
    await import("../features/networkFilter/NetworkFilterInstaller");
  return {
    install: (options) => new NetworkFilterInstaller().install(options),
    status: () => new NetworkFilterStatusInspector().inspect(),
    platform: process.platform,
    write: (line) => console.log(line),
  };
}

/**
 * The explicit, opt-in host action for the iOS Network Extension (#10588).
 * Daemon-free: it never starts the daemon, opens a session or touches devices.
 * Prints one JSON line and returns the process exit code.
 */
export async function runIosNetworkFilterCommand(
  args: string[],
  deps?: IosNetworkFilterCommandDeps,
): Promise<number> {
  let parsed: IosNetworkFilterCommand;
  try {
    parsed = parseIosNetworkFilterArgs(args);
  } catch (error) {
    (deps?.write ?? console.error)(errorMessage(error));
    return NETWORK_FILTER_USAGE_EXIT_CODE;
  }
  const resolved = deps ?? (await createDefaultDeps());
  if (parsed.command === "install") {
    const result = await resolved.install({ upgrade: parsed.upgrade });
    resolved.write(JSON.stringify(result));
    return NETWORK_FILTER_EXIT_CODES[result.state];
  }
  if (resolved.platform !== "darwin") {
    resolved.write(
      JSON.stringify({
        state: "unavailable",
        detail: "The Network Extension app only runs on macOS hosts.",
      }),
    );
    return NETWORK_FILTER_EXIT_CODES.unavailable;
  }
  const status = await resolved.status();
  resolved.write(JSON.stringify(status));
  return status.report
    ? NETWORK_FILTER_EXIT_CODES[status.report.state]
    : NETWORK_FILTER_EXIT_CODES.failed;
}
