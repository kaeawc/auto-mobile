import { beforeEach, describe, expect, test } from "bun:test";
import {
  diffDeviceBaseline,
  REQUIRED_BASELINE_KINDS,
} from "../../../src/daemon/sessionBroker/mutations/baseline";
import { planDeviceMutationRevert } from "../../../src/daemon/sessionBroker/mutations/revertPlanner";
import {
  captureFirstDeviceBaseline,
  revertDeviceMutations,
  type DeviceMutationResetOptions,
} from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceBaseline,
  DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeDeviceMutationResetPort } from "../../fakes/FakeDeviceMutationResetPort";
import { FakeTimer } from "../../fakes/FakeTimer";

const SCOPE = { sessionUuid: "session-a", deviceId: "phone", incarnation: "generation-1" };
const BASELINE: DeviceBaseline = {
  completeKinds: [...REQUIRED_BASELINE_KINDS],
  observations: [{ kind: "clipboard", key: "device", value: { state: "present", value: "" } }],
  unobservable: [],
};
const CLIPBOARD: DeviceMutationInput = {
  kind: "clipboard",
  key: "device",
  priorValue: { state: "present", value: "" },
  toolName: "clipboard",
};

describe("device mutation reset contract", () => {
  let timer: FakeTimer;
  let journal: FakeDeviceMutationJournal;
  let port: FakeDeviceMutationResetPort;
  let options: DeviceMutationResetOptions;

  beforeEach(async () => {
    timer = new FakeTimer();
    journal = new FakeDeviceMutationJournal(timer);
    port = new FakeDeviceMutationResetPort(structuredClone(BASELINE));
    options = { scope: SCOPE, journal, port, timer, budgetMs: 50, assertOwned: async () => {} };
    await journal.captureBaseline(SCOPE, BASELINE);
  });

  test("an app installed outside tools is detected and generically uninstalled", async () => {
    port.snapshot.observations.push({
      kind: "installed-app",
      key: "external.app",
      value: { state: "present", value: { version: "1" } },
    });
    expect(diffDeviceBaseline(BASELINE, port.snapshot).changes[0].journaled).toBe(false);
    expect(await revertDeviceMutations(options)).toEqual({ status: "clean" });
    expect(port.reverted).toEqual([
      {
        kind: "installed-app",
        key: "external.app",
        priorValue: { state: "absent" },
        toolName: "baseline-diff",
      },
    ]);
  });

  test("an unjournaled permission or shared file marks reset non-revertible", async () => {
    for (const kind of ["permission", "shared-file"]) {
      port.snapshot.observations = [
        { kind, key: "external", value: { state: "present", value: true } },
      ];
      expect(await revertDeviceMutations(options)).toMatchObject({
        status: "non_clean",
        reason: "non_revertible",
      });
      expect(port.reverted).toEqual([]);
    }
  });

  test("unknown journal kinds require fallback instead of clean, even without an observable diff", async () => {
    await journal.record(SCOPE, { ...CLIPBOARD, kind: "future-kind" });
    const entries = await journal.list(SCOPE);
    expect(diffDeviceBaseline(BASELINE, port.snapshot, entries).dirty).toContain(
      "baseline: incomplete future-kind inventory",
    );
    expect(
      planDeviceMutationRevert(entries, diffDeviceBaseline(BASELINE, port.snapshot, entries), port)
        .status,
    ).toBe("non_revertible");
    const result = await revertDeviceMutations(options);
    let fallbackRequired = false;
    if (result.status === "non_clean") {
      fallbackRequired = true;
    }
    expect(fallbackRequired).toBe(true);
    expect(result).toMatchObject({ status: "non_clean", reason: "non_revertible" });
    expect(port.reverted).toEqual([]);
  });

  test("known kinds without a qualified platform adapter also require fallback", async () => {
    await journal.record(SCOPE, CLIPBOARD);
    port.unsupportedKinds.add("clipboard");
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
  });

  test("journal replay is reverse-ordered and idempotent across two resets", async () => {
    await journal.record(SCOPE, {
      kind: "installed-app",
      key: "session.app",
      priorValue: { state: "absent" },
      toolName: "installApp",
    });
    await journal.record(SCOPE, CLIPBOARD);
    port.snapshot.observations = [
      { kind: "installed-app", key: "session.app", value: { state: "present", value: true } },
      { kind: "clipboard", key: "device", value: { state: "present", value: "secret" } },
    ];
    expect(await revertDeviceMutations(options)).toEqual({ status: "clean" });
    expect(port.reverted.map((entry) => entry.kind)).toEqual(["clipboard", "installed-app"]);
    const once = structuredClone(port.snapshot);
    expect(await revertDeviceMutations(options)).toEqual({ status: "clean" });
    expect(port.snapshot).toEqual(once);
    expect(await journal.list(SCOPE)).toHaveLength(2);
  });

  test("successful write receipts without authoritative readback cannot report clean", async () => {
    await journal.record(SCOPE, CLIPBOARD);
    port.snapshot.observations[0].value = { state: "present", value: "not-cleared" };
    port.ignoreWrites = true;
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "verification_failed",
    });
  });

  test("missing baseline for a replacement incarnation cannot report clean", async () => {
    expect(
      await revertDeviceMutations({ ...options, scope: { ...SCOPE, incarnation: "generation-2" } }),
    ).toMatchObject({ status: "non_clean", reason: "baseline_missing" });
    expect(port.captureCount).toBe(0);
  });

  test("partial or unobservable inventories fail closed even when values match", async () => {
    port.snapshot.completeKinds = ["clipboard"];
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
    port.snapshot = { ...structuredClone(BASELINE), unobservable: ["keychain"] };
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
  });

  test("a known unobservable baseline short-circuits before native capture", async () => {
    const incompleteScope = { ...SCOPE, incarnation: "unobservable" };
    await journal.captureBaseline(incompleteScope, { ...BASELINE, unobservable: ["account"] });
    expect(await revertDeviceMutations({ ...options, scope: incompleteScope })).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
    expect(port.captureCount).toBe(0);
    expect(port.reverted).toEqual([]);
  });

  test("journaled mutations outside the observable baseline cannot falsely verify clean", async () => {
    port.snapshot.completeKinds = port.snapshot.completeKinds.filter((kind) => kind !== "keychain");
    await journal.record(SCOPE, { ...CLIPBOARD, kind: "keychain" });
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
    expect(port.reverted).toEqual([]);
  });

  test("dropping an inventory at reset cannot falsely verify clean", () => {
    const current = {
      ...BASELINE,
      completeKinds: BASELINE.completeKinds.filter((kind) => kind !== "clock"),
    };
    expect(diffDeviceBaseline(BASELINE, current).dirty).toContain(
      "current: incomplete clock inventory",
    );
  });

  test.each([...REQUIRED_BASELINE_KINDS])(
    "omitted %s inventory in either snapshot fails closed",
    (kind) => {
      const partial = {
        ...BASELINE,
        completeKinds: BASELINE.completeKinds.filter((entry) => entry !== kind),
      };
      expect(diffDeviceBaseline(partial, BASELINE).dirty).toContain(
        `baseline: incomplete ${kind} inventory`,
      );
      expect(diffDeviceBaseline(BASELINE, partial).dirty).toContain(
        `current: incomplete ${kind} inventory`,
      );
    },
  );

  test("external app uninstall cannot certify clean without keychain and app-group inventory", async () => {
    port.snapshot.completeKinds = port.snapshot.completeKinds.filter(
      (kind) => !["keychain", "app-group"].includes(kind),
    );
    port.snapshot.observations.push({
      kind: "installed-app",
      key: "external.app",
      value: { state: "present", value: true },
    });
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "non_revertible",
    });
    expect(port.reverted).toEqual([]);
  });

  test("duplicate observations cannot be silently collapsed into a clean baseline", () => {
    const duplicate = {
      ...BASELINE,
      observations: [...BASELINE.observations, ...BASELINE.observations],
    };
    expect(diffDeviceBaseline(BASELINE, duplicate).dirty).toContain(
      "current: duplicate observations",
    );
  });

  test("object property ordering is not a baseline mutation", () => {
    const before = {
      ...BASELINE,
      observations: [
        {
          kind: "permission",
          key: "app",
          value: { state: "present" as const, value: { first: 1, second: 2 } },
        },
      ],
    };
    const after = {
      ...BASELINE,
      observations: [
        {
          kind: "permission",
          key: "app",
          value: { state: "present" as const, value: { second: 2, first: 1 } },
        },
      ],
    };
    expect(diffDeviceBaseline(before, after).changes).toEqual([]);
  });

  test("ownership loss at the actual platform dispatch prevents a stale write", async () => {
    await journal.record(SCOPE, CLIPBOARD);
    let owned = true;
    options.assertOwned = async () => {
      if (!owned) {
        throw new Error("owner replaced");
      }
    };
    port.beforeWrite = async () => {
      owned = false;
    };
    expect(await revertDeviceMutations(options)).toMatchObject({
      status: "non_clean",
      reason: "reset_failed",
    });
    expect(port.reverted).toEqual([]);
  });

  test("total-budget exhaustion aborts late dispatch and retains recovery entries", async () => {
    await journal.record(SCOPE, CLIPBOARD);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    port.beforeWrite = async () => {
      reached.resolve();
      await release.promise;
    };
    const result = revertDeviceMutations(options);
    await reached.promise;
    timer.advanceTime(51);
    expect(await result).toMatchObject({ status: "non_clean", reason: "reset_failed" });
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.reverted).toEqual([]);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("first-pool capture never overwrites an existing incarnation baseline", async () => {
    const context = {
      scope: SCOPE,
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
    await captureFirstDeviceBaseline(journal, port, context);
    expect(port.captureCount).toBe(0);
    const fresh = { ...context, scope: { ...SCOPE, incarnation: "generation-2" } };
    await captureFirstDeviceBaseline(journal, port, fresh);
    expect(port.captureCount).toBe(1);
    expect(await journal.getBaseline(fresh.scope)).toEqual(BASELINE);
  });

  test("an empty unobservable capture is never persisted as an immutable baseline", async () => {
    const context = {
      scope: { ...SCOPE, incarnation: "fresh" },
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
    port.snapshot = { completeKinds: [], observations: [], unobservable: ["installed-app"] };
    await expect(captureFirstDeviceBaseline(journal, port, context)).rejects.toThrow(
      "no observable inventory",
    );
    expect(await journal.getBaseline(context.scope)).toBeNull();
    port.snapshot = structuredClone(BASELINE);
    await captureFirstDeviceBaseline(journal, port, context);
    expect(await journal.getBaseline(context.scope)).toEqual(BASELINE);
  });

  test("non-positive or overflowing reset budgets are rejected before device access", async () => {
    for (const budgetMs of [0, -1, Infinity, 2_147_483_648]) {
      await expect(revertDeviceMutations({ ...options, budgetMs })).rejects.toThrow(
        "positive total budget",
      );
    }
    expect(port.captureCount).toBe(0);
  });
});
