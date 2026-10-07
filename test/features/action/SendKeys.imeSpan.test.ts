import { expect, mock, spyOn, test } from "bun:test";
import {
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysCommand,
  type SendKeysObserver,
} from "../../../src/features/action/SendKeys";
import { AUTO_MOBILE_IME_ID } from "../../../src/features/action/AndroidImeCatalog";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { android, createSendKeysHarness, focused, observer } from "./SendKeysTestHarness";

const priorIme = "com.example.keyboard/.Ime";
const activate = `shell ime set ${AUTO_MOBILE_IME_ID}`;
const restore = `shell ime set ${priorIme}`;
const type = (text: string): SendKeysCommand => ({ action: "type", text, mode: "ime" });
let serial = 0;

function harness(observe: SendKeysObserver = observer, initialIme = priorIme) {
  const device = { ...android, deviceId: `ime-span-10406-${++serial}` };
  const h = createSendKeysHarness(device, observe);
  const timer = new FakeTimer();
  // Model selection across repeated captures, beyond the harness's two-read stub.
  let selectedIme = initialIme;
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
    observer: observe,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  const selections = () =>
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell ime set "));
  return { ...h, action, device, timer, selections };
}

test("IME commit verification skips full observe and performance audit", async () => {
  const fullObserve = mock(() => {});
  const audit = mock(() => {});
  const h = harness({
    execute: async (options) => {
      // Model the existing observer's expensive paths, independently of its text result.
      if (!options?.hierarchyOnly) {
        fullObserve();
      }
      if (!options?.hierarchyOnly) {
        audit();
      }
      return focused;
    },
  });
  expect(await h.executor.type(type("a"))).toMatchObject({ success: true });
  expect(fullObserve).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});

test("three IME commands perform one light verification read each", async () => {
  const reads: Parameters<SendKeysObserver["execute"]>[0][] = [];
  const verifiedCommands: number[] = [];
  const h = harness({
    execute: async (options) => {
      reads.push(options);
      if (options?.hierarchyOnly) {
        verifiedCommands.push(h.committed.length);
      }
      return {
        ...focused,
        viewHierarchy: {
          hierarchy: {
            node: {
              $: {
                focused: "true",
                class: "android.widget.EditText",
                text: h.committed.join(""),
              },
            },
          },
        },
      };
    },
  });
  expect(await h.action.execute([type("a"), type("b"), type("c")])).toMatchObject({
    success: true,
    completedCommands: 3,
  });
  // SendKeys also takes a terminal observation after the command span.
  expect(reads.filter((read) => read?.hierarchyOnly)).toHaveLength(3);
  expect(verifiedCommands).toEqual([1, 2, 3]);
});

test("light IME verification still rejects a mismatched multi-segment suffix", async () => {
  const read: SendKeysObserver = {
    execute: async () => ({
      ...focused,
      viewHierarchy: {
        hierarchy: {
          node: { $: { focused: "true", class: "android.widget.EditText", text: "one bold tai" } },
        },
      },
    }),
  };
  const h = harness(read);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const executor = new DefaultSendKeysCommandExecutor(h.device, h.adbFactory, read, {
    textClient: h.client,
    timer,
  });
  const result = await executor.type(type("one *bold* tail"));
  expect(result).toMatchObject({ success: false, partialApplication: true });
  expect(result.error).toContain('the focused field holds "one bold tai"');
  expect(timer.getSleepHistory()).toEqual([150, 150]);
});

