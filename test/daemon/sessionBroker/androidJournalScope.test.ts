import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionDeviceMutationRecording } from "../../../src/server/deviceMutationRecording";
import { FamilyMutationPriorReader } from "../../../src/server/deviceMutationFamilyPriorReader";
import { androidBaselineCleanCovers } from "../../../src/daemon/sessionBroker/androidKeepBootedCleanup";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { AndroidBaselineReset } from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import {
  brokerSessionMutationScope,
  SessionMutationRecorder,
} from "../../../src/daemon/sessionBroker/mutations/recorder";
import {
  SqliteDeviceMutationJournal,
  type DeviceMutationTables,
} from "../../../src/daemon/sessionBroker/mutations/sqliteJournal";
import {
  DEVICE_MUTATION_KINDS,
  opaqueIntentKey,
  type DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import * as migration from "../../../src/daemon/sessionBroker/registry/migrations/2026_10_21_012_device_mutation_journal";
import { createTestDatabase } from "../../db/testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAndroidKeepBootedResetPort } from "../../fakes/FakeAndroidKeepBootedResetPort";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";

const resourceId = "resource-a";
const stableDeviceId = "stable-avd";

describe("Android journal writer/reset scope", () => {
  let db: Kysely<DeviceMutationTables>;
  beforeAll(async () => {
    db = (await createTestDatabase()).withTables<{
      [Table in keyof DeviceMutationTables]: DeviceMutationTables[Table];
    }>();
    await migration.up(db as Kysely<unknown>);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await db.deleteFrom("device_mutation_journal").execute();
    await db.deleteFrom("device_mutation_baselines").execute();
  });

  async function rig(heldApp?: string) {
    const timer = new FakeTimer();
    const journal = new SqliteDeviceMutationJournal(db, timer);
    const host = new FakeAndroidResetHost();
    host.timer = timer;
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: heldApp
        ? [
            {
              kind: "installed-app",
              key: `user:0:${heldApp}`,
              value: { state: "present", value: true },
            },
          ]
        : [],
      unobservable: [],
    });
    // Model the production port's unsupported/unobservable prior values explicitly.
    for (const kind of [
      "installed-app",
      "permission",
      "location",
      "opaque",
      "device-setting",
      "rotation",
      "screen-reader",
      "keyboard",
      "keep-awake",
      "opened-url",
      "shared-file",
      "notification",
      "clock",
    ]) {
      port.unsupportedKinds.add(kind);
    }
    let fallbacks = 0;
    host.strategy = new AndroidKeepBootedReset({
      journal,
      timer,
      port: () => port,
      fallback: {
        reset: async () => {
          fallbacks++;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      },
    });
    const baseline = new AndroidBaselineReset(host);
    const captured = await baseline.capture(
      resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      {
        sessionId: "session-a",
        timer,
        timeoutMs: 60_000,
        assertOwned: async () => {},
        stableDeviceId,
      },
    );
    const scope = brokerSessionMutationScope({
      platform: "android",
      sessionUuid: "session-a",
      resource: { resourceId, scopeKey: "pool", allocationIndex: 0 },
      stableDeviceId,
      transportId: ANDROID_RESET_DEVICE.deviceId,
      assignmentGeneration: 3,
      bootId: captured?.bootId ?? null,
    });
    return {
      journal,
      port,
      scope,
      recorder: new SessionMutationRecorder(journal, scope),
      reset: () =>
        baseline.reset(resourceId, ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, {
          assertOwned: async () => {},
        }),
      fallbacks: () => fallbacks,
    };
  }

  test.each([
    ["installApp", "dev.example.app", "installed-app"],
    ["sendBroadcast", "dev.example.ACTION", "opaque"],
    ["setDeviceState", "location", "location"],
  ])("%s opaque intent is visible to reset and forces fallback", async (toolName, key, kind) => {
    const r = await rig();
    await r.recorder.record({ kind, key, toolName, priorValue: { state: "unobservable" } });
    await r.recorder.record({
      kind: "opaque",
      key: opaqueIntentKey(toolName, key),
      toolName,
      priorValue: { state: "unobservable" },
    });
    expect(await r.reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: `opaque journaled mutation (${toolName}) cannot be journal-reverted`,
    });
    expect(r.fallbacks()).toBe(1);
  });

  test("writer scope addresses the reset baseline", async () => {
    const r = await rig();
    expect(await r.journal.getBaseline(r.scope)).not.toBeNull();
  });

  test("legacy generation rows are strays and force fallback", async () => {
    const r = await rig();
    await r.journal.record(
      { ...r.scope, incarnation: JSON.stringify([resourceId, 3]) },
      {
        kind: "installed-app",
        key: "legacy.app",
        toolName: "installApp",
        priorValue: { state: "unobservable" },
      },
    );
    expect(await r.journal.listStrayIncarnations(r.scope)).toMatchObject([{ key: "legacy.app" }]);
    expect(await r.reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("different incarnation (1)"),
    });
    expect(r.fallbacks()).toBe(1);
  });

  test("uncovered unrevertible location forces fallback", async () => {
    const r = await rig();
    await r.recorder.record({
      kind: "location",
      key: "provider:gps",
      toolName: "setDeviceState",
      priorValue: { state: "present", value: "x" },
    });
    expect(await r.reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("location:provider:gps"),
    });
    expect(r.fallbacks()).toBe(1);
  });

  test("interim bootId=null rows force fallback without rebinding", async () => {
    const r = await rig();
    const interim = brokerSessionMutationScope({
      platform: "android",
      sessionUuid: r.scope.sessionUuid,
      resource: { resourceId, scopeKey: "pool", allocationIndex: 0 },
      stableDeviceId,
      transportId: ANDROID_RESET_DEVICE.deviceId,
      assignmentGeneration: 3,
      bootId: null,
    });
    await r.journal.record(interim, {
      kind: "clipboard",
      key: "device",
      toolName: "clipboard",
      priorValue: { state: "absent" },
    });
    expect(await r.reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("different incarnation (1)"),
    });
  });

  test.each(["missing", "unreadable"])(
    "preference with %s baseline forces fallback",
    async (state) => {
      const r = await rig();
      for (const row of deviceToolMutations(
        "setPreference",
        { appId: "new.app", key: "x" },
        "android",
      )) {
        await r.recorder.record({
          ...row,
          toolName: "setPreference",
          priorValue: { state: "unobservable" },
        });
      }
      r.journal.getBaseline = async () => {
        if (state === "unreadable") {
          throw new Error("baseline read failed");
        }
        return null;
      };
      expect(await r.reset()).toMatchObject({ outcome: "fallback:snapshot" });
      expect(r.fallbacks()).toBe(1);
    },
  );

  test("a systemProperty setPreference row is reverted in place and stays clean (#15792)", async () => {
    const r = await rig();
    const rows = deviceToolMutations(
      "setPreference",
      {
        scope: "systemProperty",
        key: "debug.app.api_url",
        value: "https://staging",
        type: "string",
      },
      "android",
    );
    for (const row of rows ?? []) {
      await r.recorder.record({
        ...row,
        toolName: "setPreference",
        priorValue: { state: "absent" },
      });
    }
    expect(await r.reset()).toMatchObject({ outcome: "clean" });
    expect(r.port.reverted).toMatchObject([{ kind: "preference", toolName: "setPreference" }]);
    expect(r.fallbacks()).toBe(0);
  });

  const adapterCases: {
    name: string;
    args: Record<string, unknown>;
    clean: boolean;
    heldApp?: string;
  }[] = [
    { name: "rotate", args: { orientation: "landscape" }, clean: true },
    { name: "rotate", args: { display: 2 }, clean: false },
    { name: "sendSms", args: { to: "123", message: "hello" }, clean: false },
    { name: "phoneCall", args: { phoneNumber: "123" }, clean: false },
    {
      name: "sqlQuery",
      args: { appId: "a.b", databasePath: "db", query: "UPDATE t SET x=1" },
      heldApp: "a.b",
      clean: false,
    },
    { name: "resetAppLogs", args: { appId: "a.b", paths: ["a.log"] }, clean: false },
    { name: "setUIState", args: { appId: "a.b" }, heldApp: "a.b", clean: true },
    { name: "clipboard", args: { action: "paste" }, heldApp: "a.b", clean: true },
    {
      name: "setAppPermissions",
      args: { appId: "new.app", permissions: ["android.permission.CAMERA"] },
      clean: false,
    },
    {
      name: "setAppPermissions",
      args: { appId: "a.b", permissions: ["android.permission.CAMERA"] },
      heldApp: "a.b",
      clean: false,
    },
    {
      name: "setAppPermissions",
      args: { appId: "never.installed", notificationPolicyAccess: true },
      clean: false,
    },
    { name: "keyboard", args: { action: "press", key: "enter" }, clean: false },
    ...[
      "increaseContrast",
      "reduceMotion",
      "boldText",
      "colorInversion",
      "colorCorrection",
      "magnification",
      "magnificationScale",
      "extraDim",
    ].map((key) => ({
      name: "displayConfig",
      args: {
        [key]: key === "magnificationScale" ? 2 : key === "colorCorrection" ? "grayscale" : true,
      },
      clean: false,
    })),
    { name: "changeLocalization", args: { timeFormat: "24" }, clean: false },
    {
      name: "putAppFile",
      args: {
        target: { domain: "user_files", namespace: "test" },
        files: [{ destinationPath: "/sdcard/Download/x" }],
      },
      clean: false,
    },
    { name: "displayConfig", args: { density: 320, theme: "dark" }, clean: true },
    { name: "displayConfig", args: { fontScale: 1.2 }, clean: false },
    { name: "openLink", args: { url: "https://example.com" }, clean: true },
    { name: "accessibility", args: { talkback: true }, clean: true },
    { name: "keyboard", args: { action: "setProfile", profile: "default" }, clean: false },
    {
      name: "putAppFile",
      args: {
        target: { domain: "app_container", appId: "a.b", container: "files" },
        files: [{ destinationPath: "x" }],
      },
      clean: false,
    },
    {
      name: "putAppFile",
      args: {
        target: { domain: "user_files", namespace: "test", reset: true },
        files: [{ destinationPath: "x" }],
      },
      clean: false,
    },
    { name: "postNotification", args: { appId: "a.b", title: "Hello" }, clean: false },
    ...["setPreference", "setKeyValue", "removeKeyValue", "clearKeyValueFile"].map((name) => ({
      name,
      args: { appId: "a.b", scope: "sharedPreferences", name: "prefs", key: "x" },
      clean: false,
      heldApp: "a.b",
    })),
    {
      name: "setPreference",
      args: { appId: "new.app", scope: "sharedPreferences", key: "x" },
      clean: true,
    },
    { name: "setPreference", args: { scope: "sharedPreferences", key: "x" }, clean: false },
  ];

  test.each([
    { tool: "uninstallApp", keepData: true, held: false, clean: false },
    { tool: "uninstallApp", keepData: false, held: false, clean: true },
    { tool: "installApp", keepData: false, held: true, clean: false },
  ])(
    "production $tool keepData=$keepData held=$held through app filtering and reset",
    async ({ tool, keepData, held, clean }) => {
      const r = await rig(held ? "a.b" : undefined);
      const recording = new SessionDeviceMutationRecording(() => r.recorder, {
        reader: new FamilyMutationPriorReader([]),
        artifactReader: { appId: async () => "a.b" },
      });
      // The production recording layer calls adapters, withoutSessionCoveredFallbacks and recorder.
      // After uninstall, pm list packages -3 cannot see a removed package with data kept.
      await recording.beforeToolCall(
        "installApp",
        { artifactPath: "/fixture.apk" },
        ANDROID_RESET_DEVICE,
        { sessionUuid: r.scope.sessionUuid },
      );
      await recording.beforeToolCall(tool, { appId: "a.b", keepData }, ANDROID_RESET_DEVICE, {
        sessionUuid: r.scope.sessionUuid,
      });
      const rows = await r.journal.list(r.scope);
      expect(rows.some((row) => row.kind === "opaque")).toBe(!clean);
      if (keepData) {
        expect(rows).toContainEqual(
          expect.objectContaining({
            kind: "opaque",
            key: opaqueIntentKey("uninstallApp", "a.b", true),
          }),
        );
      }
      expect(await r.reset()).toMatchObject({ outcome: clean ? "clean" : "fallback:snapshot" });
      expect(r.fallbacks()).toBe(clean ? 0 : 1);
    },
  );

  test.each(["power:battery", "power:standby:a.b"])(
    "%s requires a revert and replays when revertible",
    async (key) => {
      const r = await rig();
      const row = {
        kind: "device-setting",
        key,
        toolName: "setDeviceState",
        priorValue: {
          state: "present" as const,
          value: key === "power:battery" ? { powered: true, status: 2, level: 100 } : "active",
        },
      };
      expect(androidBaselineCleanCovers(row)).toBe(false);
      r.port.unsupportedKinds.delete("device-setting");
      await r.recorder.record(row);
      expect(await r.reset()).toMatchObject({ outcome: "clean" });
      expect(r.port.reverted).toContainEqual(expect.objectContaining({ kind: row.kind, key }));
    },
  );

  test.each(["power:battery", "power:standby:a.b"])(
    "%s escalates without a revert",
    async (key) => {
      const r = await rig();
      await r.recorder.record({
        kind: "device-setting",
        key,
        toolName: "setDeviceState",
        priorValue: { state: "unobservable" },
      });
      expect(await r.reset()).toMatchObject({ outcome: "fallback:snapshot" });
    },
  );

  test.each(adapterCases)(
    "production $name $args => clean=$clean",
    async ({ name, args, clean, heldApp }) => {
      const r = await rig(heldApp);
      const rows = deviceToolMutations(name, args, "android");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        await r.recorder.record({ ...row, toolName: name, priorValue: { state: "unobservable" } });
      }
      expect(await r.reset()).toMatchObject({ outcome: clean ? "clean" : "fallback:snapshot" });
      expect(r.fallbacks()).toBe(clean ? 0 : 1);
    },
  );

  test.each([
    {
      kind: "notification",
      key: "system:fake",
      priorValue: { state: "unobservable" },
      clean: false,
    },
    { kind: "clock", key: "device", priorValue: { state: "unobservable" }, clean: false },
    {
      kind: "preference",
      key: "invalid-json",
      priorValue: { state: "unobservable" },
      clean: false,
    },
  ] satisfies (Pick<DeviceMutationInput, "kind" | "key" | "priorValue"> & { clean: boolean })[])(
    "$kind:$key $priorValue => clean=$clean",
    async ({ clean, ...entry }) => {
      const r = await rig();
      await r.recorder.record({ ...entry, toolName: "test" });
      expect(await r.reset()).toMatchObject({ outcome: clean ? "clean" : "fallback:snapshot" });
    },
  );
});
