import { afterEach, beforeEach } from "bun:test";
import { setLoggerSinkForTesting, type LoggerSink } from "../../src/utils/logger";
import { FakeLogger, type LoggedMessage } from "../fakes/FakeLogger";

type Level = LoggedMessage["level"];

export interface CapturedLogs {
  readonly messages: LoggedMessage[];
  at(level: Level): LoggedMessage[];
  calls(level: Level): [message: string, ...args: unknown[]][];
  has(level: Level, substring: string): boolean;
  none(level?: Level): boolean;
  clear(): void;
}

function capturedLogs(current: () => FakeLogger): CapturedLogs {
  return {
    get messages() {
      return current().messages;
    },
    at: (level) => current().at(level),
    calls: (level) =>
      current()
        .at(level)
        .map(({ message, args }) => [message, ...args]),
    has: (level, substring) =>
      current()
        .at(level)
        .some(({ message }) => message.includes(substring)),
    none: (level) => (level === undefined ? current().messages : current().at(level)).length === 0,
    clear: () => {
      current().messages.length = 0;
    },
  };
}

/** Register at module/describe scope; each test gets a fresh, automatically restored sink. */
export function useCapturedLogs(): CapturedLogs {
  let fake: FakeLogger;
  let previous: LoggerSink | undefined;
  beforeEach(() => {
    fake = new FakeLogger();
    previous = setLoggerSinkForTesting(fake);
  });
  afterEach(() => {
    setLoggerSinkForTesting(previous);
  });
  return capturedLogs(() => fake);
}

/** Capture one operation, preserving an enclosing capture even if the operation throws. */
export async function withCapturedLogs<T>(fn: (logs: CapturedLogs) => T | Promise<T>): Promise<T> {
  const fake = new FakeLogger();
  const previous = setLoggerSinkForTesting(fake);
  try {
    return await fn(capturedLogs(() => fake));
  } finally {
    setLoggerSinkForTesting(previous);
  }
}
