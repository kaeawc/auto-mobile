import { expect, test } from "bun:test";
import {
  restoreSavedPrototypes,
  AndroidSavedPrototypeRestoreDevice,
  type SavedPrototypeRestoreClient,
  type SavedPrototypeRestoreDevice,
} from "../../../src/features/prototype/savedPrototypeRestore";
import type { MirroredSavedPrototype } from "../../../src/features/prototype/savedPrototypeMirror";
import { FakeSavedPrototypeMirror } from "../../fakes/FakeSavedPrototypeMirror";
import { FakeTimer } from "../../fakes/FakeTimer";

const entry: MirroredSavedPrototype = {
  id: "one",
  label: "One",
  icon: "photo",
  spec: {
    id: "one",
    window: { placement: { type: "fullscreen" } },
    root: { type: "image", asset: "photo" },
  },
  assets: [{ id: "photo", mimeType: "image/png", bytes: new Uint8Array([1]) }],
};
function harness() {
  const mirror = new FakeSavedPrototypeMirror();
  const calls: string[] = [];
  const device: SavedPrototypeRestoreDevice = {
    list: async () => ({ success: true, savedPrototypes: [] }),
    putAsset: async (asset) => {
      calls.push(`asset:${asset.id}`);
      return { success: true };
    },
    save: async (save) => {
      calls.push(`save:${save.spec.id}`);
      return { success: true };
    },
  };
  return { mirror, calls, device };
}
test("restores missing entries sequentially with assets before save, skips existing", async () => {
  const { mirror, calls, device } = harness();
  for (const id of ["one", "present", "two"]) {
    await mirror.record("serial", { ...entry, id, spec: { ...entry.spec, id } });
  }
  device.list = async () => ({
    success: true,
    savedPrototypes: [
      { id: "present", label: "Present", slug: "present", savedAt: 1, pinned: false },
    ],
  });
  expect(await restoreSavedPrototypes("serial", mirror, device)).toEqual({
    restored: ["one", "two"],
    skipped: ["present"],
    failed: [],
  });
  expect(calls).toEqual(["asset:photo", "save:one", "asset:photo", "save:two"]);
});
test("entry failures surface device codes and do not stop other entries or remove the mirror", async () => {
  const { mirror, device } = harness();
  await mirror.record("serial", entry);
  await mirror.record("serial", { ...entry, id: "two", spec: { ...entry.spec, id: "two" } });
  device.save = async (save) =>
    save.spec.id === "one"
      ? { success: false, errorCode: "storage_failure", error: "disk full" }
      : { success: true };
  const report = await restoreSavedPrototypes("serial", mirror, device);
  expect(report).toEqual({
    restored: ["two"],
    skipped: [],
    failed: [{ id: "one", code: "storage_failure", reason: "disk full" }],
  });
  expect(await mirror.list("serial")).toHaveLength(2);
});
test("list failure is tolerated and thrown upload failure never escapes", async () => {
  const { mirror, device } = harness();
  await mirror.record("serial", entry);
  device.list = async () => {
    throw new Error("list unavailable");
  };
  device.putAsset = async () => {
    throw new Error("upload unavailable");
  };
  expect(await restoreSavedPrototypes("serial", mirror, device)).toEqual({
    restored: [],
    skipped: [],
    failed: [{ id: "one", code: "restore_failed", reason: "upload unavailable" }],
  });
});
test("missing bytes fail before any upload; mirror failure returns a typed report", async () => {
  const { mirror, device, calls } = harness();
  await mirror.record("serial", { ...entry, assets: [...entry.assets, { id: "missing" }] });
  expect((await restoreSavedPrototypes("serial", mirror, device)).failed).toMatchObject([
    { id: "one", code: "asset_unavailable" },
  ]);
  expect(calls).toEqual([]);
  mirror.error = new Error("mirror unavailable");
  expect((await restoreSavedPrototypes("serial", mirror, device)).failed).toEqual([
    { id: "*", code: "restore_failed", reason: "mirror unavailable" },
  ]);
});
test("unsuccessful list replies are treated as empty and unsuccessful uploads fail", async () => {
  const { mirror, device, calls } = harness();
  await mirror.record("serial", entry);
  device.list = async () => ({ success: false, error: "list refused" });
  device.putAsset = async () => ({ success: false, error: "asset refused" });
  expect((await restoreSavedPrototypes("serial", mirror, device)).failed).toEqual([
    { id: "one", code: "restore_failed", reason: "asset refused" },
  ]);
  expect(calls).toEqual([]);
});

