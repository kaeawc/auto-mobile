import { expect, test } from "bun:test";
import {
  isForeignRunnerError,
  launchOnFreeRunnerPort,
} from "../../../src/features/shared/RunnerPortRetry";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeRunnerPorts } from "../../fakes/FakeRunnerPorts";
import { FakeTimer } from "../../fakes/FakeTimer";

class RunnerPlatformError extends ActionableError {
  constructor(readonly errorCode: string) {
    super(`runner failed: ${errorCode}`);
  }
}

function options(overrides: {
  launch: (port: number) => Promise<string>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const ports = new FakeRunnerPorts();
  const portLog: (number | undefined)[] = [];
  return {
    ports,
    portLog,
    request: {
      deviceId: "device",
      ports,
      signal: overrides.signal ?? new AbortController().signal,
      setPort: (port: number | undefined) => portLog.push(port),
      isCurrent: overrides.isCurrent ?? (() => true),
      launch: overrides.launch,
      logTag: "[TestRunner]",
    },
  };
}

test("only invalid_runner_platform errors are foreign runners", () => {
  expect(isForeignRunnerError(new RunnerPlatformError("invalid_runner_platform"))).toBe(true);
  expect(isForeignRunnerError(new RunnerPlatformError("command_failed"))).toBe(false);
  expect(isForeignRunnerError(new Error("invalid_runner_platform"))).toBe(false);
  expect(isForeignRunnerError({ errorCode: "invalid_runner_platform" })).toBe(false);
});

test("a start aborted while a foreign runner answers quarantines the port without retrying", async () => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  const launches: number[] = [];
  const f = options({
    signal: controller.signal,
    launch: async (port) => {
      launches.push(port);
      await timer.sleep(100);
      throw new RunnerPlatformError("invalid_runner_platform");
    },
  });
  const started = launchOnFreeRunnerPort(f.request);
  controller.abort();
  timer.advanceTime(100);
  await expect(started).rejects.toThrow("invalid_runner_platform");
  expect(launches).toEqual([8765]);
  expect(f.ports.events).toEqual(["allocate 8765", "quarantine 8765"]);
  // The caller's cleanup still owns the allocated port.
  expect(f.portLog).toEqual([8765]);
});

test("a superseded start is not retried on another port", async () => {
  const launches: number[] = [];
  const f = options({
    isCurrent: () => false,
    launch: async (port) => {
      launches.push(port);
      throw new RunnerPlatformError("invalid_runner_platform");
    },
  });
  await expect(launchOnFreeRunnerPort(f.request)).rejects.toThrow("invalid_runner_platform");
  expect(launches).toEqual([8765]);
});

test("ports without quarantine still move to the next free port", async () => {
  const released: number[] = [];
  let next = 9000;
  const result = await launchOnFreeRunnerPort({
    deviceId: "device",
    ports: { allocate: () => next++, release: (_id, port) => released.push(port) },
    signal: new AbortController().signal,
    setPort: () => {},
    isCurrent: () => true,
    launch: async (port) => {
      if (port === 9000) {
        throw new RunnerPlatformError("invalid_runner_platform");
      }
      return `runner on ${port}`;
    },
    logTag: "[TestRunner]",
  });
  expect(result).toBe("runner on 9001");
  expect(released).toEqual([9000]);
});
