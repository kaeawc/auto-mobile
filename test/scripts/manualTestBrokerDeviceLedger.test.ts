import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  BrokerDeviceLedger,
  classifyDevice,
  assertReleasedAndAbsent,
  leakReport,
  type LedgerDevicesView,
} from "../../scripts/manual-test/brokerDeviceLedger";
import type { SessionBrokerResult } from "../../src/models/sessionBrokerResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const device = {
  name: "ambroker-ledger-device",
  deviceId: "emulator-5556",
  platform: "android" as const,
};
function fixture() {
  const timer = new FakeTimer();
  const ids = new FakeIdGenerator();
  const sessionUuid = ids.next();
  const init = { session: { outcome: "ready", requestId: "batch-phone-1", sessionUuid } };
  const files = new Map<string, string>();
  const appends: Array<{ path: string; text: string }> = [];
  const fs = {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path)!,
    mkdir: () => {},
    appendFile: (path: string, text: string) => {
      appends.push({ path, text });
      files.set(path, (files.get(path) ?? "") + text);
    },
  };
  const options = { batchDir: "/batch", fs, timer, tokenFor: () => "secret" };
  const ledger = new BrokerDeviceLedger(options);
  const bind = () => ledger.info("phone", init, { sessionId: sessionUuid, nativeDevice: device });
  const broker = new FakeBrokerDaemonClient();
  const released: SessionBrokerResult = {
    contractVersion: 1,
    requestId: init.session.requestId,
    sessionUuid,
    outcome: "released",
    cleanupPending: false,
    profile: null,
  };
  broker.statusResults = [released];
  const view: LedgerDevicesView = { devices: [], daemons: [{ alive: true }] };
  return { timer, init, files, appends, fs, options, ledger, bind, broker, released, view };
}

test.each([
  ["bound", [], "allowed"],
  ["bound", [device.name], "protected"],
  ["bound", [device.deviceId], "protected"],
  ["name-only", [], "foreign"],
  ["name-only", [device.name], "protected"],
  ["plain-name", [], "foreign"],
  ["released", [], "foreign"],
] as const)("classification %s with %j is %s", (kind, protectedList, expected) => {
  const f = fixture();
  if (kind !== "name-only") {
    f.bind();
  }
  if (kind === "released") {
    f.ledger.record("released", f.ledger.devices()[0]);
  }
  const target = kind === "plain-name" ? { ...device, name: "owner-device" } : device;
  expect(classifyDevice(target, f.ledger, [...protectedList])).toBe(expected);
});

test("only ready initialization and matching native info establish a batch grant", () => {
  const f = fixture();
  expect(() =>
    f.ledger.acquired("phone", { session: { ...f.init.session, outcome: "pending" } }),
  ).toThrow();
  expect(() =>
    f.ledger.info("phone", f.init, { sessionId: "foreign", nativeDevice: device }),
  ).toThrow("does not match");
  expect(classifyDevice(device, f.ledger, [])).toBe("foreign");
  f.ledger.acquired("phone", f.init);
  expect(classifyDevice(device, f.ledger, [])).toBe("foreign");
  f.bind();
  expect(() =>
    f.ledger.info("phone", f.init, {
      sessionId: f.init.session.sessionUuid,
      nativeDevice: { ...device, name: "ambroker-other" },
    }),
  ).toThrow("changed");
});

test("serial reuse never authorizes a successor or reports the predecessor as leaked", () => {
  const f = fixture();
  f.bind();
  f.ledger.record("released", f.ledger.devices()[0]);
  const successor = { ...device, name: "ambroker-successor" };
  const view = { devices: [successor] };
  expect(classifyDevice(successor, f.ledger, [])).toBe("foreign");
  expect(leakReport(f.ledger, view)).toEqual([]);
  f.ledger.info(
    "phone",
    { session: { ...f.init.session, requestId: "batch-phone-2", sessionUuid: "new-session" } },
    { sessionId: "new-session", nativeDevice: successor },
  );
  expect(classifyDevice(successor, f.ledger, [])).toBe("allowed");
  expect(f.ledger.devices()).toHaveLength(2);
});

test("JSONL records append in one injected write, preserve concurrent writers and reload grants", () => {
  const f = fixture();
  const other = new BrokerDeviceLedger(f.options);
  f.bind();
  f.timer.advanceTime(10);
  other.info(
    "other",
    { session: { ...f.init.session, sessionUuid: "other-session", requestId: "batch-other-1" } },
    { sessionId: "other-session", nativeDevice: { ...device, name: "ambroker-other" } },
  );
  expect(f.appends).toHaveLength(4);
  for (const append of f.appends) {
    expect(append.path).toBe(join(resolve("/batch"), "evidence/ledger.jsonl"));
    expect(append.text.split("\n")).toHaveLength(2);
    expect(JSON.parse(append.text).at).toBeGreaterThanOrEqual(0);
    expect(append.text).not.toContain("secret");
  }
  const loaded = new BrokerDeviceLedger(f.options);
  expect(loaded.entries).toHaveLength(4);
  expect(loaded.entries.at(-1)?.at).toBe(10);
  expect(classifyDevice(device, loaded, [])).toBe("allowed");
  expect(
    () =>
      new BrokerDeviceLedger({
        ...f.options,
        batchDir: "/foreign",
        fs: { ...f.fs, exists: () => true, readFile: () => f.files.get(f.ledger.path)! },
      }),
  ).toThrow("another batch");
});