test.each(["throw", "refuse"])("list %s still allows successful restoration", async (mode) => {
  const { mirror, device } = harness();
  await mirror.record("serial", entry);
  device.list = async () => {
    if (mode === "throw") {
      throw new Error("list unavailable");
    }
    return { success: false, error: "list unavailable" };
  };
  expect((await restoreSavedPrototypes("serial", mirror, device)).restored).toEqual(["one"]);
});
test("a success envelope with an error is a failed restore", async () => {
  const { mirror, device } = harness();
  await mirror.record("serial", entry);
  device.save = async () => ({ success: true, error: "refused" });
  expect((await restoreSavedPrototypes("serial", mirror, device)).failed).toEqual([
    { id: "one", code: "restore_failed", reason: "refused" },
  ]);
});

function adapterHarness(commands: string[]) {
  const calls: string[] = [];
  const timer = new FakeTimer();
  const client: SavedPrototypeRestoreClient = {
    ensureConnected: async () => {
      calls.push("connect");
      return true;
    },
    getSupportedCommands: async () => commands,
    requestListSavedPrototypes: async () => {
      calls.push("list");
      return { success: true, savedPrototypes: [] };
    },
    requestPutPrototypeAsset: async (asset) => {
      calls.push(`asset:${asset.id}`);
      return { success: true, dispatched: true, acknowledged: true };
    },
    requestSavePrototype: async (save) => {
      calls.push(`save:${save.spec.id}`);
      return { success: true };
    },
  };
  const adapter = new AndroidSavedPrototypeRestoreDevice(
    { deviceId: "serial", name: "Android", platform: "android", isEmulator: true },
    timer,
    async () => {
      calls.push("resolve");
      return client;
    },
    50,
  );
  return { adapter, client, timer, calls };
}
test("adapter resolves lazily and forwards assets and saved requests after capability negotiation", async () => {
  const { adapter, calls } = adapterHarness(["prototype_saved_v1"]);
  expect(calls).toEqual([]);
  await adapter.list();
  await adapter.putAsset({ id: "photo", mimeType: "image/png", bytes: new Uint8Array([1]) });
  await adapter.save(entry);
  expect(calls).toEqual(["resolve", "connect", "list", "asset:photo", "save:one"]);
});
test("unsupported adapter sends no mutations and reports device_unsupported per entry", async () => {
  const { adapter, calls } = adapterHarness(["save_prototype"]);
  const mirror = new FakeSavedPrototypeMirror();
  await mirror.record("serial", entry);
  expect((await restoreSavedPrototypes("serial", mirror, adapter)).failed).toMatchObject([
    { id: "one", code: "device_unsupported" },
  ]);
  expect(calls).toEqual(["resolve", "connect"]);
});
test("adapter connection deadline uses FakeTimer and never hangs restore", async () => {
  const { adapter, client, timer } = adapterHarness(["prototype_saved_v1"]);
  let started!: () => void;
  const connecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.ensureConnected = () => {
    started();
    return new Promise<boolean>(() => {});
  };
  const mirror = new FakeSavedPrototypeMirror();
  await mirror.record("serial", entry);
  const pending = restoreSavedPrototypes("serial", mirror, adapter);
  await connecting;
  timer.advanceTime(50);
  const report = await pending;
  expect(report.failed).toMatchObject([{ id: "one", code: "restore_failed" }]);
  expect(report.failed[0].reason).toContain("timed out after 50ms");
});
