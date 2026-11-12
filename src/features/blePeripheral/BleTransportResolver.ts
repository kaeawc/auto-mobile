import { ActionableError } from "../../models/ActionableError";
import type { EmulatorProcessTableSource } from "../../utils/android-cmdline-tools/EmulatorProcessStop";
import {
  isEmulatorQemuProcess,
  emulatorProcessArguments,
  serialPort,
} from "../../utils/android-cmdline-tools/EmulatorProcessStop";
import { NETSIM_TRANSPORT } from "./blePeripheralSchema";
import type { EmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";

export interface BleTransportResolver {
  resolve(deviceId?: string, override?: string): Promise<string>;
}

/** Canonical `android-netsim[:localhost:<port>]`; other Bumble schemes (file:, tcp-server:, ...) are refused. */
export function parseNetsimTransport(transport: string): string {
  const match = NETSIM_TRANSPORT.exec(transport);
  const port = match?.[1] === undefined ? undefined : Number(match[1]);
  if (!match || (port !== undefined && (port < 1 || port > 65535))) {
    throw new ActionableError(
      "BLE transport must be android-netsim or android-netsim:localhost:<port> for this session's emulator.",
    );
  }
  return port === undefined ? "android-netsim" : `android-netsim:localhost:${port}`;
}

/** Read the endpoint the launcher passes to qemu, including emulators retained across daemon restarts. */
export class NetsimBleTransportResolver implements BleTransportResolver {
  constructor(
    private readonly sources: {
      processes: EmulatorProcessTableSource;
      discovery: EmulatorGrpcDiscovery;
    },
  ) {}

  async resolve(deviceId?: string, override?: string): Promise<string> {
    const requested = override === undefined ? undefined : parseNetsimTransport(override);
    const discovered = await this.discover(deviceId);
    // The override can only restate the caller's own netsim; another session's port is refused.
    if (requested !== undefined && requested !== discovered) {
      throw new ActionableError(
        `BLE transport ${override} does not belong to this session's emulator, which uses ${discovered}. Omit transport or pass ${discovered}.`,
      );
    }
    return discovered;
  }

  private async discover(deviceId?: string): Promise<string> {
    if (!deviceId) {
      return "android-netsim";
    }
    const port = serialPort(deviceId);
    if (port === undefined) {
      throw new ActionableError(
        "BLE netsim discovery requires an Android emulator serial. Use a session on an Android emulator (emulator-<port>).",
      );
    }
    const advertised = await this.sources.discovery.findByConsolePort(port);
    const table = await this.sources.processes.read({});
    if (!table.value || table.incomplete) {
      throw new ActionableError(
        "Cannot resolve this emulator's private netsimd from the host process table. Retry once the emulator is running.",
      );
    }
    const rows = table.value.filter(
      (row) =>
        isEmulatorQemuProcess(row) &&
        (advertised
          ? row.pid === advertised.pid
          : emulatorProcessArguments(row.command).port === port),
    );
    if (rows.length > 1) {
      throw new ActionableError(
        "Ambiguous emulator identity; stop duplicate emulators on this console port and retry.",
      );
    }
    if (advertised && rows.length === 0) {
      throw new ActionableError(
        "The advertised emulator could not be identified in the host process table; retry BLE start.",
      );
    }
    this.assertConsolePort(rows[0]?.command, port);
    return this.transportFromArguments(rows[0]?.command.split(/\s+/) ?? []);
  }

  private assertConsolePort(command: string | undefined, expected: number): void {
    if (!command) {
      return;
    }
    const actual = emulatorProcessArguments(command).port;
    if (actual !== undefined && actual !== expected) {
      throw new ActionableError(
        "Emulator advertisement and process console ports disagree; retry BLE discovery.",
      );
    }
  }

  private transportFromArguments(args: string[]): string {
    const endpoints = args.flatMap((arg, index) =>
      arg === "-packet-streamer-endpoint"
        ? [args[index + 1] ?? ""]
        : arg.startsWith("-packet-streamer-endpoint=")
          ? [arg.slice("-packet-streamer-endpoint=".length)]
          : [],
    );
    if (endpoints.length === 0) {
      return "android-netsim";
    }
    const endpoint = endpoints[0];
    const match = /^(?:localhost|127\.0\.0\.1):(\d+)$/.exec(endpoint);
    if (endpoints.length !== 1 || !match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      throw new ActionableError(
        "Unsupported emulator packet-streamer endpoint; restart the emulator with a localhost netsim endpoint.",
      );
    }
    return `android-netsim:localhost:${Number(match[1])}`;
  }
}
