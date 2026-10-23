import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { MutationValue } from "../../src/daemon/sessionBroker/mutations/types";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { planDeviceMutationRevert } from "../../src/daemon/sessionBroker/mutations/revertPlanner";
import { deviceToolMutations, type ToolMutation } from "../../src/server/deviceMutationAdapters";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import {
  DefaultMutationPriorReader,
  type MutationPriorReader,
} from "../../src/server/deviceMutationPriorReader";
import {
  invokeResolvedDeviceHandler,
  journaledDeviceHandler,
} from "../../src/server/pipeline/deviceCallDispatch";
import type { DeviceAwareToolHandler } from "../../src/server/toolRegistryTypes";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { DEVICE_MUTATION_TOOL_COVERAGE } from "../../src/daemon/sessionBroker/mutations/toolCoverage";
import { DEVICE_MUTATION_CALL_EXEMPTIONS } from "../../src/daemon/sessionBroker/mutations/toolCoverage";
import { setDeviceStateSchema } from "../../src/server/utilityTools";
import { addDeviceTargetingToSchema } from "../../src/utils/schemaHelpers";
import { z } from "zod/v4";
import {
  createDefaultMutationArtifactReader,
  createRecording,
} from "../../src/server/deviceMutationRecording";
import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import {
  DEVICE_MUTATION_TOOL_CASES as CASES,
  SERVICE_RECORDED_TOOLS,
} from "../helpers/deviceMutationToolCases";

const DEVICE: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const SCOPE = { sessionUuid: "broker-session", deviceId: DEVICE.deviceId, incarnation: "native-1" };

class FakePriorReader implements MutationPriorReader {
  calls = 0;
  priorValue: MutationValue = { state: "unobservable" };
  error?: Error;

  async read(
    _device: BootedDevice,
    mutations: readonly ToolMutation[],
  ): Promise<readonly MutationValue[]> {
    this.calls++;
    if (this.error) {
      throw this.error;
    }
    return mutations.map(() => this.priorValue);
  }
}

function harness() {
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const reader = new FakePriorReader();
  const recorder = new SessionMutationRecorder(journal, SCOPE);
  const recording = new SessionDeviceMutationRecording(() => recorder, reader, {
    appId: async () => "com.example",
  });
  const dispatch = (
    name: string,
    args: Record<string, unknown>,
    handler: DeviceAwareToolHandler,
    mutationRecording = recording,
    signal?: AbortSignal,
  ) =>
    invokeResolvedDeviceHandler({
      target: {
        args,
        baseSessionUuid: SCOPE.sessionUuid,
        device: DEVICE,
        internalCall: false,
        sessionUuid: SCOPE.sessionUuid,
        shouldResolveDevice: true,
      },
      name,
      args,
      handler,
      mutationRecording,
      signal,
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      navigationRecorder: { record: () => undefined },
      isResponseFailure: () => false,
    });
  return { dispatch, recording, journal, reader };
}

