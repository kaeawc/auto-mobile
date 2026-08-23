import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ActionableError } from "../../models";
import { logger } from "../logger";
import { Timer, defaultTimer } from "../SystemTimer";

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

export class FileEmulatorConsoleAuthTokenReader implements EmulatorConsoleAuthTokenReader {
  constructor(
    private readonly tokenPath: string = path.join(os.homedir(), ".emulator_console_auth_token"),
  ) {}

  async read(): Promise<string | null> {
    try {
      const content = await fs.promises.readFile(this.tokenPath, "utf-8");
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      logger.warn(
        `Failed to read emulator console auth token from ${this.tokenPath}: ${err.message}`,
      );
      return null;
    }
  }
}

const KO_REGEX = /^KO:\s*(.+)$/m;

export class NetEmulatorConsoleTransport implements EmulatorConsoleTransport {
  constructor(
    private readonly connect: (port: number, host: string) => net.Socket = net.connect,
    private readonly timeoutMs: number = 5000,
    private readonly timer: Timer = defaultTimer,
  ) {}

  execute(
    host: string,
    port: number,
    authToken: string | null,
    commands: string[],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";

      const socket = this.connect(port, host);
      socket.setEncoding("utf-8");

      const finish = (err: Error | null, output?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(output ?? buffer);
        }
      };

      const timeoutHandle = this.timer.setTimeout(
        () =>
          finish(
            new ActionableError(
              `Emulator console connection to ${host}:${port} timed out after ${this.timeoutMs}ms`,
            ),
          ),
        this.timeoutMs,
      );

      socket.on("error", (err) => {
        this.timer.clearTimeout(timeoutHandle);
        finish(
          new ActionableError(
            `Emulator console connection to ${host}:${port} failed: ${err.message}`,
          ),
        );
      });
      socket.on("close", () => {
        this.timer.clearTimeout(timeoutHandle);
        finish(null, buffer);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("connect", () => {
        const lines: string[] = [];
        if (authToken !== null) {
          lines.push(`auth ${authToken}`);
        }
        lines.push(...commands);
        lines.push("quit");
        socket.write(`${lines.join("\n")}\n`);
      });
    });
  }
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

function validateSmsMessage(message: string): string {
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

  private async runCommands(commands: string[]): Promise<void> {
    const token = await this.tokenReader.read();
    const output = await this.transport.execute("localhost", this.port, token, commands);
    const ko = KO_REGEX.exec(output);
    if (ko) {
      throw new ActionableError(`Emulator console rejected command: ${ko[1].trim()}`);
    }
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
}
