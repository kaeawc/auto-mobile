import path from "node:path";
import { errorMessage } from "../../../models/describeUnknownError";
import type { FileSystem } from "../../filesystem/DefaultFileSystem";
import { logger } from "../../logger";
import { isProcessRunning } from "../../processLiveness";
import { defaultRunningAvdAdvertisementDirs } from "../RunningAvdAdvertisementReader";

/**
 * Each running emulator advertises itself in `<dir>/avd/running/pid_<pid>.ini` with its console
 * port (`port.serial`), its gRPC port, and how to authenticate. The directories are the ones
 * {@link defaultRunningAvdAdvertisementDirs} resolves for the launch guard.
 */

export type EmulatorGrpcAuth =
  | { kind: "token"; token: string }
  | { kind: "jwt"; jwksDir: string; activeJwksFile: string }
  | { kind: "none" };

export interface EmulatorGrpcEndpoint {
  pid: number;
  consolePort: number;
  /** `host:port` the gRPC server listens on. */
  address: string;
  auth: EmulatorGrpcAuth;
  descriptionFile: string;
}

const DEFAULT_GRPC_PORT = 8554;
const PID_FILE = /^pid_(\d+)\.ini$/;

/** `key=value` lines; the first `=` splits, so values may contain `=`. */
export function parseDiscoveryIni(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const split = line.indexOf("=");
    if (split > 0) {
      entries[line.slice(0, split)] = line.slice(split + 1);
    }
  }
  return entries;
}

function authFrom(ini: Record<string, string>): EmulatorGrpcAuth {
  if (ini["grpc.token"]) {
    return { kind: "token", token: ini["grpc.token"] };
  }
  if (ini["grpc.jwks"] && ini["grpc.jwk_active"]) {
    return { kind: "jwt", jwksDir: ini["grpc.jwks"], activeJwksFile: ini["grpc.jwk_active"] };
  }
  return { kind: "none" };
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export function endpointFromDescription(
  pid: number,
  descriptionFile: string,
  ini: Record<string, string>,
): EmulatorGrpcEndpoint | undefined {
  const consolePort = parsePort(ini["port.serial"]);
  if (consolePort === undefined) {
    return undefined;
  }
  const address =
    ini["grpc.address"] || `localhost:${parsePort(ini["grpc.port"]) ?? DEFAULT_GRPC_PORT}`;
  return { pid, consolePort, address, auth: authFrom(ini), descriptionFile };
}

export interface EmulatorGrpcDiscovery {
  /** The endpoint of the emulator whose console port is `consolePort` (5554 for emulator-5554). */
  findByConsolePort(consolePort: number): Promise<EmulatorGrpcEndpoint | undefined>;
}

export class FileEmulatorGrpcDiscovery implements EmulatorGrpcDiscovery {
  constructor(
    private readonly fs: Pick<FileSystem, "readdir" | "readFile">,
    private readonly runningDirs: readonly string[] = defaultRunningAvdAdvertisementDirs(),
    /** A crashed emulator leaves its file behind, and a later emulator may reuse its port. */
    private readonly isAlive: (pid: number) => boolean = (pid) => isProcessRunning(pid),
  ) {}

  async findByConsolePort(consolePort: number): Promise<EmulatorGrpcEndpoint | undefined> {
    for (const dir of this.runningDirs) {
      for (const file of await this.listDescriptionFiles(dir)) {
        const endpoint = await this.readEndpoint(dir, file);
        if (endpoint?.consolePort === consolePort && this.isAlive(endpoint.pid)) {
          return endpoint;
        }
      }
    }
    return undefined;
  }

  private async listDescriptionFiles(dir: string): Promise<string[]> {
    try {
      return (await this.fs.readdir(dir)).filter((name) => PID_FILE.test(name)).sort();
    } catch (error) {
      // Most candidate directories do not exist on a given host.
      logger.debug(`emulator discovery dir ${dir} unreadable: ${errorMessage(error)}`);
      return [];
    }
  }

  private async readEndpoint(dir: string, file: string): Promise<EmulatorGrpcEndpoint | undefined> {
    const descriptionFile = path.join(dir, file);
    try {
      const pid = Number.parseInt(PID_FILE.exec(file)?.[1] ?? "", 10);
      return endpointFromDescription(
        pid,
        descriptionFile,
        parseDiscoveryIni(await this.fs.readFile(descriptionFile)),
      );
    } catch (error) {
      // An emulator that is exiting removes its file between the listing and the read.
      logger.debug(`emulator discovery file ${descriptionFile} unreadable: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