test("real observer commit verification only captures hierarchy, never device state or audits", async () => {
  const h = harness();
  const hierarchy = {
    hierarchy: {
      node: { $: { focused: "true", class: "android.widget.EditText", text: "a" } },
    },
  };
  const capture = new FakeHierarchyCapture(() => hierarchy);
  const viewHierarchy = new FakeViewHierarchy();
  const screen = new RealObserveScreen(
    h.device,
    h.adbFactory,
    { hierarchyCapture: capture, viewHierarchy },
    h.timer,
  );
  const audit = spyOn(screen["performanceAuditor"], "run").mockResolvedValue(undefined);
  const deviceState = screen["deviceStateCollector"];
  const stateReads = [
    spyOn(deviceState, "collectForegroundSnapshot").mockResolvedValue(null),
    spyOn(deviceState, "collectWakefulness").mockResolvedValue(undefined),
    spyOn(deviceState, "collectDeviceLock").mockResolvedValue(undefined),
    spyOn(deviceState, "collectBackStack").mockResolvedValue(undefined),
    spyOn(deviceState, "collectActiveWindow").mockResolvedValue(undefined),
  ];
  try {
    const executor = new DefaultSendKeysCommandExecutor(h.device, h.adbFactory, screen, {
      textClient: h.client,
      timer: h.timer,
    });
    expect(await executor.type(type("a"))).toMatchObject({ success: true });
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.freshness).toBe("fresh");
    expect(audit).not.toHaveBeenCalled();
    for (const read of stateReads) {
      expect(read).not.toHaveBeenCalled();
    }
  } finally {
    audit.mockRestore();
    for (const read of stateReads) {
      read.mockRestore();
    }
  }
});

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

test("IME, clear, IME uses the active input connection", async () => {
  const h = harness();
  const commit = h.client.commitViaIme;
  let selectionsAtClear: string[] = [];
  h.client.commitViaIme = async (...args) => {
    if (args[3] === "clearField") {
      selectionsAtClear = h.selections();
    }
    return commit(...args);
  };
  const result = await h.action.execute([type("a"), { action: "clear" }, type("b")]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "clearField", "commit:b"]);
  expect(selectionsAtClear).toEqual([activate]);
  expect(h.selections()).toEqual([activate, restore]);
});

/** A focused field whose text follows IME commits, the IME clear and key-event deletes. */
function fieldHarness(initial = "old", attributes: Record<string, string> = {}) {
  let field = initial;
  const h = harness({
    execute: async () => ({
      ...focused,
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { focused: "true", class: "android.widget.EditText", text: field, ...attributes },
          },
        },
      },
    }),
  });
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    field = args[3] === "clearField" ? "" : field + args[0];
    return commit(...args);
  };
  const execute = h.adb.executeCommand.bind(h.adb);
  h.adb.executeCommand = async (...args) => {
    if (args[0].includes("KEYCODE_DEL")) {
      field = "";
    }
    return execute(...args);
  };
  const deletes = () =>
    h.adb.getExecutedCommands().filter((command) => command.includes("KEYCODE_DEL"));
  return { ...h, deletes, field: () => field };
}

/** IME mode must never reach the accessibility clear (ACTION_SET_TEXT) (#10408). */
function expectNoAccessibilityClear(h: ReturnType<typeof harness>) {
  expect(h.clientCalls.filter((call) => call === "clear" || call.startsWith("replace:"))).toEqual(
    [],
  );
}

