import { expect, test } from "bun:test";
import {
  IosProtoViewer,
  type IosProtoViewerFiles,
  type IosProtoViewerSimctl,
} from "../../../../src/features/prototype/protoViewer/IosProtoViewer";
import {
  ProtoViewerInboxUnsupportedError,
  ProtoViewerForegroundError,
  ProtoViewerStorageError,
} from "../../../../src/features/prototype/protoViewer/protoViewerDevice";
import { ActionableError } from "../../../../src/models/ActionableError";
import { SimctlCommandTimeoutError } from "../../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ROOT = "/container/Library/Application Support/ProtoViewer/mcp";
const REQUEST = "mcp-req1";
class Files implements IosProtoViewerFiles {
  events: string[] = [];
  reads = 0;
  pending = 0;
  capability = "file-inbox-v1";
  capabilityPending = 0;
  capabilityReads = 0;
  onResultRead: () => void = () => {};
  resultPaths: string[] = [];
  writes = new Map<string, Uint8Array>();
  result = JSON.stringify({ status: "imported", request: REQUEST, libraryId: ID, label: "Demo" });
  async mkdir(path: string) {
    this.events.push(`mkdir:${path}`);
  }
  async write(path: string, bytes: Uint8Array) {
    this.writes.set(path, bytes);
    this.events.push(`write:${path}`);
  }
  async rename(from: string, to: string) {
    this.events.push(`rename:${from}:${to}`);
  }
  async read(path: string) {
    if (path.endsWith("/delivery")) {
      this.capabilityReads++;
      return this.capabilityReads <= this.capabilityPending ? "" : this.capability;
    }
    this.resultPaths.push(path);
    this.onResultRead();
    this.reads++;
    return this.reads <= this.pending ? "" : this.result;
  }
  async remove(path: string) {
    this.events.push(`remove:${path}`);
  }
}
class Simctl implements IosProtoViewerSimctl {
  present = true;
  container = "/container";
  failure?: Error;
  onOpen: () => void = () => {};
  argv: readonly string[] = [];
  calls: string[] = [];
  launchFailure?: Error;
  onLaunch: () => void = () => {};
  async launch(udid: string, _timeoutMs: number) {
    this.calls.push(`launch:${udid}`);
    this.onLaunch();
    if (this.launchFailure) {
      throw this.launchFailure;
    }
  }
  async installed(_udid: string) {
    return this.present;
  }
  async dataContainer(_udid: string) {
    return this.container;
  }
  async openurl(args: readonly string[]) {
    this.argv = args;
    this.calls.push("openurl");
    this.onOpen();
    if (this.failure) {
      throw this.failure;
    }
  }
}
function setup(deviceId = UDID) {
  const files = new Files();
  const simctl = new Simctl();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const ids = new FakeIdGenerator();
  ids.setScripted(["req1"]);
  const viewer = new IosProtoViewer({ deviceId, files, simctl, timer, ids });
  return { viewer, files, simctl, timer };
}
test("iOS imports atomically through request JSON, foregrounds and polls pending results", async () => {
  const { viewer, files, simctl } = setup();
  files.pending = 3;
  expect(await viewer.installed()).toBe(true);
  expect((await viewer.importBundle(new Uint8Array([1]), "It's & café", 2000)).status).toBe(
    "imported",
  );
  expect(simctl.argv).toEqual([]);
  expect(simctl.calls).toEqual([`launch:${UDID}`]);
  expect(
    JSON.parse(new TextDecoder().decode(files.writes.get(`${ROOT}/inbox/${REQUEST}.request.tmp`))),
  ).toEqual({ action: "import", label: "It's & café" });
  expect(files.events).toContain(
    `rename:${ROOT}/inbox/${REQUEST}.request.tmp:${ROOT}/inbox/${REQUEST}.request`,
  );
  expect(files.events.slice(0, 4)).toEqual([
    `mkdir:${ROOT}/inbox`,
    `mkdir:${ROOT}/results`,
    `write:${ROOT}/inbox/${REQUEST}.automobile-proto.tmp`,
    `rename:${ROOT}/inbox/${REQUEST}.automobile-proto.tmp:${ROOT}/inbox/${REQUEST}.automobile-proto`,
  ]);
  expect(files.reads).toBe(4);
  expect(files.resultPaths).toEqual(Array(4).fill(`${ROOT}/results/${REQUEST}.json`));
  expect(files.events).toContain(`remove:${ROOT}/results/${REQUEST}.json`);
  expect(files.events).toContain(`remove:${ROOT}/inbox/${REQUEST}.automobile-proto`);
});
test("iOS omits an absent label and opens by library id", async () => {
  const { viewer, files, simctl } = setup();
  await viewer.importBundle(new Uint8Array([1]), undefined, 1000);
  expect(
    JSON.parse(new TextDecoder().decode(files.writes.get(`${ROOT}/inbox/${REQUEST}.request.tmp`))),
  ).toEqual({ action: "import" });
  expect(simctl.argv).toEqual([]);
  const next = setup();
  next.files.result = JSON.stringify({
    status: "opened",
    request: REQUEST,
    libraryId: ID,
    label: "Demo",
  });
  expect((await next.viewer.open(ID, 1000)).status).toBe("opened");
  expect(
    JSON.parse(
      new TextDecoder().decode(next.files.writes.get(`${ROOT}/inbox/${REQUEST}.request.tmp`)),
    ),
  ).toEqual({ action: "open", libraryId: ID });
  expect(next.simctl.calls).toEqual([`launch:${UDID}`]);
});
test("iOS mismatched requests and invalid results fail", async () => {
  for (const result of [
    JSON.stringify({ status: "not_found", request: "other" }),
    "bad json",
    "{}",
  ]) {
    const { viewer, files } = setup();
    files.result = result;
    await expect(viewer.open(ID, 1000)).rejects.toThrow();
  }
});
test("iOS empty reads remain pending until the deadline with safe retry guidance", async () => {
  const { viewer, files } = setup();
  files.pending = 100;
  await expect(viewer.importBundle(new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
    "Retrying the same spec is safe",
  );
  expect(files.reads).toBe(4);
  for (const suffix of [".request", ".request.tmp", ".automobile-proto", ".automobile-proto.tmp"]) {
    expect(files.events).toContain(`remove:${ROOT}/inbox/${REQUEST}${suffix}`);
  }
});
test("iOS cancellation still cleans result, inbox and temporary files", async () => {
  const { viewer, files, simctl } = setup();
  const controller = new AbortController();
  simctl.onLaunch = () => controller.abort();
  await expect(
    viewer.importBundle(new Uint8Array([1]), undefined, 1000, controller.signal),
  ).rejects.toThrow();
  for (const path of [
    `results/${REQUEST}.json`,
    `inbox/${REQUEST}.automobile-proto`,
    `inbox/${REQUEST}.automobile-proto.tmp`,
    `inbox/${REQUEST}.request`,
    `inbox/${REQUEST}.request.tmp`,
  ]) {
    expect(files.events).toContain(`remove:${ROOT}/${path}`);
  }
});
test("iOS URL-only builds fail with an actionable typed error and clean up", async () => {
  const { viewer, simctl, files } = setup();
  files.capability = "";
  await expect(viewer.open(ID, 1000)).rejects.toBeInstanceOf(ProtoViewerInboxUnsupportedError);
  expect(simctl.calls).toEqual([`launch:${UDID}`]);
  expect(files.events).toContain(`remove:${ROOT}/inbox/${REQUEST}.request`);
  expect(files.events).toContain(`remove:${ROOT}/inbox/${REQUEST}.automobile-proto`);
});
test("iOS unresolved container and inbox rejection are storage fallback", async () => {
  const first = setup();
  first.simctl.container = "";
  await expect(first.viewer.open(ID, 1000)).rejects.toBeInstanceOf(ProtoViewerStorageError);
  const second = setup();
  second.files.result = JSON.stringify({
    status: "rejected",
    request: REQUEST,
    path: "inbox",
    reason: "missing",
  });
  await expect(
    second.viewer.importBundle(new Uint8Array([1]), undefined, 1000),
  ).rejects.toBeInstanceOf(ProtoViewerStorageError);
});
test("physical iOS devices never probe simctl", async () => {
  const { viewer } = setup("00008110-001234567890001E");
  expect(await viewer.installed()).toBe(false);
});
test("iOS delivery and polling share one timeout budget", async () => {
  const { viewer, files, simctl, timer } = setup();
  files.pending = 10_000;
  const started = timer.now();
  simctl.onLaunch = () => {
    void timer.advanceTime(4000);
  };
  await expect(viewer.importBundle(new Uint8Array([1]), undefined, 5000)).rejects.toThrow(
    "Retrying the same spec is safe",
  );
  // Not 4000 (delivery) plus another full 5000.
  expect(timer.now() - started).toBeLessThan(7000);
});

test("iOS foregrounds with launch and never calls openurl", async () => {
  const { viewer, simctl } = setup();
  await viewer.importBundle(new Uint8Array([1]), undefined, 1000);
  expect(simctl.calls).toEqual([`launch:${UDID}`]);
});
test.each(["import", "open"] as const)(
  "iOS %s fails actionably without request delivery or polling when launch fails",
  async (action) => {
    for (const failure of [new Error("launch failed"), new SimctlCommandTimeoutError("deadline")]) {
      const { viewer, simctl, files, timer } = setup();
      simctl.launchFailure = failure;
      files.pending = 10_000;
      const result =
        action === "import"
          ? viewer.importBundle(new Uint8Array([1]), undefined, 15_000)
          : viewer.open(ID, 15_000);
      await expect(result).rejects.toBeInstanceOf(ProtoViewerForegroundError);
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toMatchObject({
        name: "ProtoViewerForegroundError",
        message:
          "Could not bring ProtoViewer to the foreground on the iOS simulator. Open ProtoViewer manually and retry.",
        cause: failure,
      });
      expect(simctl.calls).toEqual([`launch:${UDID}`]);
      expect(files.reads).toBe(0);
      expect(timer.getSleepHistory()).toEqual([]);
      for (const path of [
        `results/${REQUEST}.json`,
        `inbox/${REQUEST}.automobile-proto`,
        `inbox/${REQUEST}.automobile-proto.tmp`,
        `inbox/${REQUEST}.request`,
        `inbox/${REQUEST}.request.tmp`,
      ]) {
        expect(files.events).toContain(`remove:${ROOT}/${path}`);
      }
    }
  },
);
test("iOS preserves cancellation during foreground launch and still cleans up", async () => {
  const { viewer, simctl, files, timer } = setup();
  const controller = new AbortController();
  const cancelled = new Error("caller cancelled launch");
  simctl.onLaunch = () => controller.abort(cancelled);
  simctl.launchFailure = cancelled;
  await expect(
    viewer.importBundle(new Uint8Array([1]), undefined, 15_000, controller.signal),
  ).rejects.toBe(cancelled);
  expect(simctl.calls).toEqual([`launch:${UDID}`]);
  expect(files.reads).toBe(0);
  expect(timer.getSleepHistory()).toEqual([]);
  expect(files.events.filter((event) => event.startsWith("remove:"))).toEqual([
    `remove:${ROOT}/inbox/${REQUEST}.request`,
    `remove:${ROOT}/inbox/${REQUEST}.request.tmp`,
    `remove:${ROOT}/results/${REQUEST}.json`,
    `remove:${ROOT}/inbox/${REQUEST}.automobile-proto`,
    `remove:${ROOT}/inbox/${REQUEST}.automobile-proto.tmp`,
  ]);
});

test("iOS waits for a cold app to publish its file-delivery capability before publishing a command", async () => {
  const { viewer, files, simctl, timer } = setup();
  files.capabilityPending = 2;
  simctl.onLaunch = () => {
    expect(files.writes.has(`${ROOT}/inbox/${REQUEST}.request.tmp`)).toBe(false);
  };
  await viewer.importBundle(new Uint8Array([1]), undefined, 2000);
  expect(files.capabilityReads).toBe(3);
  expect(timer.getSleepHistory()).toEqual([250, 250]);
  expect(files.writes.has(`${ROOT}/inbox/${REQUEST}.request.tmp`)).toBe(true);
});

test("iOS cancellation while polling removes the published command before its bundle", async () => {
  const { viewer, files } = setup();
  const controller = new AbortController();
  files.pending = 100;
  files.onResultRead = () => controller.abort();
  await expect(
    viewer.importBundle(new Uint8Array([1]), undefined, 1000, controller.signal),
  ).rejects.toThrow();
  expect(files.events).toContain(
    `rename:${ROOT}/inbox/${REQUEST}.request.tmp:${ROOT}/inbox/${REQUEST}.request`,
  );
  const removals = files.events.filter((event) => event.startsWith("remove:"));
  expect(removals[0]).toBe(`remove:${ROOT}/inbox/${REQUEST}.request`);
  expect(removals).toContain(`remove:${ROOT}/inbox/${REQUEST}.automobile-proto`);
});
