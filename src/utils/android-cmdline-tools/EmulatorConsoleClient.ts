import { trackAmbient } from "../PerfContext";
import { ActionableError } from "../../models";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "./EmulatorConsoleBusyRegistry";
import {
  buildFingerRemoveCommand,
  buildFingerTouchCommand,
  buildGsmRadioCommand,
  buildGsmSignalCommand,
  buildNetworkDelayCommand,
  buildNetworkSpeedCommand,
  buildPostureCommand,
  buildPowerAcCommand,
  buildPowerCapacityCommand,
  buildPowerHealthCommand,
  buildPowerStatusCommand,
  buildSensorGetCommand,
  buildSensorSetCommand,
  parseSensorGetOutput,
  type ConsoleNetworkDelay,
  type ConsoleNetworkSpeed,
  type ConsolePostureVerb,
  type ConsolePowerHealth,
  type ConsolePowerStatus,
  type ConsoleRadioState,
} from "./emulatorConsoleCommands";
import { buildVmSnapshotConsoleCommand, type VmSnapshotAction } from "./vmSnapshot";
export { FileEmulatorConsoleAuthTokenReader } from "./FileEmulatorConsoleAuthTokenReader";
export { NetEmulatorConsoleTransport } from "./NetEmulatorConsoleTransport";

/**
 * High-level client for the Android emulator console protocol (telnet, port 5554+).
 * Each operation opens a fresh connection, authenticates with the token from
 * ~/.emulator_console_auth_token, sends commands, and closes.
 */
export interface EmulatorConsoleClient {
  gsmCall(phoneNumber: string): Promise<void>;
  gsmAccept(phoneNumber: string): Promise<void>;
  gsmCancel(phoneNumber: string): Promise<void>;
  gsmBusy(phoneNumber: string): Promise<void>;
  gsmHold(): Promise<void>;
  smsSend(phoneNumber: string, message: string): Promise<void>;
  geoFix(lon: number, lat: number, altitude?: number, signal?: AbortSignal): Promise<void>;
  /** `power ac on|off` — charger connected or not; no root needed. */
  powerAc(online: boolean): Promise<void>;
  /** `power status <status>` — reported charging state. */
  powerStatus(status: ConsolePowerStatus): Promise<void>;
  /** `power health <health>` — reported battery health. */
  powerHealth(health: ConsolePowerHealth): Promise<void>;
  /** `power capacity <0-100>` — reported charge level. */
  powerCapacity(percent: number): Promise<void>;
  /** `sensor set <name> <a[:b[:c]]>` — inject a sensor reading. */
  sensorSet(name: string, values: readonly number[]): Promise<void>;
  /** `sensor get <name>` — read back the current sensor value components. */
  sensorGet(name: string): Promise<number[]>;
  /** `network speed <preset|up:down>` — console-layer link shaping. */
  networkSpeed(speed: ConsoleNetworkSpeed): Promise<void>;
  /** `network delay <preset|min[:max]>` — console-layer latency. */
  networkDelay(delay: ConsoleNetworkDelay): Promise<void>;
  /** `gsm data <state>` — data-radio registration state. */
  gsmData(state: ConsoleRadioState): Promise<void>;
  /** `gsm voice <state>` — voice-radio registration state. */
  gsmVoice(state: ConsoleRadioState): Promise<void>;
  /** `gsm signal <rssi> [<ber>]` — signal strength (`99` = unknown). */
  gsmSignal(rssi: number, ber?: number): Promise<void>;
  /** `finger touch <id>` — simulate a fingerprint touch. */
  fingerTouch(fingerprintId: number): Promise<void>;
  /** `finger remove` — lift the simulated finger. */
  fingerRemove(): Promise<void>;
  /**
   * `avd snapshot save|load|del <name>`. Marks the console busy for the
   * duration so a concurrent `emu avd name` probe is not read as device loss.
   */
  avdSnapshot(action: VmSnapshotAction, snapshotName: string, signal?: AbortSignal): Promise<void>;
  /** `rotate` / `fold` / `unfold` — device posture. */
  posture(verb: ConsolePostureVerb): Promise<void>;
}

/** Console exchanges that block the emulator (snapshot save/load) need a longer deadline. */
export const AVD_SNAPSHOT_CONSOLE_TIMEOUT_MS = 30_000;

