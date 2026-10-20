import { trackAmbient } from "../PerfContext";
import { ActionableError } from "../../models";
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
}

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
  ) {}

  private runCommands(commands: string[], signal?: AbortSignal): Promise<void> {
    // One span per emulator-console exchange, named by the leading verb so
    // spans aggregate (e.g. `emulator-console gsm`), recorded against the
    // ambient device-lifecycle tracker when one is in scope (see PerfContext).
    const verb = commands[0]?.split(" ")[0] ?? "";
    return trackAmbient(`emulator-console ${verb}`.trimEnd(), async () => {
      const token = await this.tokenReader.read();
      signal?.throwIfAborted();
      const output = await this.transport.execute("127.0.0.1", this.port, token, commands, signal);
      const acknowledgement = parseConsoleAcknowledgement(output, token !== null, commands.length);
      if (!acknowledgement.ok && acknowledgement.reason !== undefined) {
        throw new ActionableError(`Emulator console rejected command: ${acknowledgement.reason}`);
      }
      if (!acknowledgement.ok) {
        throw new ActionableError(
          `Emulator console closed before acknowledging '${commands.join(", ")}'`,
        );
      }
    });
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
}
