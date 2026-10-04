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

export function createSendKeysHarness(device: BootedDevice) {
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
    commitViaIme: async (text) => {
      committed.push(text);
      clientCalls.push(`commit:${text}`);
      deliveries.push({ kind: "commit", text });
      return { success: true };
    },
  };
  const adbFactory = createAdbFactory(adb, deliveries);
  return {
    adb,
    client,
    inserted,
    replaced,
    committed,
    clientCalls,
    deliveries,
    executor: new DefaultSendKeysCommandExecutor(device, adbFactory, observer, {
      textClient: client,
      inputKey: { press: async () => ({ success: true }) },
    }),
  };
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