/**
 * Transport for the emulator-console TCP session. Implementations open a TCP
 * socket, perform `auth <token>` if a token is provided, send each command on
 * its own line, then send `quit` and close. The aggregated server output is
 * returned so callers can detect `KO:` failure prefixes.
 */
export interface EmulatorConsoleTransport {
  execute(
    host: string,
    port: number,
    authToken: string | null,
    commands: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<string>;
}

/**
 * Reads the emulator console auth token from disk. The token lives in
 * ~/.emulator_console_auth_token by default; if the file is missing the
 * console accepts an empty auth line.
 */
export interface EmulatorConsoleAuthTokenReader {
  read(): Promise<string | null>;
}

export type ConsoleAcknowledgementResult = { ok: true } | { ok: false; reason?: string };

/**
 * Checks that every command has a corresponding successful console response.
 * The first terminal line acknowledges the console banner, followed by an
 * optional auth response, before command responses begin.
 */
export function parseConsoleAcknowledgement(
  rawOutput: string,
  hadAuthToken: boolean,
  commandCount: number,
): ConsoleAcknowledgementResult {
  const output = rawOutput.replace(/\r\n?/g, "\n");
  type TerminalLine = { type: "ok" } | { type: "ko"; reason: string };
  const terminalLines: TerminalLine[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "OK" || line.startsWith("OK:")) {
      terminalLines.push({ type: "ok" });
    } else if (line.startsWith("KO:")) {
      terminalLines.push({ type: "ko", reason: line.slice(3).trim() });
    }
  }

  const skipCount = 1 + (hadAuthToken ? 1 : 0);
  const commandAcknowledgements = terminalLines.slice(skipCount);
  const rejected = commandAcknowledgements.find(
    (line): line is Extract<TerminalLine, { type: "ko" }> => line.type === "ko",
  );
  if (rejected) {
    return { ok: false, reason: rejected.reason };
  }

  const okCount = commandAcknowledgements.filter((line) => line.type === "ok").length;
  return okCount >= commandCount ? { ok: true } : { ok: false };
}

