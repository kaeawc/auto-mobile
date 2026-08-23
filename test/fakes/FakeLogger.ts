import { LogLevel, type Logger } from "../../src/utils/logger";

export interface LoggedMessage {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  args: any[];
}

/**
 * In-memory Logger fake for asserting that code emits diagnostic traces
 * without touching the filesystem. Keeps tests fast and non-flaky.
 */
export class FakeLogger implements Logger {
  readonly messages: LoggedMessage[] = [];
  private level: LogLevel = LogLevel.DEBUG;

  debug(message: string, ...args: any[]): void {
    this.messages.push({ level: "debug", message, args });
  }

  info(message: string, ...args: any[]): void {
    this.messages.push({ level: "info", message, args });
  }

  warn(message: string, ...args: any[]): void {
    this.messages.push({ level: "warn", message, args });
  }

  error(message: string, ...args: any[]): void {
    this.messages.push({ level: "error", message, args });
  }

  setLogLevel(level: LogLevel): void {
    this.level = level;
  }

  getLogLevel(): LogLevel {
    return this.level;
  }

  enableStdoutLogging(): void {}
  disableStdoutLogging(): void {}
  // Writes are synchronous in the fake, so there is nothing in flight to await.
  async flush(): Promise<void> {}
  close(): void {}
  async closeAfterFlush(): Promise<void> {}

  /** Messages emitted at the given level. */
  at(level: LoggedMessage["level"]): LoggedMessage[] {
    return this.messages.filter((m) => m.level === level);
  }
}
