import { expect, test } from "bun:test";
import { SendKeys, type SendKeysCommand } from "../../../src/features/action/SendKeys";
import { AUTO_MOBILE_IME_ID } from "../../../src/features/action/AndroidImeCatalog";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, observer } from "./SendKeysTestHarness";

const priorIme = "com.example.keyboard/.Ime";
const activate = `shell ime set ${AUTO_MOBILE_IME_ID}`;
const restore = `shell ime set ${priorIme}`;
const type = (text: string): SendKeysCommand => ({ action: "type", text, mode: "ime" });
let serial = 0;

function harness() {
  const device = { ...android, deviceId: `ime-span-10406-${++serial}` };
  const h = createSendKeysHarness(device);
  const timer = new FakeTimer();
  // Model selection across repeated captures, beyond the harness's two-read stub.
  let selectedIme = priorIme;
  const execute = h.adb.executeCommand.bind(h.adb);
  h.adb.executeCommand = async (...args) => {
    const result = await execute(...args);
    if (args[0].startsWith("shell ime set ") && !result.stderr.trim()) {
      selectedIme = args[0].slice("shell ime set ".length);
    }
    return args[0] === "shell settings get secure default_input_method"
      ? { ...result, stdout: selectedIme }
      : result;
  };
  const action = new SendKeys(device, h.adbFactory, {
    executor: h.executor,
    observer,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  const selections = () =>
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell ime set "));
  return { ...h, action, device, timer, selections };
}

function modelDeviceSideRestore(h: ReturnType<typeof harness>) {
  const commit = h.client.commitViaIme;
  const priors: (string | null)[] = [];
  const selectionsAtCommit: string[][] = [];
  let switchedAway = false;
  h.client.commitViaIme = async (...args) => {
    priors.push(args[1]);
    selectionsAtCommit.push(h.selections());
    if (switchedAway) {
      return { success: false, error: "IME service did not start within timeout" };
    }
    const result = await commit(...args);
    if (args[1] !== null) {
      switchedAway = true;
    }
    return result;
  };
  return { priors, selectionsAtCommit };
}

test("IME span keeps the service active for three commits and restores only at the end", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  const result = await h.action.execute([type("a"), type("b"), type("c")]);
  expect(result).toMatchObject({ success: true, completedCommands: 3 });
  expect(fake.priors).toEqual([null, null, null]);
  expect(h.committed).toEqual(["a", "b", "c"]);
  expect(fake.selectionsAtCommit).toEqual([[activate], [activate], [activate]]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("failure on command k restores once and stops subsequent commands", async () => {
  const h = harness();
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) =>
    args[0] === "b" ? { success: false, error: "commit rejected" } : commit(...args);
  const result = await h.action.execute([type("a"), type("b"), type("c")]);
  expect(result).toMatchObject({
    success: false,
    completedCommands: 1,
    failedIndex: 1,
    error: "commit rejected",
  });
  expect(result.commands).toHaveLength(2);
  expect(h.committed).toEqual(["a"]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("auto and IME key-event types leave restoration to the host", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  const result = await h.action.execute([
    { action: "type", text: "a" },
    { action: "type", text: "b", mode: "imeKeyEvents" },
    type("c"),
  ]);
  expect(result).toMatchObject({ success: true, completedCommands: 3 });
  expect(fake.priors).toEqual([null, null, null]);
  expect(h.committed).toEqual(["a", "b", "c"]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("an auto type falls back to key events before a host-restored IME commit", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  let capabilityChecks = 0;
  h.client.supportsImeCommit = async () => ++capabilityChecks > 1;
  const result = await h.action.execute([{ action: "type", text: "a" }, type("b")]);
  expect(result).toMatchObject({ success: true, completedCommands: 2 });
  expect(h.inserted).toEqual([]);
  expect(h.deliveries).toEqual([
    { kind: "keyevent", text: "a" },
    { kind: "commit", text: "b" },
  ]);
  expect(result.commands.map((command) => command.resolvedMode)).toEqual(["eventAll", "ime"]);
  expect(h.adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
  expect(h.committed).toEqual(["b"]);
  expect(fake.priors).toEqual([null]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("IME, key, IME keeps the IME active while delivering the key", async () => {
  const h = harness();
  const ime = h.client.ime;
  let selectionsAtKey: string[] = [];
  h.client.ime = async (...args) => {
    selectionsAtKey = h.selections();
    return ime(...args);
  };
  const result = await h.action.execute([type("a"), { action: "key", key: "next" }, type("b")]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "ime", "commit:b"]);
  expect(selectionsAtKey).toEqual([activate]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("IME, clear, IME keeps the IME active while clearing", async () => {
  const h = harness();
  const clear = h.client.clear;
  let selectionsAtClear: string[] = [];
  h.client.clear = async (...args) => {
    selectionsAtClear = h.selections();
    return clear(...args);
  };
  const result = await h.action.execute([type("a"), { action: "clear" }, type("b")]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "clear", "commit:b"]);
  expect(selectionsAtClear).toEqual([activate]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("non-IME typing restores before a11y delivery; a later IME type reactivates", async () => {
  const h = harness();
  const insert = h.client.insert;
  let selectionsAtInsert: string[] = [];
  h.client.insert = async (...args) => {
    selectionsAtInsert = h.selections();
    return insert(...args);
  };
  // Switching typing modes ends the active span before the non-IME command.
  const result = await h.action.execute([
    type("a"),
    { action: "type", text: "b", mode: "a11y" },
    type("c"),
  ]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "insert:b", "commit:c"]);
  expect(selectionsAtInsert).toEqual([activate, restore]);
  expect(h.selections()).toEqual([activate, restore, activate, restore]);
});

test("single IME type preserves the original complete adb command sequence", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  const result = await h.action.execute([type("x")]);
  expect(result).toMatchObject({ success: true, completedCommands: 1 });
  expect(fake.priors).toEqual([null]);
  expect(fake.selectionsAtCommit).toEqual([[activate]]);
  expect(h.selections()).toEqual([activate, restore]);
  expect(h.clientCalls).toEqual(["commit:x"]);
  expect(h.adb.getExecutedCommands()).toEqual([
    "shell settings get secure default_input_method",
    "shell ime list -s",
    "shell settings get secure selected_input_method_subtype",
    `shell ime enable ${AUTO_MOBILE_IME_ID}`,
    activate,
    "shell settings get secure default_input_method",
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    restore,
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    "shell settings delete secure selected_input_method_subtype",
    "shell settings get secure selected_input_method_subtype",
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    `shell ime disable ${AUTO_MOBILE_IME_ID}`,
    "shell ime list -s",
  ]);
});

test("direct executor type outside a span retains the device-side restore prior", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  expect(await h.executor.type(type("x"))).toMatchObject({ success: true });
  expect(fake.priors).toEqual([priorIme]);
});

test("multi-command restore failure reports original-keyboard recovery guidance", async () => {
  const h = harness();
  h.adb.setCommandError(restore, new Error("restore rejected"));
  try {
    const result = await h.action.execute([type("a"), type("b")]);
    expect(result.success).toBe(false);
    expect(h.committed).toEqual(["a", "b"]);
    expect(h.selections()).toEqual([activate, restore]);
    expect(result.error).toContain(
      "Text commit succeeded, but Could not restore the original keyboard",
    );
    expect(result.error).toContain(`keyboard setIme ${priorIme}`);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test.each([["a"], ["a", "b"]])(
  "restore failure belongs to the last IME type rather than a trailing enter key (%j)",
  async (...texts) => {
    const h = harness();
    h.adb.setCommandError(restore, new Error("restore rejected"));
    try {
      const result = await h.action.execute([...texts.map(type), { action: "key", key: "enter" }]);
      const failedIndex = texts.length - 1;
      expect(result).toMatchObject({
        success: false,
        completedCommands: texts.length,
        failedIndex,
      });
      expect(result.commands.slice(0, failedIndex).every((command) => command.success)).toBe(true);
      expect(result.commands[failedIndex]).toMatchObject({ action: "type", success: false });
      expect(result.commands[failedIndex].error).toContain("Text commit succeeded, but");
      expect(result.commands[failedIndex].error).toContain(`keyboard setIme ${priorIme}`);
      expect(result.error).toBe(result.commands[failedIndex].error);
      expect(result.commands[texts.length]).toMatchObject({
        action: "key",
        key: "enter",
        success: true,
      });
      expect(result.commands[texts.length].error).toBeUndefined();
    } finally {
      clearAndroidImeQuarantine(h.device.deviceId);
    }
  },
);

test("unbounded cancellation with a failed restore returns structured recovery guidance", async () => {
  const h = harness();
  const controller = new AbortController();
  h.adb.setCommandError(restore, new Error("restore rejected"));
  try {
    const result = await runWithAbortSignal(controller.signal, () =>
      h.action.execute(
        [type("a"), type("b"), type("c")],
        undefined,
        async (index) => {
          if (index === 2) {
            controller.abort(new Error("cancelled between commands"));
          }
        },
        controller.signal,
      ),
    );
    expect(result).toMatchObject({ success: false, completedCommands: 2, failedIndex: 2 });
    expect(result.commands).toHaveLength(2);
    expect(result.error).toContain("cancelled between commands");
    expect(result.error).toContain(`Could not restore the original keyboard ${priorIme}`);
    expect(result.error).toContain(`keyboard setIme ${priorIme}`);
    expect(h.committed).toEqual(["a", "b"]);
    expect(h.selections()).toEqual([activate, restore]);
    expect(
      await withAndroidImeLock(h.device.deviceId, async () => true, undefined, {
        allowQuarantined: true,
      }),
    ).toBe(true);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("sessionUnsafe inside a span skips restore, quarantines the device and releases the lock", async () => {
  const h = harness();
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) =>
    args[0] === "b"
      ? {
          success: false,
          sessionUnsafe: true,
          partialApplication: true,
          error: "unacknowledged commit",
        }
      : commit(...args);
  try {
    const result = await h.action.execute([type("a"), type("b"), type("c")]);
    expect(result).toMatchObject({ success: false, completedCommands: 1, failedIndex: 1 });
    expect(result.commands).toHaveLength(2);
    expect(h.committed).toEqual(["a"]);
    expect(h.selections()).toEqual([activate]);
    expect(h.adb.getExecutedCommands()).not.toContain(`shell ime disable ${AUTO_MOBILE_IME_ID}`);
    await expect(
      withAndroidImeLock(h.device.deviceId, async () => true, undefined, {
        recoverQuarantined: async (snapshot) => {
          expect(snapshot).toMatchObject({ imeId: priorIme, subtypeId: null, wasEnabled: false });
          return false;
        },
      }),
    ).rejects.toThrow("IME state is unknown after an unacknowledged cancellation");
    expect(
      await withAndroidImeLock(h.device.deviceId, async () => true, undefined, {
        allowQuarantined: true,
      }),
    ).toBe(true);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("cancellation between commands restores once outside the request context", async () => {
  const h = harness();
  const controller = new AbortController();
  const original = h.adb.executeCommand.bind(h.adb);
  let cleanupSignal: AbortSignal | undefined;
  h.adb.executeCommand = async (...args) => {
    if (args[0] === restore) {
      cleanupSignal = getAbortSignal();
    }
    return original(...args);
  };
  const cancellation = new Error("cancelled between commands");
  await expect(
    runWithAbortSignal(controller.signal, () =>
      h.action.execute(
        [type("a"), type("b"), type("c")],
        undefined,
        async (index) => {
          if (index === 2) {
            controller.abort(cancellation);
          }
        },
        controller.signal,
      ),
    ),
  ).rejects.toBe(cancellation);
  expect(h.committed).toEqual(["a", "b"]);
  expect(h.selections()).toEqual([activate, restore]);
  expect(cleanupSignal).toBeUndefined();
  expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
});

test("the device lock remains held across an interleaved key until the final restore", async () => {
  const h = harness();
  let competitor: Promise<void> | undefined;
  let commitsAtAdmission: string[] = [];
  let selectionsAtAdmission: string[] = [];
  h.client.ime = async () => {
    competitor = withAndroidImeLock(h.device.deviceId, async () => {
      commitsAtAdmission = [...h.committed];
      selectionsAtAdmission = h.selections();
    });
    return { success: true };
  };
  expect(
    (await h.action.execute([type("a"), { action: "key", key: "next" }, type("b")])).success,
  ).toBe(true);
  await competitor;
  expect(commitsAtAdmission).toEqual(["a", "b"]);
  expect(selectionsAtAdmission).toEqual([activate, restore]);
});

test("concurrent calls sharing an executor have separate serialized IME spans", async () => {
  const h = harness();
  const fake = modelDeviceSideRestore(h);
  const results = await Promise.all([
    h.action.execute([type("a"), type("b")]),
    h.action.execute([type("c"), type("d")]),
  ]);
  expect(results.map((result) => result.success)).toEqual([true, true]);
  expect(h.committed).toEqual(["a", "b", "c", "d"]);
  expect(fake.priors).toEqual([null, null, null, null]);
  expect(h.selections()).toEqual([activate, restore, activate, restore]);
});

test("budget cancellation between IME commands still reports a restore failure", async () => {
  const h = harness();
  h.adb.setCommandError(restore, new Error("restore rejected"));
  try {
    const result = await runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, () =>
      h.action.execute([type("a"), type("b"), type("c")], undefined, async (index) => {
        if (index === 2) {
          h.timer.advanceTime(99_000);
        }
      }),
    );
    expect(result.success).toBe(false);
    expect(result.completedCommands).toBe(2);
    expect(h.committed).toEqual(["a", "b"]);
    expect(h.selections()).toEqual([activate, restore]);
    expect(result.error).toContain("request budget exhausted");
    expect(result.error).toContain(`Could not restore the original keyboard ${priorIme}`);
    expect(result.error).toContain(`keyboard setIme ${priorIme}`);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("a failed restore at a mode switch stops before a11y without retrying cleanup", async () => {
  const h = harness();
  h.adb.setCommandError(restore, new Error("restore rejected"));
  try {
    const result = await h.action.execute([
      type("a"),
      { action: "type", text: "b", mode: "a11y" },
      type("c"),
    ]);
    expect(result).toMatchObject({ success: false, completedCommands: 1, failedIndex: 1 });
    expect(h.clientCalls).toEqual(["commit:a"]);
    expect(h.selections()).toEqual([activate, restore]);
    expect(result.error).toContain(`Could not restore the original keyboard ${priorIme}`);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("cancellation during a failed mode-switch restore retains recovery guidance", async () => {
  const h = harness();
  const controller = new AbortController();
  const execute = h.adb.executeCommand.bind(h.adb);
  h.adb.executeCommand = async (...args) => {
    if (args[0] === restore) {
      controller.abort(new Error("cancelled during restore"));
    }
    return execute(...args);
  };
  h.adb.setCommandError(restore, new Error("restore rejected"));
  try {
    const result = await h.action.execute(
      [type("a"), { action: "type", text: "b", mode: "a11y" }],
      undefined,
      undefined,
      controller.signal,
    );
    expect(result).toMatchObject({ success: false, completedCommands: 1, failedIndex: 1 });
    expect(h.clientCalls).toEqual(["commit:a"]);
    expect(h.selections()).toEqual([activate, restore]);
    expect(result.error).toContain(`Could not restore the original keyboard ${priorIme}`);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});