test("IME span clear uses the input connection when the capability is present", async () => {
  const h = fieldHarness();
  const result = await h.action.execute([type("a"), { action: "clear" }, type("b")]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "clearField", "commit:b"]);
  expect(h.deletes()).toEqual([]);
  expectNoAccessibilityClear(h);
  expect(h.selections()).toEqual([activate, restore]);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("IME span clear on an older APK deletes with key events, never the accessibility clear", async () => {
  const h = fieldHarness();
  h.client.supportsImeClearField = async () => false;
  let selectionsAtDelete: string[] = [];
  const execute = h.adb.executeCommand.bind(h.adb);
  h.adb.executeCommand = async (...args) => {
    if (args[0].includes("KEYCODE_DEL")) {
      selectionsAtDelete = h.selections();
    }
    return execute(...args);
  };
  const result = await h.action.execute([type("a"), { action: "clear" }, type("b")]);
  expect(result.success).toBe(true);
  expect(h.clientCalls).toEqual(["commit:a", "commit:b"]);
  expect(h.deletes().length).toBeGreaterThan(0);
  expect(selectionsAtDelete).toEqual([activate]);
  expect(h.field()).toBe("b");
  expectNoAccessibilityClear(h);
  expect(h.selections()).toEqual([activate, restore]);
});

test.each(["ime", "auto", "imeKeyEvents"] as const)(
  "clear preceding %s typing deletes with key events on an older APK",
  async (mode) => {
    const h = fieldHarness();
    h.client.supportsImeClearField = async () => false;
    const result = await h.action.execute([{ action: "clear" }, { ...type("a"), mode }]);
    expect(result.success).toBe(true);
    expect(h.clientCalls).toEqual(["commit:a"]);
    expect(h.deletes().length).toBeGreaterThan(0);
    expectNoAccessibilityClear(h);
    expect(h.selections()).toEqual([activate, restore]);
  },
);

test("IME clear without the capability and without a readable length asks for an APK update", async () => {
  // An editable custom view whose text CtrlProxy cannot read leaves no deletion budget.
  const h = harness({
    execute: async () => ({
      ...focused,
      viewHierarchy: {
        hierarchy: {
          node: { $: { focused: "true", class: "com.example.RichEditor", editable: "true" } },
        },
      },
    }),
  });
  h.client.supportsImeClearField = async () => false;
  const result = await h.action.execute([{ action: "clear" }, type("a")]);
  expect(result.success).toBe(false);
  expect(result.commands[0]?.error).toContain("Update the CtrlProxy APK");
  expect(h.clientCalls).toEqual([]);
  expect(h.adb.getExecutedCommands().some((command) => command.includes("KEYCODE_"))).toBe(false);
  expect(h.selections()).toEqual([activate, restore]);
});

test.each(["ime", "auto", "imeKeyEvents"] as const)(
  "clear before a %s type activates the span IME first",
  async (mode) => {
    const h = harness();
    const calls: Parameters<typeof h.client.commitViaIme>[] = [];
    const commit = h.client.commitViaIme;
    h.client.commitViaIme = async (...args) => {
      calls.push(args);
      expect(h.selections()).toEqual([activate]);
      return commit(...args);
    };
    expect((await h.action.execute([{ action: "clear" }, { ...type("a"), mode }])).success).toBe(
      true,
    );
    expect(calls[0]).toEqual(["", null, undefined, "clearField"]);
    expect(h.clientCalls).toEqual(["clearField", "commit:a"]);
    expect(h.selections()).toEqual([activate, restore]);
  },
);

test("clear outside an IME span retains accessibility delivery", async () => {
  const h = harness();
  expect((await h.action.execute([{ action: "clear" }])).success).toBe(true);
  expect(h.clientCalls).toEqual(["clear"]);
  expect(h.selections()).toEqual([]);
});

test("IME replace clears through the input connection before typing", async () => {
  const h = harness();
  expect(
    (await h.action.execute([{ ...type("new"), operation: "replace", keyboardProfile: "direct" }]))
      .success,
  ).toBe(true);
  expect(h.clientCalls).toEqual(["clearField", "commit:new"]);
  expect(h.selections()).toEqual([activate, restore]);
});

for (const mode of ["ime", "auto", "imeKeyEvents"] as const) {
  test.each([true, false])(`%s clear capability gates ${mode} replacement`, async (supported) => {
    const h = fieldHarness();
    h.client.supportsImeClearField = async () => supported;
    const result = await h.action.execute([{ ...type("new"), mode, operation: "replace" }]);
    expect(result.success).toBe(true);
    expect(h.clientCalls).toEqual(supported ? ["clearField", "commit:new"] : ["commit:new"]);
    expect(h.deletes().length > 0).toBe(!supported);
    expect(h.field()).toBe("new");
    expectNoAccessibilityClear(h);
    expect(h.selections()).toEqual([activate, restore]);
  });
}

test.each(["clear", "replace"] as const)(
  "older-APK key-event %s failure stops subsequent IME typing",
  async (operation) => {
    const h = fieldHarness();
    h.client.supportsImeClearField = async () => false;
    const execute = h.adb.executeCommand.bind(h.adb);
    h.adb.executeCommand = async (...args) => {
      if (args[0].includes("KEYCODE_DEL")) {
        throw new Error("key event refused");
      }
      return execute(...args);
    };
    const commands: SendKeysCommand[] =
      operation === "clear"
        ? [type("a"), { action: "clear" }, type("b")]
        : [{ ...type("b"), operation: "replace" }];
    const result = await h.action.execute(commands);
    expect(result.success).toBe(false);
    expect(h.clientCalls).toEqual(operation === "clear" ? ["commit:a"] : []);
    expectNoAccessibilityClear(h);
    expect(h.selections()).toEqual([activate, restore]);
  },
);

test("cancellation during clear capability lookup does not dispatch the fallback", async () => {
  const h = harness();
  const controller = new AbortController();
  h.client.supportsImeClearField = async () => {
    controller.abort();
    return false;
  };
  await expect(
    h.action.execute(
      [{ ...type("new"), operation: "replace" }],
      undefined,
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("The operation was aborted");
  expect(h.clientCalls).toEqual([]);
  expect(h.selections()).toEqual([activate, restore]);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test.each([
  ["quote bold 123 tail", true],
  ["quote bold 13 tail", false],
] as const)(
  "multi-segment IME verification of %s preserves every content digit",
  async (actual, success) => {
    const read: SendKeysObserver = {
      execute: async () => ({
        ...focused,
        viewHierarchy: {
          hierarchy: {
            node: { $: { focused: "true", class: "android.widget.EditText", text: actual } },
          },
        },
      }),
    };
    const h = harness(read);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const executor = new DefaultSendKeysCommandExecutor(h.device, h.adbFactory, read, {
      textClient: h.client,
      timer,
    });
    const result = await executor.type(type("> quote *bold* 123 tail"));
    expect(result.success).toBe(success);
    if (!success) {
      expect(result.partialApplication).toBe(true);
    }
  },
);

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

test.each([
  ["one command", [type("a")]],
  ["a span", [type("a"), type("b")]],
] as const)(
  "%s typed while the commit IME is already the default keyboard needs no restore (#10409)",
  async (_label, commands) => {
    const h = harness(observer, AUTO_MOBILE_IME_ID);
    // Android drops a subtype the commit IME does not advertise, so a subtype restore
    // aimed at the commit IME itself could never verify.
    h.adb.setCommandResponseSequence("shell settings get secure selected_input_method_subtype", [
      { stdout: "3", stderr: "" },
      { stdout: "-1", stderr: "" },
    ]);
    try {
      const first = await h.action.execute([...commands]);
      expect(first).toMatchObject({ success: true, completedCommands: commands.length });
      // A second call proves the device was not quarantined.
      expect(await h.action.execute([type("c")])).toMatchObject({ success: true });
      const executed = h.adb.getExecutedCommands();
      expect(h.selections()).toEqual([activate, activate]);
      expect(
        executed.filter((command) => /secure selected_input_method_subtype/.test(command)),
      ).toEqual([
        "shell settings get secure selected_input_method_subtype",
        "shell settings get secure selected_input_method_subtype",
      ]);
      expect(executed).not.toContain(`shell ime disable ${AUTO_MOBILE_IME_ID}`);
    } finally {
      clearAndroidImeQuarantine(h.device.deviceId);
    }
  },
);

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

test.each(["", "hint-only"])("IME clear verifies the field after it becomes %j", async (after) => {
  let value = "old content";
  const reads: string[] = [];
  const read: SendKeysObserver = {
    execute: async () => {
      reads.push(value);
      return {
        ...focused,
        viewHierarchy: {
          hierarchy: {
            node: {
              $: {
                focused: "true",
                class: "android.widget.EditText",
                text: value,
                ...(value === "hint-only" ? { "hint-text": value } : {}),
              },
            },
          },
        },
      };
    },
  };
  const h = harness(read);
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    if (args[3] === "clearField") {
      value = after;
    } else {
      value = args[0];
    }
    return commit(...args);
  };
  const result = await h.action.execute([{ action: "clear" }, type("a")]);
  expect(result.success).toBe(true);
  expect(result.commands[0].warning).toBeUndefined();
  expect(reads.slice(0, 2)).toEqual(["old content", after]);
  expect(h.clientCalls).toEqual(["clearField", "commit:a"]);
});

test("IME clear retains unchanged-field warning with fake settling", async () => {
  const read: SendKeysObserver = {
    execute: async () => ({
      ...focused,
      viewHierarchy: {
        hierarchy: {
          node: {
            $: {
              focused: "true",
              class: "android.widget.EditText",
              text: "permanent prefix",
            },
          },
        },
      },
    }),
  };
  const h = harness(read);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const executor = new DefaultSendKeysCommandExecutor(h.device, h.adbFactory, read, {
    textClient: h.client,
    timer,
  });
  const action = new SendKeys(h.device, h.adbFactory, {
    executor,
    observer: read,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  const result = await action.execute([{ action: "clear" }, type("prefix")]);
  expect(result.success).toBe(true);
  expect(result.commands[0].warning).toContain("pre-clear text");
  expect(timer.getSleepHistory()).toEqual([150, 150]);
});

test("failed IME clear stops replace before text delivery and restores once", async () => {
  const h = harness();
  h.client.commitViaIme = async (_text, _prior, _signal, delivery) => {
    expect(delivery).toBe("clearField");
    return { success: false, partialApplication: true, error: "IME clear failed" };
  };
  expect(await h.action.execute([{ ...type("new"), operation: "replace" }])).toMatchObject({
    success: false,
    failedIndex: 0,
    error: "IME clear failed",
  });
  expect(h.committed).toEqual([]);
  expect(h.selections()).toEqual([activate, restore]);
});

test("unacknowledged IME clear quarantines the span and skips restoration", async () => {
  const h = harness();
  h.client.commitViaIme = async (_text, _prior, _signal, delivery) => {
    expect(delivery).toBe("clearField");
    return {
      success: false,
      sessionUnsafe: true,
      partialApplication: true,
      error: "clear unacknowledged",
    };
  };
  try {
    expect(await h.action.execute([{ action: "clear" }, type("a")])).toMatchObject({
      success: false,
      failedIndex: 0,
    });
    expect(h.selections()).toEqual([activate]);
    await expect(withAndroidImeLock(h.device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("IME replacement applies and restores the requested keyboard profile around clear and type", async () => {
  const h = harness();
  const profiles: string[] = [];
  h.client.setKeyboardProfile = async (id) => {
    profiles.push(id);
    return { success: true, previousProfileId: "prior-profile" };
  };
  const commit = h.client.commitViaIme;
  const profilesAtCommit: string[][] = [];
  h.client.commitViaIme = async (...args) => {
    profilesAtCommit.push([...profiles]);
    return commit(...args);
  };
  expect(
    (await h.action.execute([{ ...type("new"), operation: "replace", keyboardProfile: "direct" }]))
      .success,
  ).toBe(true);
  expect(profilesAtCommit).toEqual([["direct"], ["direct"]]);
  expect(profiles).toEqual(["direct", "prior-profile"]);
});

test("IME commit of a marked-up string stays verified when the field shows the hint it displays", async () => {
  const read: SendKeysObserver = {
    execute: async () => ({
      ...focused,
      viewHierarchy: {
        hierarchy: {
          node: {
            $: {
              focused: "true",
              class: "android.widget.EditText",
              text: "Bold",
              "hint-text": "Bold",
            },
          },
        },
      },
    }),
  };
  const h = harness(read);
  const result = await h.action.execute([type("*bold*")]);
  expect(result.success).toBe(true);
});
