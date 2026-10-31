import { createExecResult } from "../../src/utils/execResult";
import { warmedTests } from "../helpers/interactionCancellation";
import { expect, spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { InstalledImeKeySession } from "../../src/features/action/InstalledImeKeySession";
import { KeyboardOpenIndeterminateError } from "../../src/features/action/KeyboardOpenIndeterminateError";
import {
  type InteractionToolDependencies,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { type DeviceAwareToolHandler, ToolRegistry } from "../../src/server/toolRegistry";
import { deviceAwareHandler } from "../helpers/registeredHandler";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const interactionDeps: InteractionToolDependencies = {};
const test = warmedTests(() => ToolRegistry.clearTools());

test("registered keyboard tapImeKey forwards a pre-dispatch abort without IME switch or tap", async () => {
  const mutations: string[] = [];
  const originalRegister = ToolRegistry.registerDeviceAware.bind(ToolRegistry);
  let keyboardHandler: DeviceAwareToolHandler | undefined;
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation((...args) => {
    if (args[0] === "keyboard") {
      keyboardHandler = (device, input, progress, signal) =>
        deviceAwareHandler(args[3])(device, args[2].parse(input), progress, signal);
    }
    return originalRegister(...args);
  });
  const tapKey = spyOn(InstalledImeKeySession.prototype, "tapKey").mockImplementation(
    async (_imeId, _key, signal) => {
      signal?.throwIfAborted();
      mutations.push("switch-or-tap");
      throw new Error("Unexpected dispatch");
    },
  );
  try {
    ToolRegistry.clearTools();
    registerInteractionTools(interactionDeps);
    expect(keyboardHandler).toBeDefined();
    const controller = new AbortController();
    controller.abort();
    const device = { deviceId: "fake-keyboard", platform: "android" } as BootedDevice;
    await expect(
      keyboardHandler!(
        device,
        { action: "tapImeKey", imeId: "com.example/.Ime", key: "a" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mutations).toEqual([]);
  } finally {
    registration.mockRestore();
    tapKey.mockRestore();
    ToolRegistry.clearTools();
  }
});

test("registered keyboard setIme completes verification after cancellation follows dispatch", async () => {
  const originalRegister = ToolRegistry.registerDeviceAware.bind(ToolRegistry);
  let keyboardHandler: DeviceAwareToolHandler | undefined;
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation((...args) => {
    if (args[0] === "keyboard") {
      keyboardHandler = (device, input, progress, signal) =>
        deviceAwareHandler(args[3])(device, args[2].parse(input), progress, signal);
    }
    return originalRegister(...args);
  });
  const adb = new FakeAdbExecutor();
  const oldIme = "com.example/.OldIme";
  const newIme = "com.example/.NewIme";
  adb.setThrowOnAbortedSignal();
  adb.setCommandResponse("shell ime list -a -s", createExecResult(`${oldIme}\n${newIme}\n`, ""));
  adb.setCommandResponse("shell ime list -s", createExecResult(`${oldIme}\n${newIme}\n`, ""));
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    createExecResult(oldIme, ""),
    createExecResult(newIme, ""),
  ]);
  const controller = new AbortController();
  adb.abortAfterCommand(`shell ime set ${newIme}`, controller);
  const create = spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  try {
    ToolRegistry.clearTools();
    registerInteractionTools(interactionDeps);
    expect(keyboardHandler).toBeDefined();
    const device = { deviceId: "fake-keyboard-set-ime", platform: "android" } as BootedDevice;
    const response = await keyboardHandler!(
      device,
      { action: "setIme", imeId: newIme },
      undefined,
      controller.signal,
    );
    expect(response).toBeDefined();
    expect(controller.signal.aborted).toBe(true);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${newIme}`);
    expect(
      adb.getCommandCalls().filter((call) => call.command === "shell ime list -a -s"),
    ).toHaveLength(2);
    expect(
      adb.getCommandCalls().filter((call) => call.command === "shell ime list -s"),
    ).toHaveLength(2);
    expect(
      adb
        .getCommandCalls()
        .filter((call) => call.command === "shell settings get secure default_input_method"),
    ).toHaveLength(2);
    expect(
      adb
        .getCommandCalls()
        .slice(-3)
        .every((call) => call.signal === undefined),
    ).toBe(true);
  } finally {
    create.mockRestore();
    registration.mockRestore();
    ToolRegistry.clearTools();
  }
});

async function openKeyboardWithAbortedFailure(failure: Error) {
  const originalRegister = ToolRegistry.registerDeviceAware.bind(ToolRegistry);
  let keyboardHandler: DeviceAwareToolHandler | undefined;
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation((...args) => {
    if (args[0] === "keyboard") {
      keyboardHandler = (device, input, progress, signal) =>
        deviceAwareHandler(args[3])(device, args[2].parse(input), progress, signal);
    }
    return originalRegister(...args);
  });
  const controller = new AbortController();
  interactionDeps.keyboardFactory = () => ({
    execute: async () => {
      controller.abort();
      throw failure;
    },
  });
  try {
    ToolRegistry.clearTools();
    registerInteractionTools(interactionDeps);
    const device = { deviceId: "fake-keyboard-open", platform: "android" } as BootedDevice;
    return await keyboardHandler!(device, { action: "open" }, undefined, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    delete interactionDeps.keyboardFactory;
    registration.mockRestore();
    ToolRegistry.clearTools();
  }
}

test("registered keyboard open keeps the indeterminate error when the abort lands after a click", async () => {
  const failure = new KeyboardOpenIndeterminateError("node click", "request cancelled");
  const error = await openKeyboardWithAbortedFailure(failure);
  expect(error).toBe(failure);
});

test("registered keyboard open still reports a plain cancellation for other failures", async () => {
  const error = await openKeyboardWithAbortedFailure(new Error("adb offline"));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("cancelled");
});
