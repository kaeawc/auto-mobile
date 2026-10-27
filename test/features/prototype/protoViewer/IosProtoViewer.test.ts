import { expect, test } from "bun:test";
import {
  IosProtoViewer,
  type IosProtoViewerFiles,
  type IosProtoViewerSimctl,
} from "../../../../src/features/prototype/protoViewer/IosProtoViewer";
import {
  ProtoViewerEntryPointMissingError,
  ProtoViewerStorageError,
} from "../../../../src/features/prototype/protoViewer/protoViewerDevice";
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
  result = JSON.stringify({ status: "imported", request: REQUEST, libraryId: ID, label: "Demo" });
  async mkdir(path: string) {
    this.events.push(`mkdir:${path}`);
  }
  async write(path: string, _bytes: Uint8Array) {
    this.events.push(`write:${path}`);
  }
  async rename(from: string, to: string) {
    this.events.push(`rename:${from}:${to}`);
  }
  async read(_path: string) {
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
  async launch(udid: string, _timeoutMs: number) {
    this.calls.push(`launch:${udid}`);
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
test("iOS imports atomically, creates folders, encodes argv and polls pending results", async () => {
  const { viewer, files, simctl } = setup();
  files.pending = 3;
  expect(await viewer.installed()).toBe(true);
  expect((await viewer.importBundle(new Uint8Array([1]), "It's & café", 2000)).status).toBe(
    "imported",
  );
  expect(simctl.argv).toEqual([
    "openurl",
    UDID,
    "automobile-proto://import?request=mcp-req1&label=It%27s%20%26%20caf%C3%A9",
  ]);
  expect(files.events.slice(0, 4)).toEqual([
    `mkdir:${ROOT}/inbox`,
    `mkdir:${ROOT}/results`,
    `write:${ROOT}/inbox/${REQUEST}.automobile-proto.tmp`,
    `rename:${ROOT}/inbox/${REQUEST}.automobile-proto.tmp:${ROOT}/inbox/${REQUEST}.automobile-proto`,
  ]);
  expect(files.reads).toBe(4);
  expect(files.events).toContain(`remove:${ROOT}/results/${REQUEST}.json`);
  expect(files.events).toContain(`remove:${ROOT}/inbox/${REQUEST}.automobile-proto`);
});
test("iOS omits an absent label and opens by library id", async () => {
  const { viewer, simctl } = setup();
  await viewer.importBundle(new Uint8Array([1]), undefined, 1000);
  expect(simctl.argv[2]).toBe("automobile-proto://import?request=mcp-req1");
  const next = setup();
  next.files.result = JSON.stringify({
    status: "opened",
    request: REQUEST,
    libraryId: ID,
    label: "Demo",
  });
  expect((await next.viewer.open(ID, 1000)).status).toBe("opened");
  expect(next.simctl.argv).toEqual([
    "openurl",
    UDID,
    `automobile-proto://open?request=${REQUEST}&id=${ID}`,
  ]);
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
test("iOS empty reads remain pending until the deadline with ambiguous-save guidance", async () => {
  const { viewer, files } = setup();
  files.pending = 100;
  await expect(viewer.importBundle(new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
    "may still have saved",
  );
  expect(files.reads).toBe(4);
});
test("iOS cancellation still cleans result, inbox and temporary files", async () => {
  const { viewer, files, simctl } = setup();
  const controller = new AbortController();
  simctl.onOpen = () => controller.abort();
  await expect(
    viewer.importBundle(new Uint8Array([1]), undefined, 1000, controller.signal),
  ).rejects.toThrow();
  for (const path of [
    `results/${REQUEST}.json`,
    `inbox/${REQUEST}.automobile-proto`,
    `inbox/${REQUEST}.automobile-proto.tmp`,
  ]) {
    expect(files.events).toContain(`remove:${ROOT}/${path}`);
  }
});
test("iOS nonzero openurl is fallback but timeout is a hard failure", async () => {
  // Exact simctl error text is unverified: no captured device fixture; classify exit failure, not text.
  const first = setup();
  first.simctl.failure = new Error("nonzero exit");
  await expect(first.viewer.open(ID, 1000)).rejects.toBeInstanceOf(
    ProtoViewerEntryPointMissingError,
  );
  const second = setup();
  second.simctl.failure = new SimctlCommandTimeoutError("deadline");
  await expect(second.viewer.open(ID, 1000)).rejects.toThrow("may have been delivered");
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
  simctl.onOpen = () => {
    void timer.advanceTime(4000);
  };
  await expect(viewer.importBundle(new Uint8Array([1]), undefined, 5000)).rejects.toThrow(
    "may still have saved",
  );
  // Not 4000 (delivery) plus another full 5000.
  expect(timer.now() - started).toBeLessThan(7000);
});

test("iOS brings ProtoViewer to the foreground before openurl so no Open-in alert appears (#15435)", async () => {
  const { viewer, simctl } = setup();
  await viewer.importBundle(new Uint8Array([1]), undefined, 1000);
  expect(simctl.calls).toEqual([`launch:${UDID}`, "openurl"]);
});
test("iOS still tries openurl when the foreground launch fails (#15435)", async () => {
  const { viewer, simctl } = setup();
  simctl.launchFailure = new Error("launch failed");
  expect((await viewer.importBundle(new Uint8Array([1]), undefined, 1000)).status).toBe("imported");
  expect(simctl.calls).toEqual([`launch:${UDID}`, "openurl"]);
});