export function consolePortFromSerial(deviceId: string): number | null {
  const match = /^emulator-(\d+)$/.exec(deviceId);
  if (!match) {
    return null;
  }
  const port = Number.parseInt(match[1], 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function validatePhoneNumber(phoneNumber: string): string {
  const trimmed = phoneNumber.trim();
  if (!/^\+?[0-9]{1,20}$/.test(trimmed)) {
    throw new ActionableError(
      `Invalid phone number '${phoneNumber}'. Expected digits with optional leading '+' (max 20 digits).`,
    );
  }
  return trimmed;
}

export function validateSmsMessage(message: string): string {
  // Newlines would terminate the command on the wire; carriage returns and NULs would too.
  if (/[\r\n\0]/.test(message)) {
    throw new ActionableError(
      "SMS message must not contain newline, carriage return, or NUL characters.",
    );
  }
  if (message.length === 0) {
    throw new ActionableError("SMS message must not be empty.");
  }
  if (message.length > 1024) {
    throw new ActionableError(
      `SMS message must be 1024 characters or fewer (got ${message.length}).`,
    );
  }
  return message;
}

export class RealEmulatorConsoleClient implements EmulatorConsoleClient {
  constructor(
    private readonly port: number,
    private readonly transport: EmulatorConsoleTransport,
    private readonly tokenReader: EmulatorConsoleAuthTokenReader,
    private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry = defaultEmulatorConsoleBusyRegistry,
  ) {}

  private runCommands(
    commands: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<string> {
    // One span per emulator-console exchange, named by the leading verb so
    // spans aggregate (e.g. `emulator-console gsm`), recorded against the
    // ambient device-lifecycle tracker when one is in scope (see PerfContext).
    const verb = commands[0]?.split(" ")[0] ?? "";
    return trackAmbient(`emulator-console ${verb}`.trimEnd(), async () => {
      const token = await this.tokenReader.read();
      signal?.throwIfAborted();
      const output = await this.transport.execute(
        "127.0.0.1",
        this.port,
        token,
        commands,
        signal,
        timeoutMs,
      );
      const acknowledgement = parseConsoleAcknowledgement(output, token !== null, commands.length);
      if (!acknowledgement.ok && acknowledgement.reason !== undefined) {
        throw new ActionableError(`Emulator console rejected command: ${acknowledgement.reason}`);
      }
      if (!acknowledgement.ok) {
        throw new ActionableError(
          `Emulator console closed before acknowledging '${commands.join(", ")}'`,
        );
      }
      return output;
    });
  }

  /** Runs a single command whose output carries nothing beyond the acknowledgement. */
  private async runCommand(command: string, signal?: AbortSignal): Promise<void> {
    await this.runCommands([command], signal);
  }

  private async gsmCommand(
    verb: "call" | "accept" | "cancel" | "busy",
    phoneNumber: string,
  ): Promise<void> {
    const number = validatePhoneNumber(phoneNumber);
    await this.runCommands([`gsm ${verb} ${number}`]);
  }

  gsmCall(phoneNumber: string): Promise<void> {
    return this.gsmCommand("call", phoneNumber);
  }
  gsmAccept(phoneNumber: string): Promise<void> {
    return this.gsmCommand("accept", phoneNumber);
  }
  gsmCancel(phoneNumber: string): Promise<void> {
    return this.gsmCommand("cancel", phoneNumber);
  }
  gsmBusy(phoneNumber: string): Promise<void> {
    return this.gsmCommand("busy", phoneNumber);
  }

  async gsmHold(): Promise<void> {
    await this.runCommands(["gsm hold"]);
  }

  async smsSend(phoneNumber: string, message: string): Promise<void> {
    const number = validatePhoneNumber(phoneNumber);
    const safeMessage = validateSmsMessage(message);
    await this.runCommands([`sms send ${number} ${safeMessage}`]);
  }

  async geoFix(lon: number, lat: number, altitude?: number, signal?: AbortSignal): Promise<void> {
    if (
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180 ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      (altitude !== undefined && !Number.isFinite(altitude))
    ) {
      throw new ActionableError(
        "geo fix requires longitude in [-180, 180] and latitude in [-90, 90]",
      );
    }
    await this.runCommands(
      [`geo fix ${lon} ${lat}${altitude === undefined ? "" : ` ${altitude}`}`],
      signal,
    );
  }

  async powerAc(online: boolean): Promise<void> {
    await this.runCommand(buildPowerAcCommand(online));
  }

  async powerStatus(status: ConsolePowerStatus): Promise<void> {
    await this.runCommand(buildPowerStatusCommand(status));
  }

  async powerHealth(health: ConsolePowerHealth): Promise<void> {
    await this.runCommand(buildPowerHealthCommand(health));
  }

  async powerCapacity(percent: number): Promise<void> {
    await this.runCommand(buildPowerCapacityCommand(percent));
  }

  async sensorSet(name: string, values: readonly number[]): Promise<void> {
    await this.runCommand(buildSensorSetCommand(name, values));
  }

  async sensorGet(name: string): Promise<number[]> {
    const output = await this.runCommands([buildSensorGetCommand(name)]);
    return parseSensorGetOutput(name, output);
  }

  async networkSpeed(speed: ConsoleNetworkSpeed): Promise<void> {
    await this.runCommand(buildNetworkSpeedCommand(speed));
  }

  async networkDelay(delay: ConsoleNetworkDelay): Promise<void> {
    await this.runCommand(buildNetworkDelayCommand(delay));
  }

  async gsmData(state: ConsoleRadioState): Promise<void> {
    await this.runCommand(buildGsmRadioCommand("data", state));
  }

  async gsmVoice(state: ConsoleRadioState): Promise<void> {
    await this.runCommand(buildGsmRadioCommand("voice", state));
  }

  async gsmSignal(rssi: number, ber?: number): Promise<void> {
    await this.runCommand(buildGsmSignalCommand(rssi, ber));
  }

  async fingerTouch(fingerprintId: number): Promise<void> {
    await this.runCommand(buildFingerTouchCommand(fingerprintId));
  }

  async fingerRemove(): Promise<void> {
    await this.runCommand(buildFingerRemoveCommand());
  }

  async avdSnapshot(
    action: VmSnapshotAction,
    snapshotName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const command = buildVmSnapshotConsoleCommand(action, snapshotName);
    await this.consoleBusyRegistry.runExclusive(`emulator-${this.port}`, () =>
      this.runCommands([command], signal, AVD_SNAPSHOT_CONSOLE_TIMEOUT_MS),
    );
  }

  async posture(verb: ConsolePostureVerb): Promise<void> {
    await this.runCommand(buildPostureCommand(verb));
  }
}
