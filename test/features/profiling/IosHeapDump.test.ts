import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IosHeapDump } from "../../../src/features/profiling/IosHeapDump";
import { MemgraphNotInspectableError } from "../../../src/features/profiling/MemgraphNotInspectableError";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { createExecResult } from "../../../src/utils/execResult";
import { findIosSimulatorAppProcessId } from "../../../src/utils/ios-cmdline-tools/IosCrashBackend";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../../fakes/FakeProfilingDevice";

const device: BootedDevice = {
  name: "iPhone Simulator",
  deviceId: "11111111-2222-3333-4444-555555555555",
  platform: "ios",
};
const appId = "com.apple.Preferences";
const request = { appId, device };
const path = "/host/tool outputs/1-heapDump-h1.memgraph";
const argv = ["9861", `--outputGraph=${path}`];

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/ios-profiling/${name}.txt`, import.meta.url), "utf8");
}

const processList = fixture("launchctl-list");
const graphWritten = fixture("leaks-output-graph-success");

function setup(size?: number) {
  const host = new FakeHostCommandExecutor();
  const files = new FakeProfilingDevice();
  const store = new FakeProfilingStore(files, "/host/tool outputs");
  const resolved: Array<{ device: BootedDevice; appId: string; signal?: AbortSignal }> = [];
  const dump = new IosHeapDump({
    host,
    idGenerator: new FakeIdGenerator(["h1"]),
    store,
    async resolvePid(device, appId, signal) {
      resolved.push({ device, appId, signal });
      return findIosSimulatorAppProcessId(processList, appId) ?? undefined;
    },
  });
  host.setCommandResponse("leaks", createExecResult(graphWritten, ""));
  if (size !== undefined) {
    files.hostFiles.set(path, size);
  }
  return { dump, host, store, resolved, files };
}

function rejectedLeaks(code: number, stderr: string, stdout = ""): Error {
  const raw = Object.assign(new Error("leaks exited"), {
    code,
    stdout,
    stderr: Buffer.from(stderr),
  });
  return wrapCommandError(raw, { command: "leaks", args: argv });
}

describe("IosHeapDump", () => {
  test("resolves Preferences from launchctl and writes a memgraph with the exact argv", async () => {
    const { dump, host, resolved, store } = setup(4096);
    const { signal } = new AbortController();

    expect(await dump.dump({ ...request, signal })).toEqual({
      path,
      sizeBytes: 4096,
      format: "memgraph",
      pid: 9861,
    });
    expect(resolved).toEqual([{ device, appId, signal }]);
    expect(host.getExecutedCalls()).toEqual([
      { command: "leaks", args: argv, options: { timeoutMs: 180_000, signal } },
    ]);
    expect(store.removed).toEqual([]);
  });

  test("asks to launch an app absent from launchctl", async () => {
    const { dump, host, store } = setup();
    await expect(dump.dump({ ...request, appId: "com.example.absent" })).rejects.toThrow(
      `com.example.absent is not running on ${device.deviceId}; launch it first.`,
    );
    expect(host.getExecutedCalls()).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  test("asks to relaunch when the process exits before leaks attaches", async () => {
    const { dump, host, store } = setup();
    host.setCommandError("leaks", rejectedLeaks(255, fixture("leaks-not-running")));
    await expect(dump.dump(request)).rejects.toThrow(
      `${appId} is not running on ${device.deviceId}; launch it first.`,
    );
    expect(store.removed).toEqual([path]);
  });

  test("reports a typed permission refusal and removes the partial graph", async () => {
    const { dump, host, store, files } = setup(64);
    host.setCommandError("leaks", rejectedLeaks(255, fixture("leaks-no-privileges")));
    const failure = dump.dump(request);
    await expect(failure).rejects.toBeInstanceOf(MemgraphNotInspectableError);
    await expect(failure).rejects.toMatchObject({ code: "heap_dump_not_inspectable" });
    expect(store.removed).toEqual([path]);
    expect(files.hostFiles.has(path)).toBe(false);
  });

  test("accepts exit 1 when leaks wrote a non-empty graph", async () => {
    const { dump, host, store } = setup(4096);
    host.setCommandError("leaks", rejectedLeaks(1, "", graphWritten));
    expect(await dump.dump(request)).toMatchObject({ path, format: "memgraph", sizeBytes: 4096 });
    expect(store.removed).toEqual([]);
  });

  test("rejects a graph when exit 1 also carries a fatal diagnostic", async () => {
    const { dump, host, store } = setup(64);
    const fatal = fixture("leaks-no-privileges")
      .split("\n")
      .find((line) => line.includes("[fatal]"));
    host.setCommandError("leaks", rejectedLeaks(1, "", fatal));
    await expect(dump.dump(request)).rejects.toThrow("mach port for process 0 not valid");
    expect(store.removed).toEqual([path]);
  });

  test.each([
    { label: "missing after exit 0", size: undefined, exitCode: 0 },
    { label: "empty after exit 0", size: 0, exitCode: 0 },
    { label: "empty after exit 1", size: 0, exitCode: 1 },
  ])("reports and removes a graph that is $label", async ({ size, exitCode }) => {
    const { dump, host, store, files } = setup(size);
    if (exitCode === 1) {
      host.setCommandError("leaks", rejectedLeaks(exitCode, ""));
    }
    const failure = dump.dump(request);
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow("No non-empty heap dump was written");
    expect(store.removed).toEqual([path]);
    expect(files.hostFiles.has(path)).toBe(false);
  });

  test("refuses a physical iPhone before resolving a PID", async () => {
    const { dump, host, resolved } = setup();
    const physical = { ...device, deviceId: "00008030-001C2D3E1234567A" };
    await expect(dump.dump({ ...request, device: physical })).rejects.toThrow(
      /physical iPhone is unsupported.*Allocations.*xctrace/,
    );
    expect(resolved).toEqual([]);
    expect(host.getExecutedCalls()).toEqual([]);
  });

  test("refuses native=true on iOS before resolving a PID", async () => {
    const { dump, host, resolved } = setup();
    await expect(dump.dump({ ...request, native: true })).rejects.toThrow(
      "native=true is only supported on Android",
    );
    expect(resolved).toEqual([]);
    expect(host.getExecutedCalls()).toEqual([]);
  });
});