describe("broker tool-surface mutation recording", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  test("target-device internal calls also journal before the raw device handler", async () => {
    const { recording, journal } = harness();
    const handler = journaledDeviceHandler(
      "clipboard",
      async () => {
        expect(await journal.list(SCOPE)).toHaveLength(1);
        return { content: [] };
      },
      recording,
    );
    expect(await handler(DEVICE, { action: "clear", sessionUuid: SCOPE.sessionUuid })).toEqual({
      content: [],
    });
  });

  test("target-device internal calls warn and run the raw handler when journaling fails", async () => {
    let acted = false;
    const recording = new SessionDeviceMutationRecording(
      () =>
        new SessionMutationRecorder(
          {
            list: async () => [],
            getBaseline: async () => null,
            record: async () => {
              throw new Error("journal unavailable");
            },
          },
          SCOPE,
        ),
      new FakePriorReader(),
    );
    const handler = journaledDeviceHandler(
      "clipboard",
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    await handler(DEVICE, { action: "clear", sessionUuid: SCOPE.sessionUuid });
    expect(acted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Device mutation recording failed; proceeding without recording",
      expect.objectContaining({ message: "journal unavailable" }),
    );
  });

  test("every journaled coverage classification has an exercised adapter", () => {
    expect(CASES.map((entry) => entry.name).sort()).toEqual(
      Object.entries(DEVICE_MUTATION_TOOL_COVERAGE)
        .filter(([name, entry]) => entry.status === "journaled" && !SERVICE_RECORDED_TOOLS.includes(name))
        .map(([name]) => name)
        .sort(),
    );
  });

  test.each(CASES)(
    "$name records its kind and prior value before invoking the dispatch boundary",
    async ({ name, args, kind }) => {
      const { dispatch, journal } = harness();
      let acted = false;
      await dispatch(name, args, async () => {
        const entries = await journal.list(SCOPE);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[0]).toMatchObject({
          kind,
          toolName: name,
          priorValue: { state: "unobservable" },
        });
        expect(entries.every((entry) => entry.key.length > 0)).toBe(true);
        acted = true;
        return { content: [] };
      });
      expect(acted).toBe(true);
    },
  );

  test("journal persistence failure warns and proceeds with the action", async () => {
    const { dispatch } = harness();
    const recording = new SessionDeviceMutationRecording(
      () =>
        new SessionMutationRecorder(
          {
            list: async () => [],
            getBaseline: async () => null,
            record: async () => {
              throw new Error("journal unavailable");
            },
          },
          SCOPE,
        ),
      new FakePriorReader(),
    );
    let acted = false;
    await dispatch(
      "clipboard",
      { action: "clear" },
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    expect(acted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Device mutation recording failed; proceeding without recording",
      expect.objectContaining({ message: "journal unavailable" }),
    );
  });

  test("late recorder resolution completes before capture and dispatch", async () => {
    const { dispatch, journal } = harness();
    const reader = new FakePriorReader();
    const recovered = Promise.withResolvers<SessionMutationRecorder>();
    const recording = new SessionDeviceMutationRecording(() => recovered.promise, reader);
    let acted = false;
    const dispatched = dispatch(
      "clipboard",
      { action: "clear" },
      async () => {
        expect(await journal.list(SCOPE)).toHaveLength(1);
        acted = true;
        return { content: [] };
      },
      recording,
    );
    expect(reader.calls).toBe(0);
    expect(acted).toBe(false);
    recovered.resolve(new SessionMutationRecorder(journal, SCOPE));
    await dispatched;
    expect(acted).toBe(true);
  });

  test("a non-broker session without a recorder proceeds without warning", async () => {
    const { dispatch } = harness();
    const reader = new FakePriorReader();
    const recording = new SessionDeviceMutationRecording(() => undefined, reader);
    let acted = false;
    await dispatch(
      "clipboard",
      { action: "clear" },
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    expect(acted).toBe(true);
    expect(reader.calls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["list", "getBaseline"] as const)(
    "journal %s failure warns and proceeds without recording",
    async (operation) => {
      const { dispatch, journal } = harness();
      const journalRead = spyOn(journal, operation).mockRejectedValue(
        new Error("journal unavailable"),
      );
      const recording = new SessionDeviceMutationRecording(
        () => new SessionMutationRecorder(journal, SCOPE),
        new FakePriorReader(),
        { appId: async () => "com.example" },
      );
      let acted = false;
      try {
        await dispatch(
          "installApp",
          { artifactPath: "/app.apk" },
          async () => {
            acted = true;
            return { content: [] };
          },
          recording,
        );
        expect(acted).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          "Device mutation recording failed; proceeding without recording",
          expect.objectContaining({ message: "journal unavailable" }),
        );
      } finally {
        journalRead.mockRestore();
      }
      expect(await journal.list(SCOPE)).toEqual([]);
    },
  );

  test.each(["recovery", "unavailable", "mismatch", "list", "getBaseline", "record"] as const)(
    "cancellation during %s still prevents the action",
    async (stage) => {
      const controller = new AbortController();
      const { dispatch, journal } = harness();
      const cancel = () => {
        controller.abort(new Error("call cancelled"));
        throw new Error("recording unavailable");
      };
      const recorder = new SessionMutationRecorder(
        {
          list: stage === "list" ? async () => cancel() : journal.list.bind(journal),
          getBaseline:
            stage === "getBaseline" ? async () => cancel() : journal.getBaseline.bind(journal),
          record: stage === "record" ? async () => cancel() : journal.record.bind(journal),
        },
        SCOPE,
      );
      const recording = new SessionDeviceMutationRecording(
        async () => {
          if (stage === "recovery") {
            cancel();
          }
          if (stage === "unavailable") {
            controller.abort(new Error("call cancelled"));
            return undefined;
          }
          if (stage === "mismatch") {
            controller.abort(new Error("call cancelled"));
            return new SessionMutationRecorder(journal, { ...SCOPE, deviceId: "other" });
          }
          return recorder;
        },
        new FakePriorReader(),
        { appId: async () => "com.example" },
      );
      let acted = false;
      await expect(
        dispatch(
          "installApp",
          { artifactPath: "/app.apk" },
          async () => {
            acted = true;
            return { content: [] };
          },
          recording,
          controller.signal,
        ),
      ).rejects.toThrow("call cancelled");
      expect(acted).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(await journal.list(SCOPE)).toEqual([]);
    },
  );

  test("failed broker recorder recovery warns, skips capture and proceeds with dispatch", async () => {
    const { dispatch } = harness();
    const reader = new FakePriorReader();
    const recording = new SessionDeviceMutationRecording(async () => {
      throw new Error("native assignment unavailable");
    }, reader);
    let acted = false;
    await dispatch(
      "clipboard",
      { action: "clear" },
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    expect(reader.calls).toBe(0);
    expect(acted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Device mutation recording failed; proceeding without recording",
      expect.objectContaining({ message: "native assignment unavailable" }),
    );
  });

  test("unreadable prior state is non-revertible even when support claims it can revert", async () => {
    const { recording, journal, reader } = harness();
    reader.error = new Error("reader unavailable");
    await recording.beforeToolCall("clipboard", { action: "clear" }, DEVICE, SCOPE.sessionUuid);
    expect(
      planDeviceMutationRevert(
        await journal.list(SCOPE),
        { dirty: [], changes: [] },
        { canRevert: () => true },
      ),
    ).toEqual({ status: "non_revertible", reasons: ["Unobservable prior value clipboard:device"] });
  });

  test("unobservable priors never reach platform revert-support predicates", async () => {
    const { recording, journal } = harness();
    await recording.beforeToolCall(
      "installApp",
      { artifactPath: "/app.apk" },
      DEVICE,
      SCOPE.sessionUuid,
    );
    expect(
      planDeviceMutationRevert(
        await journal.list(SCOPE),
        { dirty: [], changes: [] },
        {
          canRevert: () => {
            throw new Error("unknown prior must not be offered to platform revert support");
          },
        },
      ).status,
    ).toBe("non_revertible");
  });

  test("partial journal persistence failure warns and proceeds with a multi-mutation action", async () => {
    const { dispatch, journal } = harness();
    let records = 0;
    let acted = false;
    const recorder = new SessionMutationRecorder(
      {
        list: journal.list.bind(journal),
        getBaseline: journal.getBaseline.bind(journal),
        record: async (scope, mutation) => {
          if (++records === 2) {
            throw new Error("journal unavailable");
          }
          await journal.record(scope, mutation);
        },
      },
      SCOPE,
    );
    const recording = new SessionDeviceMutationRecording(() => recorder, new FakePriorReader());
    await dispatch(
      "setDeviceState",
      { clock: {}, location: {} },
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    expect(acted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Device mutation recording failed; proceeding without recording",
      expect.objectContaining({ message: "journal unavailable" }),
    );
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("failed actions retain their before-act journal entry", async () => {
    const { dispatch, journal } = harness();
    await expect(
      dispatch("clipboard", { action: "clear" }, async () => {
        throw new Error("device failure");
      }),
    ).rejects.toThrow("device failure");
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("read-only resolved targets bypass recording, navigation and audit", async () => {
    const args = { action: "get" };
    expect(
      await invokeResolvedDeviceHandler({
        target: {
          args,
          baseSessionUuid: undefined,
          device: DEVICE,
          internalCall: false,
          sessionUuid: SCOPE.sessionUuid,
          shouldResolveDevice: true,
          deviceRead: { resolve: async () => DEVICE, assertAuthorized: () => {} },
        },
        name: "clipboard",
        args,
        handler: async () => ({ content: [] }),
        mutationRecording: {
          beforeToolCall: async () => {
            throw new Error("read must not record");
          },
        },
        auditRunner: {
          run: async () => {
            throw new Error("read must not audit");
          },
        },
        navigationRecorder: {
          record: () => {
            throw new Error("read must not record navigation");
          },
        },
        isResponseFailure: () => false,
      }),
    ).toEqual({ content: [] });
  });

  test("legacy and sessionless calls perform no recording and no prior-value reads", async () => {
    const reader = new FakePriorReader();
    const recording = new SessionDeviceMutationRecording(() => undefined, reader);
    await recording.beforeToolCall("clipboard", { action: "copy" }, DEVICE, "legacy");
    await recording.beforeToolCall("clipboard", { action: "clear" }, DEVICE);
    expect(reader.calls).toBe(0);
  });

  test("read-only clipboard, display, network, accessibility and keyboard calls create no journal entries", async () => {
    const { recording, journal, reader } = harness();
    for (const [name, args] of [
      ["clipboard", { action: "get" }],
      ["displayConfig", {}],
      ["network", {}],
      ["accessibility", {}],
      ["keyboard", { action: "detect" }],
      ["keyboard", { action: "listImes" }],
      ["keyboard", { action: "listProfiles" }],
    ] as const) {
      await recording.beforeToolCall(name, args, DEVICE, SCOPE.sessionUuid);
    }
    expect(reader.calls).toBe(0);
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("read-only internal calls do not poison the holder's mutation journal", async () => {
    const { recording, journal, reader } = harness();
    const handler = journaledDeviceHandler("keyboard", async () => ({ content: [] }), recording);
    await handler(DEVICE, { action: "listImes", sessionUuid: SCOPE.sessionUuid });
    expect(reader.calls).toBe(0);
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("read-only and pending adapters never resolve a recorder or its database", async () => {
    const reader = new FakePriorReader();
    const recording = new SessionDeviceMutationRecording(() => {
      throw new Error("read must not resolve a recorder");
    }, reader);
    await recording.beforeToolCall("keyboard", { action: "detect" }, DEVICE, SCOPE.sessionUuid);
    await recording.beforeToolCall("setPreference", { key: "theme" }, DEVICE, SCOPE.sessionUuid);
    expect(reader.calls).toBe(0);
  });

  test("a mismatched session or device warns and proceeds without recording", async () => {
    const { recording, journal, reader } = harness();
    let actions = 0;
    for (const [device, sessionUuid] of [
      [DEVICE, "wrong-session"],
      [{ ...DEVICE, deviceId: "other" }, SCOPE.sessionUuid],
    ] as const) {
      const handler = journaledDeviceHandler(
        "clipboard",
        async () => {
          actions++;
          return { content: [] };
        },
        recording,
      );
      await handler(device, { action: "clear", sessionUuid });
    }
    expect(actions).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "Device mutation recording failed; proceeding without recording",
      expect.objectContaining({
        message: "Device mutation recorder must match the admitted broker session and device",
      }),
    );
    expect(reader.calls).toBe(0);
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("first-write wins preserves the original prior value across repeated tool calls", async () => {
    const { recording, journal, reader } = harness();
    reader.priorValue = { state: "present", value: "original" };
    await recording.beforeToolCall("clipboard", { action: "copy" }, DEVICE, SCOPE.sessionUuid);
    reader.priorValue = { state: "present", value: "intermediate" };
    await recording.beforeToolCall("clipboard", { action: "clear" }, DEVICE, SCOPE.sessionUuid);
    expect(await journal.list(SCOPE)).toMatchObject([
      { priorValue: { state: "present", value: "original" } },
    ]);
    expect(await journal.list(SCOPE)).toHaveLength(1);
    expect(reader.calls).toBe(1);
  });

  test("multi-field calls list the journal once and skip previously captured priors", async () => {
    const { recording, journal, reader } = harness();
    const list = spyOn(journal, "list");
    const args = {
      clock: {},
      networkCondition: {},
      screenLock: {},
      doNotDisturb: {},
      connectivity: { wifiEnabled: true, airplaneMode: false, bluetoothEnabled: true },
    };
    try {
      reader.priorValue = { state: "present", value: "original" };
      await recording.beforeToolCall("setDeviceState", args, DEVICE, SCOPE.sessionUuid);
      expect(list).toHaveBeenCalledTimes(1);
      reader.priorValue = { state: "present", value: "changed" };
      await recording.beforeToolCall("setDeviceState", args, DEVICE, SCOPE.sessionUuid);
      expect(list).toHaveBeenCalledTimes(2);
      expect(reader.calls).toBe(1);
      expect((await journal.list(SCOPE)).map((entry) => entry.priorValue)).toEqual(
        deviceToolMutations("setDeviceState", args).map(() => ({
          state: "present",
          value: "original",
        })),
      );
    } finally {
      list.mockRestore();
    }
  });

  test("cancellation during capture prevents recording and dispatch", async () => {
    const controller = new AbortController();
    const { dispatch, journal } = harness();
    const recorder = new SessionMutationRecorder(journal, SCOPE);
    const recording = new SessionDeviceMutationRecording(() => recorder, {
      read: async () => {
        controller.abort();
        return [{ state: "absent" }];
      },
    });
    let acted = false;
    await expect(
      dispatch(
        "clipboard",
        { action: "clear" },
        async () => {
          acted = true;
          return { content: [] };
        },
        recording,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(acted).toBe(false);
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("internal calls cancelled during a failed journal write never reach the handler", async () => {
    const controller = new AbortController();
    const { journal } = harness();
    const recorder = new SessionMutationRecorder(
      {
        list: journal.list.bind(journal),
        getBaseline: journal.getBaseline.bind(journal),
        record: async () => {
          controller.abort(new Error("call cancelled"));
          throw new Error("journal unavailable");
        },
      },
      SCOPE,
    );
    const recording = new SessionDeviceMutationRecording(() => recorder, new FakePriorReader());
    let acted = false;
    const handler = journaledDeviceHandler(
      "clipboard",
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    await expect(
      handler(
        DEVICE,
        { action: "clear", sessionUuid: SCOPE.sessionUuid },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("call cancelled");
    expect(acted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(await journal.list(SCOPE)).toEqual([]);
  });
});

describe("mutation adapter identities", () => {
  test("device state records every requested clock, location, network, biometric and connectivity mutation", () => {
    const entries = deviceToolMutations("setDeviceState", {
      clock: {},
      location: {},
      biometrics: {},
      networkCondition: { appId: "com.example" },
      connectivity: { wifiEnabled: false },
      doNotDisturb: {},
      cameraPoster: {},
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      "location",
      "clock",
      "biometric-enrollment",
      "network-condition",
      "device-setting",
      "device-setting",
      "device-setting",
    ]);
    expect(entries[3].key).toBe('["app","com.example"]');
    expect(entries[6].key).toBe("wifiEnabled");
  });

  test("permission identities isolate apps and users and device-wide reset is explicit", () => {
    expect(
      deviceToolMutations("setAppPermissions", {
        appId: "com.example",
        userId: 10,
        permissions: ["camera"],
        notificationsEnabled: true,
      }),
    ).toEqual([
      { kind: "permission", key: '["com.example",10,"camera"]' },
      { kind: "permission", key: '["com.example",10,"notificationsEnabled"]' },
    ]);
    expect(
      deviceToolMutations("setAppPermissions", {
        action: "reset",
        appId: "com.example",
        permissions: ["all"],
      }),
    ).toEqual([{ kind: "permission", key: "device" }]);
  });

  test("file batches record every path plus namespace deletion and media indexing effects", () => {
    expect(
      deviceToolMutations("putAppFile", {
        target: { domain: "user_files", namespace: "fixtures", reset: true, indexMedia: true },
        userId: 10,
        files: [{ destinationPath: "a.txt" }, { destinationPath: "b.txt" }],
      }),
    ).toHaveLength(4);
    const first = deviceToolMutations("putAppFile", {
      appId: "first",
      container: "documents",
      destinationPath: "a.txt",
    });
    const second = deviceToolMutations("putAppFile", {
      appId: "second",
      container: "documents",
      destinationPath: "a.txt",
    });
    expect(first[0].key).not.toBe(second[0].key);
    expect(
      deviceToolMutations("putAppFile", {
        target: { domain: "media_library" },
        files: [{ destinationPath: "photo.png" }],
      })[0].kind,
    ).toBe("media");
  });

  test("display reset records all settings and app locale cannot collide with system locale", () => {
    expect(deviceToolMutations("displayConfig", { reset: true }).map((entry) => entry.key)).toEqual(
      ["fontScale", "contentSize", "density", "nightMode"],
    );
    expect(
      deviceToolMutations("changeLocalization", { appId: "com.example", locale: "ja-JP" })[0].key,
    ).toBe('["app-locale","com.example"]');
    expect(deviceToolMutations("clipboard", { action: "paste" })).toEqual([
      { kind: "preference", key: "focused-field" },
    ]);
  });
});

describe("review regression coverage", () => {
  test("known derived label sessions explicitly bypass base-device recording and registry recovery", async () => {
    const recording = createRecording({
      sessionManager: () => ({
        getBaseSessionOfDerivedLabel: () => SCOPE.sessionUuid,
        peekSession: () => {
          throw new Error("derived session must not read a base recorder");
        },
      }),
      sessionBrokerService: () => ({
        recoverMutationRecorder: async () => {
          throw new Error("derived session must not query receipts");
        },
      }),
    });
    await recording.beforeToolCall(
      "clipboard",
      { action: "clear" },
      { ...DEVICE, deviceId: "label-phone" },
      `${SCOPE.sessionUuid}:secondary`,
    );
  });

  test("createRecording uses the injected keyboard-profile client factory", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recorder = new SessionMutationRecorder(journal, SCOPE);
    const recording = createRecording(
      {
        sessionManager: () => ({
          getBaseSessionOfDerivedLabel: () => undefined,
          peekSession: () => null,
        }),
        sessionBrokerService: () => ({ recoverMutationRecorder: async () => recorder }),
      },
      {
        keyboardProfilesFor: () => ({
          listKeyboardProfiles: async () => ({ success: true, activeProfileId: "gboard" }),
        }),
      },
    );

    await recording.beforeToolCall("keyboard", { action: "setProfile" }, DEVICE, SCOPE.sessionUuid);

    expect(await journal.list(SCOPE)).toMatchObject([
      {
        kind: "keyboard",
        key: "profile",
        priorValue: { state: "present", value: { profileId: "gboard" } },
      },
    ]);
  });

  test("ToolRegistry injects mutation recording into both dispatch paths and restores overrides", async () => {
    const calls: string[] = [];
    const registry = new ToolRegistryClass(new FakeTimer(), logger, null, {
      beforeToolCall: async (name) => {
        calls.push(name);
      },
    });
    registry.registerDeviceAware(
      "clipboard",
      "test",
      z.object({ action: z.string() }),
      async () => ({ content: [] }),
    );
    await registry.callInternal("clipboard", { action: "clear" }, undefined, undefined, {
      targetDevice: DEVICE,
    });
    const restore = registry.setPipelineOverridesForTesting({
      mutationRecording: {
        beforeToolCall: async (name) => {
          calls.push(`override:${name}`);
        },
      },
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          device: DEVICE,
          internalCall: true,
          shouldResolveDevice: true,
          baseSessionUuid: undefined,
          sessionUuid: undefined,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
    });
    try {
      await registry.callInternal("clipboard", { action: "clear" });
    } finally {
      restore();
    }
    await registry.callInternal("clipboard", { action: "clear" }, undefined, undefined, {
      targetDevice: DEVICE,
    });
    expect(calls).toEqual(["clipboard", "override:clipboard", "clipboard"]);
  });

  test("every setDeviceState schema state field records an intent, including future fields", async () => {
    const routingKeys = new Set(Object.keys(addDeviceTargetingToSchema(z.object({})).shape));
    const keys = Object.keys(setDeviceStateSchema.shape).filter((key) => !routingKeys.has(key));
    expect(keys).toContain("screenLock");
    for (const key of keys) {
      const { recording, journal } = harness();
      const value = key === "connectivity" ? { wifiEnabled: true } : {};
      await recording.beforeToolCall("setDeviceState", { [key]: value }, DEVICE, SCOPE.sessionUuid);
      const entries = await journal.list(SCOPE);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.toolName === "setDeviceState")).toBe(true);
    }
  });

  test("a journaled non-read adapter miss records an opaque unobservable prior", async () => {
    const { recording, journal, reader } = harness();
    reader.priorValue = { state: "present", value: "not an observable opaque prior" };
    await recording.beforeToolCall(
      "setDeviceState",
      { futureSetting: true },
      DEVICE,
      SCOPE.sessionUuid,
    );
    expect(await journal.list(SCOPE)).toMatchObject([
      { kind: "opaque", key: "tool:setDeviceState", priorValue: { state: "unobservable" } },
    ]);
    expect(deviceToolMutations("setDeviceState", { screenLock: { type: "none" } })).toEqual([
      { kind: "device-setting", key: "screenLock" },
    ]);
  });

  test("secondary-display rotation cannot claim a device-global restore prior", () => {
    expect(deviceToolMutations("rotate", { display: 2 })).toEqual([
      { kind: "opaque", key: "display:2" },
    ]);
    expect(deviceToolMutations("rotate", { display: 0 })).toEqual([
      { kind: "rotation", key: "device" },
    ]);
  });

  test("transient actions have explicit exemptions and never resolve a recorder", async () => {
    const recording = new SessionDeviceMutationRecording(() => {
      throw new Error("transient action must not resolve a recorder");
    }, new FakePriorReader());
    for (const [name, exemption] of Object.entries(DEVICE_MUTATION_CALL_EXEMPTIONS)) {
      expect(exemption.status).toBe("notJournaled");
      expect(exemption.reason.trim().length).toBeGreaterThan(0);
      for (const action of exemption.actions) {
        await recording.beforeToolCall(name, { action }, DEVICE, SCOPE.sessionUuid);
      }
    }
    expect(deviceToolMutations("keyboard", { action: "selectIme" })).toHaveLength(1);
    expect(deviceToolMutations("keyboard", { action: "setProfile" })).toEqual([
      { kind: "keyboard", key: "profile" },
    ]);
    expect(deviceToolMutations("keyboard", { action: "tapImeKey" })).toEqual([
      { kind: "keyboard", key: "tool:keyboard" },
    ]);
    expect(deviceToolMutations("biometricAuth", { action: "enroll" })).toHaveLength(1);
  });

  test("installed app identity matches uninstall and baseline and allows reverting a new app", async () => {
    const { recording, journal } = harness();
    await journal.captureBaseline(SCOPE, {
      completeKinds: ["installed-app"],
      observations: [],
      unobservable: [],
    });
    await recording.beforeToolCall(
      "installApp",
      { artifactPath: "/app.apk" },
      DEVICE,
      SCOPE.sessionUuid,
    );
    const entries = await journal.list(SCOPE);
    expect(entries).toMatchObject([
      { kind: "installed-app", key: "com.example", priorValue: { state: "absent" } },
    ]);
    expect(deviceToolMutations("uninstallApp", { appId: "com.example" })[0].key).toBe(
      entries[0].key,
    );
    expect(
      planDeviceMutationRevert(entries, { changes: [], dirty: [] }, { canRevert: () => true })
        .status,
    ).toBe("revertible");
  });

  test("artifact metadata uses the existing platform readers through injected fakes", async () => {
    const signal = new AbortController().signal;
    const reader = createDefaultMutationArtifactReader(
      () => ({
        extractPackageName: async (artifact, actualSignal) => {
          expect(artifact).toBe("/app.apk");
          expect(actualSignal).toBe(signal);
          return { packageName: "com.android.app" };
        },
      }),
      () => ({ resolveAppBundleId: async () => "com.ios.app" }),
    );
    expect(await reader.appId(DEVICE, { artifactPath: "/app.apk" }, signal)).toBe(
      "com.android.app",
    );
    expect(
      await reader.appId({ ...DEVICE, platform: "ios" }, { artifactPath: "/app.app" }, signal),
    ).toBe("com.ios.app");
  });

  test("readable state, rotation and screen reader priors use legacy device keys and the call signal", async () => {
    const signal = new AbortController().signal;
    const reader = new DefaultMutationPriorReader(
      {
        read: async (_device, _keys, actualSignal) => {
          expect(actualSignal).toBe(signal);
          return { fontScale: 1 };
        },
      },
      () => ({ execute: async () => ({ success: false, action: "get" }) }),
      () => ({
        getBiometricEnrollmentState: async (actualSignal) => {
          expect(actualSignal).toBe(signal);
          return { supported: true, verified: true, enrollment: "enrolled" };
        },
      }),
      () => ({
        getState: async (fields, actualSignal) => {
          expect(actualSignal).toBe(signal);
          expect(fields).toEqual([
            "clock",
            "networkCondition",
            "doNotDisturb",
            "screenLock",
            "connectivity",
          ]);
          return {
            success: true,
            deviceId: DEVICE.deviceId,
            platform: "android",
            doNotDisturb: { supported: true, mode: "off" },
            connectivity: { supported: true, wifiEnabled: false },
            clock: {
              supported: true,
              capability: "full",
              instant: "2026-10-21T00:00:00Z",
              automaticTime: true,
            },
            networkCondition: { supported: true, profile: "none" },
            screenLock: { supported: true, type: "none", secure: false },
          };
        },
      }),
      () => ({
        getRestoreState: async (actualSignal) => {
          expect(actualSignal).toBe(signal);
          return { accelerometerRotation: 1, userRotation: 0 };
        },
      }),
      { screenReaderFor: () => ({ getEnabled: async () => false }) },
    );
    const mutations = [
      ...deviceToolMutations("setDeviceState", {
        doNotDisturb: {},
        connectivity: { wifiEnabled: true },
        clock: {},
        networkCondition: {},
        screenLock: {},
      }),
      ...deviceToolMutations("rotate", {}),
      ...deviceToolMutations("accessibility", { talkback: true }),
      ...deviceToolMutations("displayConfig", { fontScale: 2 }),
      ...deviceToolMutations("biometricAuth", { action: "enroll" }),
    ];
    const priors = await reader.read(DEVICE, mutations, signal);
    expect(priors.every((prior) => prior.state === "present")).toBe(true);
    expect(
      mutations
        .filter((mutation) => ["rotation", "screen-reader"].includes(mutation.kind))
        .map((mutation) => mutation.key),
    ).toEqual(["device", "device"]);
  });
});

describe("existing cheap mutation prior readers", () => {
  test("iOS rotation records an unobservable prior without invoking Android orientation reads", async () => {
    let rotationReads = 0;
    const reader = new DefaultMutationPriorReader(
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        getRestoreState: async () => {
          rotationReads++;
          return { orientation: "portrait" };
        },
      }),
    );
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recorder = new SessionMutationRecorder(journal, SCOPE);
    const recording = new SessionDeviceMutationRecording(() => recorder, reader);
    let acted = false;
    const handler = journaledDeviceHandler(
      "rotate",
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    await handler(
      { ...DEVICE, platform: "ios" },
      { orientation: "landscape", sessionUuid: SCOPE.sessionUuid },
    );
    expect(acted).toBe(true);
    expect(rotationReads).toBe(0);
    expect(await journal.list(SCOPE)).toMatchObject([
      { kind: "rotation", key: "device", priorValue: { state: "unobservable" } },
    ]);
  });

  test.each(["gboard", undefined, ""])(
    "keyboard setProfile captures active profile %s or records unobservable and still dispatches",
    async (activeProfileId) => {
      let profileReads = 0;
      const reader = new DefaultMutationPriorReader(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          keyboardProfilesFor: () => ({
            listKeyboardProfiles: async () => {
              profileReads++;
              return { success: true, activeProfileId };
            },
          }),
        },
      );
      const journal = new FakeDeviceMutationJournal(new FakeTimer());
      const recording = new SessionDeviceMutationRecording(
        () => new SessionMutationRecorder(journal, SCOPE),
        reader,
      );
      let actions = 0;
      const handler = journaledDeviceHandler(
        "keyboard",
        async () => {
          actions++;
          return { content: [] };
        },
        recording,
      );
      await handler(DEVICE, {
        action: "setProfile",
        profile: "direct",
        sessionUuid: SCOPE.sessionUuid,
      });
      await handler(DEVICE, { action: "tapImeKey", sessionUuid: SCOPE.sessionUuid });
      await handler(DEVICE, {
        action: "setProfile",
        profile: "samsung",
        sessionUuid: SCOPE.sessionUuid,
      });
      expect(actions).toBe(3);
      expect(profileReads).toBe(1);
      expect(await journal.list(SCOPE)).toMatchObject([
        {
          kind: "keyboard",
          key: "profile",
          priorValue: activeProfileId
            ? { state: "present", value: { profileId: activeProfileId } }
            : { state: "unobservable" },
        },
        { kind: "keyboard", key: "tool:keyboard", priorValue: { state: "unobservable" } },
      ]);
    },
  );

  test("failed keyboard profile reads record unobservable without preventing the action", async () => {
    const reader = new DefaultMutationPriorReader(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        keyboardProfilesFor: () => ({
          listKeyboardProfiles: async () => {
            throw new Error("profile unreadable");
          },
        }),
      },
    );
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, SCOPE),
      reader,
    );
    let acted = false;
    const handler = journaledDeviceHandler(
      "keyboard",
      async () => {
        acted = true;
        return { content: [] };
      },
      recording,
    );
    await handler(DEVICE, {
      action: "setProfile",
      profile: "direct",
      sessionUuid: SCOPE.sessionUuid,
    });
    expect(acted).toBe(true);
    expect(await journal.list(SCOPE)).toMatchObject([
      { kind: "keyboard", key: "profile", priorValue: { state: "unobservable" } },
    ]);
  });

  test("verified biometric enrollment is read before mutation without recording transient auth state as enrollment", async () => {
    let reads = 0;
    const reader = new DefaultMutationPriorReader(
      { read: async () => ({}) },
      () => ({ execute: async () => ({ success: false, action: "get" }) }),
      () => ({
        getBiometricEnrollmentState: async () => {
          reads++;
          return { supported: true, verified: true, enrollment: "not_enrolled" };
        },
      }),
    );
    expect(await reader.read(DEVICE, [{ kind: "biometric-enrollment", key: "device" }])).toEqual([
      { state: "present", value: "not_enrolled" },
    ]);
    expect(
      await reader.read(DEVICE, [{ kind: "biometric-enrollment", key: "auth-override" }]),
    ).toEqual([{ state: "unobservable" }]);
    expect(reads).toBe(1);
  });

  test("unverified biometric enrollment remains non-revertible", async () => {
    const reader = new DefaultMutationPriorReader(
      { read: async () => ({}) },
      () => ({ execute: async () => ({ success: false, action: "get" }) }),
      () => ({
        getBiometricEnrollmentState: async () => ({ supported: true, enrollment: "enrolled" }),
      }),
    );
    expect(await reader.read(DEVICE, [{ kind: "biometric-enrollment", key: "device" }])).toEqual([
      { state: "unobservable" },
    ]);
  });

  test("restorable settings distinguish missing prior state from an absent setting", async () => {
    const reader = new DefaultMutationPriorReader(
      { read: async () => ({ fontScale: 1.25, timeFormat: null }) },
      () => ({ execute: async () => ({ success: true, action: "get", text: "" }) }),
    );
    expect(
      await reader.read(DEVICE, [
        { kind: "device-setting", key: "fontScale" },
        { kind: "device-setting", key: "timeFormat" },
        { kind: "device-setting", key: "density" },
        { kind: "clipboard", key: "device" },
      ]),
    ).toEqual([
      { state: "present", value: 1.25 },
      { state: "absent" },
      { state: "unobservable" },
      { state: "present", value: "" },
    ]);
  });

  test("failed clipboard reads are unobservable, never absent", async () => {
    const reader = new DefaultMutationPriorReader({ read: async () => ({}) }, () => ({
      execute: async () => ({ success: false, action: "get" }),
    }));
    expect(await reader.read(DEVICE, [{ kind: "clipboard", key: "device" }])).toEqual([
      { state: "unobservable" },
    ]);
  });
});
