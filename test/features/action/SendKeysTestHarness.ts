import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysTargetFocuser,
  type SendKeysFocusOptions,
  type SendKeysSelector,
  type SendKeysDependencies,
  type SendKeysObserver,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";

export const android: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
export const ios: BootedDevice = { deviceId: "ios-sim", name: "iPhone", platform: "ios" };
export const focused: ObserveResult = {
  timestamp: 1,
  viewHierarchy: {
    hierarchy: { node: { $: { focused: "true", class: "android.widget.EditText" } } },
  },
} as ObserveResult;
export const observer: SendKeysObserver = { execute: async () => focused };
export const smallCorpus = {
  nonAscii: "é",
  emoji: "😀👨‍👩‍👧",
  combining: "e\u0301",
  cjk: "日本語",
};
const commitImeId = "dev.jasonpearson.automobile.ctrlproxy/.ime.CtrlProxyIme";
const priorImeId = "com.example.keyboard/.Ime";
export type TextDelivery =
  | { kind: "insert" | "replace" | "commit"; text: string }
  | { kind: "keyevent"; text: string };

function createAdbFactory(adb: FakeAdbExecutor, deliveries: TextDelivery[]): AdbClientFactory {
  // The catalog verifies component state with argv reads after `ime set`.
  // Existing command stubs model the commit path; this adapter models the
  // installed catalog and the device's post-selection readback.
  let selectedIme: string | undefined;
  const execute = adb.execute.bind(adb);
  const catalogAdb = new Proxy(adb, {
    get(target, property, receiver) {
      if (property === "execute") {
        return async (args: string[], options?: Parameters<FakeAdbExecutor["execute"]>[1]) => {
          const result = await execute(args, options);
          const command = args.join(" ");
          if (command === "shell ime list -a -s" && !result.stdout.trim()) {
            return { ...result, stdout: `${priorImeId}\n${commitImeId}\n` };
          }
          if (command === "shell ime list -s" && !result.stdout.trim()) {
            return { ...result, stdout: `${priorImeId}\n${commitImeId}\n` };
          }
          if (command.startsWith("shell ime set ") && !result.stderr.trim()) {
            selectedIme = args[3];
          }
          if (command === "shell settings get secure default_input_method" && selectedIme) {
            return { ...result, stdout: selectedIme };
          }
          return result;
        };
      }
      if (property === "executeCommand") {
        return async (...args: Parameters<FakeAdbExecutor["executeCommand"]>) => {
          const keyEvent = args[0].match(/^shell input keyevent KEYCODE_([A-Z0-9])$/)?.[1];
          if (keyEvent) {
            deliveries.push({ kind: "keyevent", text: keyEvent.toLowerCase() });
          }
          const result = await target.executeCommand(...args);
          if (args[0].startsWith("shell ime set ") && !result.stderr.trim()) {
            selectedIme = args[0].slice("shell ime set ".length);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { create: () => catalogAdb };
}

export function createSendKeysHarness(device: BootedDevice, observe: SendKeysObserver = observer) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: priorImeId, stderr: "" },
    { stdout: commitImeId, stderr: "" },
  ]);
  const inserted: string[] = [];
  const replaced: string[] = [];
  const committed: string[] = [];
  const clientCalls: string[] = [];
  const deliveries: TextDelivery[] = [];
  const client: SendKeysTextClient = {
    insert: async (text) => {
      inserted.push(text);
      clientCalls.push(`insert:${text}`);
      deliveries.push({ kind: "insert", text });
      return { success: true };
    },
    replace: async (text) => {
      replaced.push(text);
      clientCalls.push(`replace:${text}`);
      deliveries.push({ kind: "replace", text });
      return { success: true };
    },
    clear: async () => {
      clientCalls.push("clear");
      return { success: true };
    },
    ime: async () => {
      clientCalls.push("ime");
      return { success: true };
    },
    supportsImeCommit: async () => true,
    supportsImeKeyEvents: async () => true,
    supportsKeyboardProfiles: async () => true,
    setKeyboardProfile: async () => ({ success: true, previousProfileId: "direct" }),
    commitViaIme: async (text, _prior, _signal, delivery) => {
      if (delivery === "clearField") {
        clientCalls.push("clearField");
        return { success: true };
      }
      committed.push(text);
      clientCalls.push(`commit:${text}`);
      deliveries.push({ kind: "commit", text });
      return { success: true };
    },
  };
  const adbFactory = createAdbFactory(adb, deliveries);
  return {
    adb,
    adbFactory,
    client,
    inserted,
    replaced,
    committed,
    clientCalls,
    deliveries,
    executor: new DefaultSendKeysCommandExecutor(device, adbFactory, observe, {
      timer: new FakeTimer(),
      textClient: client,
      inputKey: { press: async () => ({ success: true }) },
    }),
  };
}

/** Count both execute-owned and terminal captures, like RealObserveScreen. */
export function createSendKeysCaptureHarness(
  scenario: "focused" | "imeAction" | "fallback" | "failure" = "focused",
) {
  const h = createSendKeysHarness(android);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const events: string[] = [];
  const reads: ObserveScreenExecuteOptions[] = [];
  const captures: ObserveResult[] = [];
  const transitions = new FakeDisplayTransitionReader();
  let value = "";
  const frame = (id: string, updatedAt: number): ObserveResult => ({
    deviceId: android.deviceId,
    observationId: id,
    platform: "android",
    updatedAt,
    screenSize: { width: 100, height: 100 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    displayRevision: transitions.fullRevision,
    activeWindow: { appId: "com.example.app" },
    viewHierarchy: {
      updatedAt,
      packageName: "com.example.app",
      hierarchy: {
        node: {
          $: {
            focused: "true",
            class: "android.widget.EditText",
            text:
              scenario === "fallback"
                ? h.deliveries.map((delivery) => delivery.text).join("")
                : value,
          },
        },
      },
    },
  });
  const observer = {
    async execute(options: ObserveScreenExecuteOptions = {}) {
      reads.push(options);
      const observation = frame(`read-${reads.length}`, reads.length);
      events.push(`read:${observation.observationId}`);
      if (!options.skipScreenshot) {
        await observer.captureScreenshot(undefined, options.signal, observation);
      }
      return observation;
    },
    async captureScreenshot(_perf?: unknown, _signal?: AbortSignal, observation?: ObserveResult) {
      if (!observation) {
        throw new Error("Missing capture observation");
      }
      events.push(`capture:${observation.observationId}`);
      captures.push(observation);
      observation.screenshotCaptureAttempted = true;
      observation.screenshotPath = `${observation.observationId}.png`;
      observation.screenshotCapturedAt = 123;
    },
  };
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    events.push("commit");
    const result = await commit(...args);
    // An acknowledged commit whose read-back never changes is a typed failure.
    if (scenario !== "failure") {
      value = args[0];
    }
    return result;
  };
  h.client.ime = async () => {
    events.push("ime:done");
    return { success: true };
  };
  if (scenario === "fallback") {
    h.client.supportsImeCommit = async () => false;
  }
  const insert = h.client.insert;
  h.client.insert = async (...args) => {
    events.push("insert:fallback");
    value = args[0];
    return insert(...args);
  };
  const action = new SendKeys(android, h.adbFactory, {
    observer,
    timer,
    timestampProvider: { now: async () => 1 },
    lastRenderedObservation: () => frame("before", 0),
    displayTransitions: transitions,
    executor: new DefaultSendKeysCommandExecutor(android, h.adbFactory, observer, {
      textClient: h.client,
      inputKey: { press: async () => ({ success: true }) },
      timer,
    }),
  });
  const commands = [
    { action: "type" as const, text: "shot0" },
    ...(scenario === "imeAction" ? [{ action: "key" as const, key: "done" as const }] : []),
  ];
  const settleScreen = new FakeObserveScreen();
  const realSettle = new RealSettleObserve(settleScreen, timer);
  const settleObserve = {
    async execute(options: Parameters<RealSettleObserve["execute"]>[0]) {
      settleScreen.setObserveSequence([frame("settle-1", 20), frame("settle-2", 30)]);
      events.push("settle:start");
      const result = await realSettle.execute(options);
      events.push(`settle:chosen:${result.observation.observationId}`);
      return result;
    },
    async captureScreenshot(observation: ObserveResult, signal?: AbortSignal) {
      await observer.captureScreenshot(undefined, signal, observation);
    },
  };
  return { ...h, action, commands, observer, timer, events, reads, captures, settleObserve };
}

export function createSendKeysFocusHarness(device: BootedDevice = android) {
  const h = createSendKeysHarness(device);
  const calls: string[] = [];
  const focusCalls: Array<{
    selector: SendKeysSelector;
    signal?: AbortSignal;
    display?: string;
    options?: SendKeysFocusOptions;
  }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const replies: Array<Awaited<ReturnType<SendKeysTargetFocuser["focus"]>> | Error> = [];
  const recovery = {
    close: async () => ({ success: true }),
  };
  const transitions = new FakeDisplayTransitionReader();
  const observation: ObserveResult = {
    ...focused,
    display: { key: "0", role: "unknown", posture: "unknown", generation: transitions.generation },
    displayRevision: transitions.fullRevision,
    viewHierarchy: { ...focused.viewHierarchy!, displayId: 0 },
  };
  const insert = h.client.insert;
  h.client.insert = async (...args) => {
    calls.push("type");
    return insert(...args);
  };
  const dependencies: SendKeysDependencies = {
    timer: new FakeTimer(),
    executor: h.executor,
    observer: {
      execute: async (options) => {
        if (options?.freshness === "fresh" && options.minTimestamp === 0) {
          calls.push("refresh");
        }
        return observation;
      },
    },
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    timestampProvider: { now: async () => 1 },
    focuser: {
      focus: async (
        selector: SendKeysSelector,
        signal?: AbortSignal,
        display?: string,
        options?: SendKeysFocusOptions,
      ) => {
        calls.push("focus");
        focusCalls.push({ selector, signal, display, options });
        const reply = replies.shift() ?? { success: true, focusVerified: true };
        if (reply instanceof Error) {
          throw reply;
        }
        return reply;
      },
    },
    keyboard: {
      execute: async (_action: "close", signal?: AbortSignal) => {
        calls.push("close");
        signals.push(signal);
        return recovery.close();
      },
    },
  };
  const action = new SendKeys(device, new FakeAdbClientFactory(h.adb), dependencies);
  return {
    ...h,
    action,
    calls,
    focusCalls,
    signals,
    replies,
    recovery,
    observation,
    transitions,
  };
}