test("failed append leaves memory unchanged; truncated and grantless records fail closed", () => {
  const f = fixture();
  const ledger = new BrokerDeviceLedger({
    ...f.options,
    fs: {
      ...f.fs,
      appendFile: () => {
        throw new Error("disk full");
      },
    },
  });
  expect(() => ledger.acquired("phone", f.init)).toThrow("disk full");
  expect(ledger.entries).toEqual([]);
  f.bind();
  const bytes = f.files.get(f.ledger.path)!;
  f.files.set(f.ledger.path, bytes.trimEnd());
  expect(() => new BrokerDeviceLedger(f.options)).toThrow("Incomplete");
  f.files.set(f.ledger.path, bytes.split("\n").slice(1).join("\n"));
  expect(() => new BrokerDeviceLedger(f.options)).toThrow("no ready batch grant");
});

test("absence joins released receipt, cleanup and healthy native inventory using FakeTimer", async () => {
  const f = fixture();
  f.bind();
  f.broker.statusResults = [{ ...f.released, cleanupPending: true }, f.released];
  let polls = 0;
  const pending = assertReleasedAndAbsent({
    ledger: f.ledger,
    daemonClient: f.broker,
    timer: f.timer,
    budgetMs: 1000,
    devicesView: async () => ({ ...f.view, devices: polls++ < 2 ? [device] : [] }),
  });
  await drainUntilQuiescent(f.timer);
  expect(f.ledger.entries.some((row) => row.kind === "released")).toBe(false);
  f.timer.advanceTime(250);
  await drainUntilQuiescent(f.timer);
  expect(leakReport(f.ledger, { devices: [device] })).toHaveLength(1);
  f.timer.advanceTime(250);
  await pending;
  expect(f.ledger.entries.map((row) => row.kind)).toEqual([
    "acquired",
    "info",
    "released",
    "absent",
  ]);
  expect(
    f.broker.calls.every((call) => call.method === "status" && call.args[1] === "secret"),
  ).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test.each([
  "leaked",
  "cleanup",
  "unhealthy",
  "unknown",
  "hung-status",
  "hung-view",
  "wrong-session",
])("absence cannot succeed on %s and stays bounded", async (mode) => {
  const f = fixture();
  f.bind();
  if (mode === "cleanup") {
    f.broker.statusResults = [{ ...f.released, cleanupPending: true }];
  }
  if (mode === "unknown") {
    f.broker.statusResults = [undefined];
  }
  if (mode === "wrong-session") {
    f.broker.statusResults = [{ ...f.released, sessionUuid: "other" }];
  }
  if (mode === "hung-status") {
    f.broker.status = () => new Promise(() => {});
  }
  const pending = assertReleasedAndAbsent({
    ledger: f.ledger,
    daemonClient: f.broker,
    timer: f.timer,
    budgetMs: 500,
    devicesView: async () =>
      mode === "hung-view"
        ? new Promise(() => {})
        : {
            devices: mode === "leaked" ? [device] : [],
            daemons: [{ alive: mode !== "unhealthy" }],
          },
  });
  const result = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(500);
  expect(await result).toBeInstanceOf(Error);
  expect(f.ledger.entries.some((row) => row.kind === "absent")).toBe(false);
  expect(f.ledger.entries.some((row) => row.kind === "leaked")).toBe(mode === "leaked");
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
  f.timer.reset();
});

test("empty evidence never proves absence", async () => {
  const f = fixture();
  await expect(
    assertReleasedAndAbsent({
      ledger: f.ledger,
      daemonClient: f.broker,
      timer: f.timer,
      budgetMs: 10,
      devicesView: async () => f.view,
    }),
  ).rejects.toThrow("No native device info");
});

test("a recycled serial with unreadable native name cannot prove absence", () => {
  const f = fixture();
  f.bind();
  f.ledger.record("released", f.ledger.devices()[0]);
  expect(
    leakReport(f.ledger, { devices: [{ ...device, name: `Unknown (${device.deviceId})` }] }),
  ).toHaveLength(1);
});

test("late inventory completion after the deadline cannot append absence", async () => {
  const f = fixture();
  f.bind();
  let complete: (view: LedgerDevicesView) => void = () => {};
  const pending = assertReleasedAndAbsent({
    ledger: f.ledger,
    daemonClient: f.broker,
    timer: f.timer,
    budgetMs: 500,
    devicesView: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const result = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(500);
  expect(await result).toBeInstanceOf(Error);
  const count = f.appends.length;
  complete(f.view);
  await drainUntilQuiescent(f.timer);
  expect(f.appends.length).toBe(count);
  expect(f.ledger.entries.some((row) => row.kind === "absent")).toBe(false);
});

test("a grant cannot move to another client or change its session UUID", () => {
  const f = fixture();
  f.bind();
  expect(() => f.ledger.acquired("other", f.init)).toThrow("conflicts");
  expect(() =>
    f.ledger.acquired("phone", { session: { ...f.init.session, sessionUuid: "changed" } }),
  ).toThrow("conflicts");
  expect(classifyDevice(device, f.ledger, [])).toBe("allowed");
});

test("release evidence persists even when native info was never collected", () => {
  const f = fixture();
  const grant = f.ledger.acquired("phone", f.init);
  f.ledger.record("released", grant);
  const loaded = new BrokerDeviceLedger(f.options);
  expect(loaded.entries.map((entry) => entry.kind)).toEqual(["acquired", "released"]);
  expect(loaded.devices()).toEqual([]);
  expect(classifyDevice(device, loaded, [])).toBe("foreign");
});
