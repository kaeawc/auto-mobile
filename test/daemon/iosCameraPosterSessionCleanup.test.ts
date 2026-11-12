import { expect, test } from "bun:test";
import { registerIosCameraPosterSessionCleanup } from "../../src/daemon/iosCameraPosterSessionCleanup";
import { InMemoryIosCameraPosterRegistry } from "../../src/features/utility/ios/IosCameraPosterRegistry";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";

const simA = "11111111-2222-3333-4444-555555555555";
const simB = "66666666-7777-8888-9999-000000000000";

function setup() {
  const manager = new FakeSessionCleanupManager();
  const registry = new InMemoryIosCameraPosterRegistry();
  registerIosCameraPosterSessionCleanup(manager, registry);
  registry.set(simA, { kind: "image", path: "/a.png" });
  registry.set(simB, { kind: "qr", text: "b", path: "/b.png" });
  return { manager, registry };
}

test("a session release forgets only its simulator's poster", () => {
  const h = setup();
  h.manager.release("session-1", simA);
  expect(h.registry.get(simA)).toBeUndefined();
  expect(h.registry.get(simB)).toEqual({ kind: "qr", text: "b", path: "/b.png" });
  expect(h.manager.pendingCleanups).toEqual([]);
});

test("a rebind that unbinds the old simulator forgets its poster", () => {
  const h = setup();
  h.manager.unbound("session-1", simA);
  expect(h.registry.get(simA)).toBeUndefined();
  expect(h.registry.get(simB)).toBeDefined();
});

test("an upgrade-only re-announcement keeps the next owner's poster", () => {
  const h = setup();
  h.manager.release("earlier-session", simA, true);
  expect(h.registry.get(simA)).toEqual({ kind: "image", path: "/a.png" });
});
