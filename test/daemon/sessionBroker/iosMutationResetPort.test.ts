import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SIMCTL_PRIVACY_TCC_SERVICES,
  type TccPermissionRow,
} from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import type { ExecResult } from "../../../src/models/ExecResult";
import {
  IosDeviceMutationResetPort,
  IOS_UNOBSERVABLE_BASELINE_REASONS,
} from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import {
  DEVICE_MUTATION_KINDS,
  type DeviceBaseline,
  type DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import {
  captureFirstDeviceBaseline,
  type DeviceMutationResetContext,
} from "../../../src/daemon/sessionBroker/mutations/reset";
import { FakeTimer } from "../../fakes/FakeTimer";
import { parseSimctlListApps } from "../../../src/utils/ios-cmdline-tools/simctlListApps";
import { diffDeviceBaseline } from "../../../src/daemon/sessionBroker/mutations/baseline";
import { planDeviceMutationRevert } from "../../../src/daemon/sessionBroker/mutations/revertPlanner";
import { IosKeepBootedReset } from "../../../src/daemon/sessionBroker/iosKeepBootedReset";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";

const GLOBALS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>AppleLocale</key><string>en_US</string>
<key>AppleLanguages</key><array><string>en-US</string><string>fr-CA</string></array>
<key>AppleICUForce24HourTime</key><false/>
</dict></plist>`;

const UDID = "11111111-2222-4333-8444-555555555555";
const GROUP = `/Users/runner/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Shared/AppGroup/77777777-8888-4999-aaaa-bbbbbbbbbbbb`;
function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}

function harness() {
  const timer = new FakeTimer();
  const state = {
    owned: true,
    privacyRows: [] as (TccPermissionRow[] | Error)[],
    privacyReads: [] as { deviceId: string; services: readonly string[]; signal?: AbortSignal }[],
    phases: [] as { phase: string; durationMs: number }[],
    groups: { "group.probe": GROUP } as Record<string, string>,
    appInventory: { "probe.app": { CFBundleVersion: "1", ApplicationType: "User" } } as Record<
      string,
      Record<string, string>
    > | null,
    removed: [] as string[],
    commands: [] as string[][],
    clipboard: [] as string[],
    error: undefined as Error | undefined,
    terminateError: undefined as Error | undefined,
    baselineGroups: {} as Record<string, string>,
    groupsOutput: undefined as string | undefined,
    realPath: GROUP,
    ui: { appearance: "light", content_size: "large", increase_contrast: "disabled" } as Record<
      string,
      string
    >,
    globals: GLOBALS,
    commandErrors: new Map<string, Error>(),
    commandResults: new Map<string, ExecResult>(),
    resetState: {
      keychain: "secret",
      privacy: "granted",
      location: "route",
      status_bar: "override",
    } as Record<string, string | undefined>,
    pasteboardTypes: ["public.png"],
    pasteboardError: undefined as Error | undefined,
  };
  const context: DeviceMutationResetContext = {
    baseline: { completeKinds: ["installed-app"], observations: [], unobservable: [] },
    scope: { deviceId: UDID, incarnation: "generation-1", sessionUuid: "session-a" },
    signal: new AbortController().signal,
    recordPhase: (phase, durationMs) => {
      state.phases.push({ phase, durationMs });
    },
    assertOwned: async () => {
      if (!state.owned) {
        throw new Error("Ownership lost");
      }
    },
  };
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: async (_deviceId, options) => {
          options?.signal?.throwIfAborted();
          if (state.error) {
            throw state.error;
          }
          if (state.appInventory === null) {
            throw new Error("Invalid app inventory");
          }
          return parseSimctlListApps(JSON.stringify(state.appInventory));
        },
        executeCommandArgs: async (args, _timeout, signal) => {
          signal?.throwIfAborted();
          state.commands.push(args);
          timer.advanceTime(1);
          if (state.error) {
            throw state.error;
          }
          const failure = state.commandErrors.get(args.join(" "));
          if (failure) {
            throw failure;
          }
          const output = state.commandResults.get(args.join(" "));
          if (output) {
            return output;
          }
          if (args[0] === "terminate" && state.terminateError) {
            throw state.terminateError;
          }
          if (args[0] === "uninstall" && state.appInventory) {
            delete state.appInventory[args[2]];
          }
          if (args[0] === "ui") {
            if (args.length === 4) {
              state.ui[args[2]] = args[3];
              return result("");
            }
            return result(`${state.ui[args[2]]}\n`);
          }
          if (args[0] === "spawn" && args[3] === "export") {
            return result(state.globals);
          }
          if (args[0] in state.resetState) {
            state.resetState[args[0]] = undefined;
          }
          return result(
            args[0] === "listapps"
              ? JSON.stringify(state.appInventory)
              : args[0] === "get_app_container"
                ? (state.groupsOutput ??
                  Object.entries(args[2] === "baseline.app" ? state.baselineGroups : state.groups)
                    .map(([groupId, path]) => `${groupId}\t${path}`)
                    .join("\n"))
                : args[0] === "pbpaste"
                  ? "pasteboard"
                  : "",
          );
        },
      },
      privacyGrants: {
        readServiceRows: async (deviceId, services, signal) => {
          state.privacyReads.push({ deviceId, services, signal });
          timer.advanceTime(2);
          const rows = state.privacyRows.shift() ?? [];
          if (rows instanceof Error) {
            throw rows;
          }
          return rows;
        },
      },
      files: {
        realpath: async (path) => {
          if (state.removed.includes(path)) {
            throw Object.assign(new Error("Already removed"), { code: "ENOENT" });
          }
          return state.realPath;
        },
        remove: async (path) => {
          if (state.removed.includes(path)) {
            throw Object.assign(new Error("Already removed"), { code: "ENOENT" });
          }
          state.removed.push(path);
        },
      },
      pasteboard: {
        assertSettled: () => {},
        write: async (_device, text, signal) => {
          signal.throwIfAborted();
          if (state.pasteboardError) {
            throw state.pasteboardError;
          }
          state.pasteboardTypes = ["public.utf8-plain-text"];
          state.clipboard.push(text);
        },
      },
    },
    timer,
  );
  const revert = (
    kind: string,
    key = "device",
    priorValue: DeviceMutationInput["priorValue"] = { state: "absent" },
  ) => port.revert({ kind, key, priorValue, toolName: "test" }, context);
  return { port, context, state, revert };
}

describe("iOS mutation reset adapter", () => {
  test.each([
    { kind: "clipboard", key: "device" },
    { kind: "device-setting", key: "appearance" },
    { kind: "device-setting", key: "locale" },
    { kind: "preference", key: "probe.app:secret" },
  ])("$kind:$key cannot revert an unobservable prior", async ({ kind, key }) => {
    const rig = harness();
    const mutation: DeviceMutationInput = {
      kind,
      key,
      priorValue: { state: "unobservable" },
      toolName: "test",
    };
    expect(rig.port.canRevert(mutation)).toBe(false);
    await expect(rig.port.revert(mutation, rig.context)).rejects.toThrow(
      "Unsupported iOS reset mutation",
    );
    expect(rig.state.commands).toEqual([]);
    expect(rig.state.clipboard).toEqual([]);
    expect(rig.state.removed).toEqual([]);
  });

  test("installed session apps terminate, clear exact app-group containers, then uninstall", async () => {
    const rig = harness();
    await rig.revert("installed-app", "probe.app");
    expect(rig.state.commands).toEqual([
      ["terminate", UDID, "probe.app"],
      ["get_app_container", UDID, "probe.app", "groups"],
      ["uninstall", UDID, "probe.app"],
    ]);
    expect(rig.state.removed).toEqual([GROUP]);
  });

  test("native reset steps report individual terminate, uninstall, keychain and privacy phases", async () => {
    const rig = harness();
    const phases: Record<string, number> = {};
    rig.context.recordPhase = (phase, durationMs) => {
      phases[phase] = (phases[phase] ?? 0) + durationMs;
    };
    await rig.revert("installed-app", "probe.app");
    rig.state.appInventory = {};
    await rig.port.sanitize(rig.context);
    expect(phases).toMatchObject({
      "simctl:terminate": 1,
      "simctl:get_app_container": 1,
      "app-group-remove": 0,
      "simctl:uninstall": 1,
      "simctl:keychain": 1,
      "simctl:privacy": 1,
      "simctl:location": 1,
      "simctl:status_bar": 1,
      "simctl:pbcopy": 0,
      "simctl:ui:appearance": 1,
      "simctl:ui:content_size": 1,
      "simctl:ui:increase_contrast": 1,
      "simctl:spawn:defaults:delete:.GlobalPreferences:AppleLocale": 1,
    });
  });

  test("supported journal kinds map to exact simctl reverts and unsupported kinds fail closed", async () => {
    const cases: Array<{
      kind: string;
      key?: string;
      value?: DeviceMutationInput["priorValue"];
      args?: string[];
    }> = [
      { kind: "keychain", args: ["keychain", UDID, "reset"] },
      {
        kind: "permission",
        key: "probe.app",
        args: ["privacy", UDID, "reset", "all", "probe.app"],
      },
      { kind: "location", args: ["location", UDID, "clear"] },
      { kind: "status-bar", args: ["status_bar", UDID, "clear"] },
      { kind: "clipboard" },
      {
        kind: "app-group",
        key: "probe.app",
        args: ["get_app_container", UDID, "probe.app", "groups"],
      },
      {
        kind: "device-setting",
        key: "increase-contrast",
        value: { state: "present", value: "enabled" },
        args: ["ui", UDID, "increase_contrast", "enabled"],
      },
      {
        kind: "device-setting",
        key: "appearance",
        value: { state: "present", value: "dark" },
        args: ["ui", UDID, "appearance", "dark"],
      },
      {
        kind: "device-setting",
        key: "content-size",
        value: { state: "present", value: "large" },
        args: ["ui", UDID, "content_size", "large"],
      },
      {
        kind: "device-setting",
        key: "locale",
        value: { state: "present", value: "en_US" },
        args: [
          "spawn",
          UDID,
          "defaults",
          "write",
          ".GlobalPreferences",
          "AppleLocale",
          "-string",
          "en_US",
        ],
      },
      {
        kind: "device-setting",
        key: "language",
        value: { state: "present", value: ["en"] },
        args: [
          "spawn",
          UDID,
          "defaults",
          "write",
          ".GlobalPreferences",
          "AppleLanguages",
          "-array",
          "en",
        ],
      },
      {
        kind: "preference",
        key: "probe.app:secret",
        args: ["spawn", UDID, "defaults", "delete", "probe.app", "secret"],
      },
    ];
    cases.push({
      kind: "device-setting",
      key: "nightMode",
      value: { state: "present", value: "light" },
      args: ["ui", UDID, "appearance", "light"],
    });
    for (const entry of cases) {
      const rig = harness();
      await rig.revert(entry.kind, entry.key, entry.value);
      if (entry.args) {
        expect(rig.state.commands).toContainEqual(entry.args);
      }
      if (entry.kind === "clipboard") {
        expect(rig.state.clipboard).toEqual([""]);
      }
    }
    for (const kind of [
      ...DEVICE_MUTATION_KINDS.filter(
        (kind) => !cases.some((entry) => entry.kind === kind) && kind !== "installed-app",
      ),
      "unknown",
    ]) {
      const rig = harness();
      expect(
        rig.port.canRevert({
          kind,
          key: "device",
          priorValue: { state: "absent" },
          toolName: "test",
        }),
      ).toBe(false);
      await expect(rig.revert(kind)).rejects.toThrow("Unsupported iOS reset mutation");
      expect(rig.state.commands).toEqual([]);
    }
  });

  test("nonempty keychain, existing apps, granted permissions and unsupported settings cannot be restored destructively", () => {
    const rig = harness();
    for (const kind of [
      "installed-app",
      "app-group",
      "keychain",
      "permission",
      "location",
      "status-bar",
      "device-setting",
    ]) {
      expect(
        rig.port.canRevert({
          kind,
          key: "device",
          priorValue: { state: "present", value: "original" },
          toolName: "test",
        }),
      ).toBe(false);
    }
  });

  test("baseline capture only observes apps and settings, without destructive resets", async () => {
    const rig = harness();
    rig.context.baseline = undefined;
    const baseline = await rig.port.capture(rig.context);
    expect(baseline.completeKinds).toEqual(["installed-app", "device-setting"]);
    expect(baseline.unobservable).toEqual(
      DEVICE_MUTATION_KINDS.filter((kind) => !baseline.completeKinds.includes(kind)),
    );
    expect(baseline.observations).toContainEqual({
      kind: "device-setting",
      key: "language",
      value: { state: "present", value: ["en-US", "fr-CA"] },
    });
    expect(baseline.observations).toContainEqual({
      kind: "device-setting",
      key: "calendarSystem",
      value: { state: "absent" },
    });
    expect(rig.state.commands).toEqual([
      ["ui", UDID, "appearance"],
      ["ui", UDID, "content_size"],
      ["ui", UDID, "increase_contrast"],
      ["spawn", UDID, "defaults", "export", "-g", "-"],
    ]);
    expect(rig.state.clipboard).toEqual([]);
    expect(Object.values(rig.state.resetState)).toEqual(["secret", "granted", "route", "override"]);
    expect(rig.state.pasteboardTypes).toEqual(["public.png"]);
    expect(
      Object.keys(IOS_UNOBSERVABLE_BASELINE_REASONS).every((kind) =>
        baseline.unobservable.includes(kind),
      ),
    ).toBe(true);
  });

  test.each(["absent", "unobservable"] as const)(
    "native partial baseline plus an unsupported Photos entry with %s prior reaches keep-booted clean",
    async (state) => {
      const rig = harness();
      rig.state.appInventory = { "baseline.app": { ApplicationType: "User" } };
      const journal = new FakeDeviceMutationJournal(new FakeTimer());
      await journal.captureBaseline(rig.context.scope, await rig.port.capture(rig.context));
      await journal.record(rig.context.scope, {
        kind: "media",
        key: "photo",
        priorValue: { state },
        toolName: "media",
      });
      rig.state.appInventory = {
        "baseline.app": { ApplicationType: "User" },
        "probe.app": { ApplicationType: "User" },
      };
      rig.state.ui.appearance = "dark";
      let eraseCalls = 0;
      const profile = {
        platform: "ios",
        metadataState: "current",
        simulatorDeviceTypeIdentifier: "iphone",
        archetype: "phone",
        modelType: { family: "iphone", variant: "pro" },
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        osVersion: "27",
        compatibility: "supported",
      } as const;
      const reset = new IosKeepBootedReset({
        journal,
        mutations: rig.port,
        timer: new FakeTimer(),
        maxUses: 20,
        simctl: {
          readSimulatorTarget: async () => ({
            udid: UDID,
            name: "phone",
            state: "Booted",
            isAvailable: true,
            deviceTypeIdentifier: profile.simulatorDeviceTypeIdentifier,
            runtime: profile.runtimeId,
            os_version: "27.0",
          }),
        },
        health: { probe: async () => true },
        erase: {
          resetWithTiming: async () => {
            eraseCalls++;
            return { outcome: "clean", mode: "erase", phases: {} };
          },
        },
      });
      expect(
        await reset.resetWithTiming(
          { deviceId: UDID, platform: "ios", name: "phone" },
          profile,
          rig.context.assertOwned,
          rig.context.scope,
          0,
        ),
      ).toMatchObject({
        outcome: "clean",
        mode: "keep-booted",
        phases: {
          "app-inventory": 0,
          "simctl:keychain": 1,
          "simctl:ui:appearance": 1,
          "health-probe": 0,
        },
      });
      expect(eraseCalls).toBe(0);
      expect(rig.state.commands).toContainEqual(["uninstall", UDID, "probe.app"]);
      expect(rig.state.removed).toEqual([GROUP]);
      expect(rig.state.ui.appearance).toBe("light");
      expect(await journal.list(rig.context.scope)).toEqual([]);
    },
  );

  test("old incomplete baselines do not acquire destructive default certification", async () => {
    const rig = harness();
    const baseline = await rig.port.capture(rig.context);
    expect(baseline.completeKinds).toEqual(["installed-app", "device-setting"]);
    expect(rig.state.commands.every((args) => ["ui", "spawn"].includes(args[0]))).toBe(true);
    expect(rig.state.clipboard).toEqual([]);
  });

  test("nondefault, missing, duplicate and contradictory baseline states never gate sanitation", async () => {
    for (const kind of ["keychain", "permission", "location", "status-bar", "clipboard"]) {
      for (const invalid of ["nondefault", "missing", "duplicate", "contradictory"]) {
        const rig = harness();
        const observation = { kind, key: "device", value: { state: "absent" as const } };
        const baseline: DeviceBaseline = {
          completeKinds: ["installed-app", kind],
          observations: [observation],
          unobservable: [],
        };
        if (invalid === "nondefault") {
          baseline.observations = [
            { kind, key: "device", value: { state: "present", value: "existing state" } },
          ];
        } else if (invalid === "missing") {
          baseline.observations = baseline.observations.filter((entry) => entry.kind !== kind);
        } else if (invalid === "duplicate") {
          baseline.observations.push(observation);
        } else {
          baseline.unobservable.push(kind);
        }
        rig.context.baseline = baseline;
        rig.state.commands = [];
        rig.state.clipboard = [];
        await rig.port.sanitize(rig.context);
        const command = {
          keychain: "keychain",
          permission: "privacy",
          location: "location",
          "status-bar": "status_bar",
          clipboard: "pbcopy",
        }[kind];
        expect(rig.state.commands.some((args) => args[0] === command)).toBe(kind !== "clipboard");
        if (kind === "clipboard") {
          expect(rig.state.clipboard).toEqual([""]);
        }
      }
    }
  });

  test("unknown, unsupported and malformed UI output never yields complete settings", async () => {
    for (const operation of ["appearance", "content_size", "increase_contrast"]) {
      for (const output of ["unknown", "unsupported", "", "large\nlight"]) {
        const rig = harness();
        rig.context.baseline = undefined;
        rig.state.ui[operation] = output;
        const baseline = await rig.port.capture(rig.context);
        expect(baseline.unobservable).toContain("device-setting");
        expect(baseline.observations.some((entry) => entry.kind === "device-setting")).toBe(false);
        expect(baseline.completeKinds).toContain("installed-app");
        expect(baseline.completeKinds).not.toContain("clipboard");
      }
    }
  });

  test("malformed defaults exports fail settings closed without discarding app coverage", async () => {
    for (const globals of [
      "",
      "(en, fr)",
      "<plist><array><string>en</string></array></plist>",
      "<plist><dict><key>AppleLanguages</key><string>en</string></dict></plist>",
    ]) {
      const rig = harness();
      rig.state.globals = globals;
      const baseline = await rig.port.capture(rig.context);
      expect(baseline.completeKinds).toEqual(["installed-app"]);
      expect(baseline.unobservable).toContain("device-setting");
    }
  });

  test("sanitation resets a surviving preinstalled Safari privacy grant after the global reset", async () => {
    const rig = harness();
    rig.state.privacyRows.push(
      [{ service: "kTCCServiceAddressBook", client: "com.apple.mobilesafari", auth_value: 2 }],
      [],
    );
    await expect(rig.port.sanitize(rig.context)).resolves.toBeUndefined();
    const privacyCommands = rig.state.commands.filter((args) => args[0] === "privacy");
    expect(privacyCommands).toEqual([
      ["privacy", UDID, "reset", "all"],
      ["privacy", UDID, "reset", "all", "com.apple.mobilesafari"],
    ]);
    expect(rig.state.privacyReads).toEqual([
      { deviceId: UDID, services: SIMCTL_PRIVACY_TCC_SERVICES, signal: rig.context.signal },
      { deviceId: UDID, services: SIMCTL_PRIVACY_TCC_SERVICES, signal: rig.context.signal },
    ]);
    expect(rig.state.phases).toContainEqual({ phase: "tcc:privacy-verify", durationMs: 2 });
  });

  test("sanitation rejects a privacy grant that survives the per-bundle reset", async () => {
    const rig = harness();
    const rows = [
      { service: "kTCCServiceAddressBook", client: "com.apple.mobilesafari", auth_value: 2 },
    ];
    rig.state.privacyRows.push(rows, rows);
    await expect(rig.port.sanitize(rig.context)).rejects.toThrow(
      "iOS privacy grants survived reset: kTCCServiceAddressBook:com.apple.mobilesafari",
    );
    expect(rig.state.privacyReads).toHaveLength(2);
    expect(rig.state.commands.some((args) => args[0] === "ui")).toBe(false);
  });

  test("sanitation reads an empty privacy baseline exactly once without per-bundle resets", async () => {
    const rig = harness();
    await rig.port.sanitize(rig.context);
    expect(rig.state.privacyReads).toHaveLength(1);
    expect(rig.state.commands.filter((args) => args[0] === "privacy")).toEqual([
      ["privacy", UDID, "reset", "all"],
    ]);
  });

  test.each([false, true])(
    "sanitation rejects a failed privacy read (recheck: %s)",
    async (recheck) => {
      const rig = harness();
      if (recheck) {
        rig.state.privacyRows.push([
          { service: "kTCCServiceAddressBook", client: "com.apple.mobilesafari", auth_value: 2 },
        ]);
      }
      rig.state.privacyRows.push(new Error("TCC unreadable"));
      await expect(rig.port.sanitize(rig.context)).rejects.toThrow(
        "iOS privacy grant verification failed: TCC unreadable",
      );
      expect(rig.state.phases).toContainEqual({ phase: "tcc:privacy-verify", durationMs: 2 });
    },
  );

  test("sanitation resets distinct privacy clients in ascending order regardless of authorization value", async () => {
    const rig = harness();
    rig.state.privacyRows.push(
      [
        { service: "kTCCServicePhotos", client: "z.app", auth_value: 0 },
        { service: "kTCCServiceAddressBook", client: "a.app", auth_value: 2 },
        { service: "kTCCServiceCamera", client: "z.app", auth_value: 2 },
      ],
      [],
    );
    await rig.port.sanitize(rig.context);
    expect(rig.state.commands.filter((args) => args[0] === "privacy")).toEqual([
      ["privacy", UDID, "reset", "all"],
      ["privacy", UDID, "reset", "all", "a.app"],
      ["privacy", UDID, "reset", "all", "z.app"],
    ]);
  });

  test("failed unconditional resets propagate instead of reporting successful sanitation", async () => {
    for (const command of ["keychain", "privacy", "location", "status_bar"]) {
      const rig = harness();
      const args =
        command === "privacy"
          ? [command, UDID, "reset", "all"]
          : [command, UDID, command === "keychain" ? "reset" : "clear"];
      rig.state.commandResults.set(args.join(" "), { ...result(""), error: "reset failed" });
      await expect(rig.port.sanitize(rig.context)).rejects.toThrow("reset failed");
      expect(rig.state.commands.some((entry) => entry[0] === command)).toBe(true);
    }
    const rig = harness();
    rig.state.pasteboardError = new Error("pbcopy failed");
    await expect(rig.port.sanitize(rig.context)).rejects.toThrow("pbcopy failed");
    expect(rig.state.pasteboardTypes).toEqual(["public.png"]);
  });

  test("sanitation clears unjournaled overrides and image pasteboards without certification", async () => {
    const rig = harness();
    rig.context.baseline = undefined;
    const baseline = await rig.port.capture(rig.context);
    rig.context.baseline = baseline;
    rig.state.resetState = {
      keychain: "new secret",
      privacy: "new grant",
      location: "new route",
      status_bar: "new override",
    };
    rig.state.pasteboardTypes = ["public.png"];
    await rig.port.sanitize(rig.context);
    expect(Object.values(rig.state.resetState).every((value) => value === undefined)).toBe(true);
    expect(rig.state.pasteboardTypes).toEqual(["public.utf8-plain-text"]);
    expect(rig.state.clipboard).toEqual([""]);
  });

  test("sanitation removes only new apps, retains shared groups, and restores baseline settings", async () => {
    const rig = harness();
    rig.state.appInventory = {
      "probe.app": { ApplicationType: "User" },
      "baseline.app": { ApplicationType: "User" },
    };
    rig.context.baseline = {
      completeKinds: ["installed-app"],
      unobservable: DEVICE_MUTATION_KINDS.filter((kind) => kind !== "installed-app"),
      observations: [
        {
          kind: "installed-app",
          key: "baseline.app",
          value: { state: "present", value: { ApplicationType: "User" } },
        },
        { kind: "device-setting", key: "appearance", value: { state: "present", value: "dark" } },
        {
          kind: "device-setting",
          key: "content-size",
          value: { state: "present", value: "small" },
        },
        {
          kind: "device-setting",
          key: "increase-contrast",
          value: { state: "present", value: "enabled" },
        },
        { kind: "device-setting", key: "locale", value: { state: "present", value: "fr_CA" } },
        {
          kind: "device-setting",
          key: "language",
          value: { state: "present", value: ["fr-CA", "en-CA"] },
        },
      ],
    };
    rig.state.baselineGroups = { "group.probe": GROUP };
    await rig.port.sanitize(rig.context);
    expect(rig.state.commands).toContainEqual(["terminate", UDID, "probe.app"]);
    expect(rig.state.commands).toContainEqual(["uninstall", UDID, "probe.app"]);
    expect(
      rig.state.commands.some(
        (args) => ["terminate", "uninstall"].includes(args[0]) && args[2] === "baseline.app",
      ),
    ).toBe(false);
    expect(rig.state.removed).toEqual([]);
    expect(rig.state.ui).toEqual({
      appearance: "dark",
      content_size: "small",
      increase_contrast: "enabled",
    });
    expect(rig.state.commands).toContainEqual([
      "spawn",
      UDID,
      "defaults",
      "write",
      ".GlobalPreferences",
      "AppleLocale",
      "-string",
      "fr_CA",
    ]);
    expect(rig.state.commands).toContainEqual([
      "spawn",
      UDID,
      "defaults",
      "write",
      ".GlobalPreferences",
      "AppleLanguages",
      "-array",
      "fr-CA",
      "en-CA",
    ]);
    expect(rig.state.clipboard).toEqual([""]);
    expect(Object.values(rig.state.resetState).every((value) => value === undefined)).toBe(true);
  });

  test("a captured empty app baseline removes user apps and restores missing setting defaults", async () => {
    const rig = harness();
    rig.state.ui = { appearance: "dark", content_size: "small", increase_contrast: "enabled" };
    await rig.port.sanitize(rig.context);
    expect(rig.state.commands).toContainEqual(["uninstall", UDID, "probe.app"]);
    expect(rig.state.removed).toEqual([GROUP]);
    expect(rig.state.ui).toEqual({
      appearance: "light",
      content_size: "large",
      increase_contrast: "disabled",
    });
    for (const key of [
      "AppleLocale",
      "AppleLanguages",
      "AppleCalendar",
      "AppleICUForce24HourTime",
      "AppleICUForce12HourTime",
    ]) {
      expect(rig.state.commands).toContainEqual([
        "spawn",
        UDID,
        "defaults",
        "delete",
        ".GlobalPreferences",
        key,
      ]);
    }
  });

  test("iOS 27 already absent AppleCalendar default is a successful sanitation no-op", async () => {
    const rig = harness();
    rig.state.commandErrors.set(
      `spawn ${UDID} defaults delete .GlobalPreferences AppleCalendar`,
      new Error(
        readFileSync(
          `${import.meta.dir}/../../fixtures/ios-simctl/defaults-delete-absent-key-ios27.txt`,
          "utf8",
        ),
      ),
    );
    await expect(rig.port.sanitize(rig.context)).resolves.toBeUndefined();
  });

  test("already absent defaults are successful no-ops but unrelated defaults failures propagate", async () => {
    const rig = harness();
    rig.state.commandErrors.set(
      `spawn ${UDID} defaults delete .GlobalPreferences AppleCalendar`,
      new Error("The domain/default pair of (.GlobalPreferences, AppleCalendar) does not exist"),
    );
    await rig.port.sanitize(rig.context);
    rig.state.commandErrors.set(
      `spawn ${UDID} defaults delete .GlobalPreferences AppleCalendar`,
      new Error("CoreSimulator connection refused"),
    );
    await expect(rig.port.sanitize(rig.context)).rejects.toThrow("connection refused");
  });

  test.each(["uninstall", "ui", "spawn"])(
    "non-zero %s cleaning commands propagate",
    async (command) => {
      const rig = harness();
      const args =
        command === "uninstall"
          ? ["uninstall", UDID, "probe.app"]
          : command === "ui"
            ? ["ui", UDID, "appearance", "light"]
            : ["spawn", UDID, "defaults", "delete", ".GlobalPreferences", "AppleLocale"];
      rig.state.commandResults.set(args.join(" "), {
        ...result(""),
        error: "native command failed",
      });
      await expect(rig.port.sanitize(rig.context)).rejects.toThrow("native command failed");
    },
  );

  test("abort and ownership loss stop sanitation before any further reset command", async () => {
    const rig = harness();
    rig.context.assertOwned = async () => {
      if (rig.state.commands.some((args) => args[0] === "keychain")) {
        throw new Error("Ownership lost");
      }
    };
    await expect(rig.port.sanitize(rig.context)).rejects.toThrow("Ownership lost");
    expect(rig.state.commands.some((args) => args[0] === "privacy")).toBe(false);
    const aborted = harness();
    aborted.context.signal = AbortSignal.abort(new DOMException("cancelled", "AbortError"));
    await expect(aborted.port.sanitize(aborted.context)).rejects.toThrow("cancelled");
    expect(aborted.state.commands).toEqual([]);
  });

  test("settings capture timeouts and cleaning timeouts propagate", async () => {
    for (const args of [
      ["ui", UDID, "appearance"],
      ["keychain", UDID, "reset"],
    ]) {
      const rig = harness();
      rig.state.commandErrors.set(args.join(" "), new DOMException("timeout", "TimeoutError"));
      await expect(
        args[0] === "ui" ? rig.port.capture(rig.context) : rig.port.sanitize(rig.context),
      ).rejects.toThrow(args[0] === "ui" ? "temporarily unavailable" : "timeout");
    }
  });

  test("observed UI drift produces trusted baseline reverts but still requires all inventories", async () => {
    const rig = harness();
    rig.context.baseline = undefined;
    const baseline = await rig.port.capture(rig.context);
    rig.context.baseline = baseline;
    rig.state.ui.appearance = "dark";
    rig.state.ui.content_size = "accessibility-extra-large";
    rig.state.ui.increase_contrast = "enabled";
    const current = await rig.port.capture(rig.context);
    const diff = diffDeviceBaseline(baseline, current);
    expect(planDeviceMutationRevert([], diff, rig.port).status).toBe("non_revertible");
    const plan = planDeviceMutationRevert([], { ...diff, dirty: [] }, rig.port);
    expect(plan.status).toBe("revertible");
    if (plan.status !== "revertible") {
      throw new Error("Expected reversible settings");
    }
    for (const step of plan.steps) {
      await rig.port.revert(step.mutation, rig.context);
    }
    expect(diffDeviceBaseline(baseline, await rig.port.capture(rig.context)).changes).toEqual([]);
  });

  test("invalid and failed app captures are not saved and a later valid capture can retry", async () => {
    for (const failed of [false, true]) {
      const rig = harness();
      const journal = new FakeDeviceMutationJournal(new FakeTimer());
      if (failed) {
        rig.state.error = new Error("inventory failed");
      } else {
        rig.state.appInventory = null;
      }
      await expect(captureFirstDeviceBaseline(journal, rig.port, rig.context)).rejects.toThrow(
        "app inventory is unavailable",
      );
      expect(await journal.getBaseline(rig.context.scope)).toBeNull();
      rig.state.error = undefined;
      rig.state.appInventory = {};
      await captureFirstDeviceBaseline(journal, rig.port, rig.context);
      expect((await journal.getBaseline(rig.context.scope))?.completeKinds).toContain(
        "installed-app",
      );
    }
  });

  test("missing and unobservable app baselines refuse sanitation before destructive work", async () => {
    for (const baseline of [
      undefined,
      { completeKinds: [], observations: [], unobservable: [...DEVICE_MUTATION_KINDS] },
    ]) {
      const rig = harness();
      rig.context.baseline = baseline;
      await expect(rig.port.sanitize(rig.context)).rejects.toThrow("captured app baseline");
      expect(rig.state.commands).toEqual([]);
      expect(rig.state.removed).toEqual([]);
    }
  });

  test("known empty app baselines remove only User apps, never System, Hidden or untyped apps", async () => {
    const rig = harness();
    rig.state.appInventory = {
      "probe.app": { ApplicationType: "User" },
      "system.app": { ApplicationType: "System" },
      "hidden.app": { ApplicationType: "Hidden" },
      "unknown.app": {},
    };
    await rig.port.sanitize(rig.context);
    expect(
      rig.state.commands.filter((args) =>
        ["terminate", "get_app_container", "uninstall"].includes(args[0]),
      ),
    ).toEqual([
      ["terminate", UDID, "probe.app"],
      ["get_app_container", UDID, "probe.app", "groups"],
      ["uninstall", UDID, "probe.app"],
    ]);
    expect(rig.state.removed).toEqual([GROUP]);
    expect(Object.keys(rig.state.appInventory)).toEqual([
      "system.app",
      "hidden.app",
      "unknown.app",
    ]);
  });

  test("baseline app-group lookups only scan saved User apps once per sanitation", async () => {
    const rig = harness();
    rig.context.baseline!.observations = (
      [
        ["baseline.app", { ApplicationType: "User" }],
        ["system.app", { ApplicationType: "System" }],
        ["hidden.app", { ApplicationType: "Hidden" }],
        ["unknown.app", {}],
      ] as const
    ).map(([key, value]) => ({
      kind: "installed-app",
      key,
      value: { state: "present", value },
    }));
    rig.state.appInventory = {
      "baseline.app": { ApplicationType: "User" },
      "system.app": { ApplicationType: "System" },
      "probe.app": { ApplicationType: "User" },
      "second.app": { ApplicationType: "User" },
    };
    rig.state.baselineGroups = { "group.probe": GROUP };
    await rig.port.sanitize(rig.context);
    for (const bundleId of ["baseline.app", "probe.app", "second.app"]) {
      expect(
        rig.state.commands.filter(
          (args) => args[0] === "get_app_container" && args[2] === bundleId,
        ),
      ).toHaveLength(1);
    }
    for (const bundleId of ["system.app", "hidden.app", "unknown.app"]) {
      expect(
        rig.state.commands.filter(
          (args) => args[0] === "get_app_container" && args[2] === bundleId,
        ),
      ).toHaveLength(0);
    }
    expect(rig.state.removed).toEqual([]);
  });

  test("Apple app groups are retained without baseline container lookups", async () => {
    const rig = harness();
    rig.state.groups = { "group.com.apple.shared": GROUP };
    await rig.port.sanitize(rig.context);
    expect(rig.state.removed).toEqual([]);
    expect(rig.state.commands.filter((args) => args[0] === "get_app_container")).toEqual([
      ["get_app_container", UDID, "probe.app", "groups"],
    ]);
    expect(rig.state.commands).toContainEqual(["uninstall", UDID, "probe.app"]);
  });

  test("session apps sharing a group remove its path once without an ENOENT failure", async () => {
    const rig = harness();
    rig.state.appInventory = {
      "probe.app": { ApplicationType: "User" },
      "second.app": { ApplicationType: "User" },
    };
    await rig.port.sanitize(rig.context);
    expect(rig.state.removed).toEqual([GROUP]);
    expect(rig.state.commands.filter((args) => args[0] === "uninstall")).toEqual([
      ["uninstall", UDID, "probe.app"],
      ["uninstall", UDID, "second.app"],
    ]);
  });

  test("transient inventory failures propagate for cleanup_pending rather than triggering erase", async () => {
    const rig = harness();
    rig.state.error = new DOMException("inventory timeout", "TimeoutError");
    await expect(rig.port.capture(rig.context)).rejects.toThrow("temporarily unavailable");
  });

  test("untrusted app-group paths and symlinks are never removed", async () => {
    for (const path of [
      "/tmp/foreign",
      GROUP.replace(UDID, "foreign"),
      `${GROUP}/../other`,
      `${GROUP}/child`,
    ]) {
      const rig = harness();
      rig.state.groups["group.probe"] = path;
      await expect(rig.revert("app-group", "probe.app")).rejects.toThrow("unproven");
      expect(rig.state.removed).toEqual([]);
    }
    const rig = harness();
    rig.state.realPath = "/tmp/symlink-target";
    await expect(rig.revert("app-group", "probe.app")).rejects.toThrow("unproven");
  });

  test("ownership is checked between terminate, group removal and uninstall", async () => {
    const rig = harness();
    rig.context.assertOwned = async () => {
      if (rig.state.commands.length > 0) {
        throw new Error("Ownership lost");
      }
    };
    await expect(rig.revert("installed-app", "probe.app")).rejects.toThrow("Ownership lost");
    expect(rig.state.commands).toHaveLength(1);
    expect(rig.state.removed).toEqual([]);
  });

  test("already exited apps terminate successfully but unrelated errors propagate", async () => {
    const rig = harness();
    rig.state.terminateError = new Error("found nothing to terminate");
    await rig.revert("installed-app", "probe.app");
    expect(rig.state.removed).toEqual([GROUP]);
    const failed = harness();
    failed.state.terminateError = new Error("device not running");
    await expect(failed.revert("installed-app", "probe.app")).rejects.toThrow("device not running");
    expect(failed.state.removed).toEqual([]);
  });

  test("empty group output works and malformed output never deletes containers", async () => {
    const rig = harness();
    rig.state.groupsOutput = "";
    await rig.revert("installed-app", "probe.app");
    expect(rig.state.removed).toEqual([]);
    rig.state.groupsOutput = JSON.stringify(rig.state.groups);
    await expect(rig.revert("app-group", "probe.app")).rejects.toThrow(
      "invalid app-group inventory",
    );
  });

  test("group resets terminate first and preserve containers shared with baseline apps", async () => {
    for (const shared of ["id", "path", "missing"] as const) {
      const rig = harness();
      rig.context.baseline =
        shared === "missing"
          ? undefined
          : {
              completeKinds: ["installed-app"],
              observations: [
                {
                  kind: "installed-app",
                  key: "baseline.app",
                  value: { state: "present", value: { ApplicationType: "User" } },
                },
              ],
              unobservable: [],
            };
      rig.state.baselineGroups =
        shared === "id" ? { "group.probe": "/other" } : { "other.id": GROUP };
      await rig.revert("app-group", "probe.app");
      expect(rig.state.commands[0]).toEqual(["terminate", UDID, "probe.app"]);
      expect(rig.state.removed).toEqual(shared === "missing" ? [GROUP] : []);
    }
  });

  test("integer and real preferences preserve their native types", async () => {
    for (const value of [7, 1.5]) {
      const rig = harness();
      await rig.revert("preference", "probe.app:count", { state: "present", value });
      expect(rig.state.commands).toContainEqual([
        "spawn",
        UDID,
        "defaults",
        "write",
        "probe.app",
        "count",
        Number.isInteger(value) ? "-int" : "-float",
        String(value),
      ]);
    }
  });
});
