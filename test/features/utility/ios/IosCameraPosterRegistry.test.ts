import { expect, test } from "bun:test";
import { InMemoryIosCameraPosterRegistry } from "../../../../src/features/utility/ios/IosCameraPosterRegistry";

test("registry isolates simulator UDIDs, replaces, clears and copies records", () => {
  const registry = new InMemoryIosCameraPosterRegistry();
  const image = { kind: "image", path: "/poster.png" } as const;
  registry.set("one", image);
  registry.set("two", { kind: "qr", text: "hello", path: "/qr.png" });
  const copy = registry.get("one")!;
  copy.path = "/other.png";
  expect(registry.get("one")).toEqual(image);
  registry.set("one", { kind: "image", path: "/replacement.jpg" });
  expect(registry.get("one")?.path).toBe("/replacement.jpg");
  registry.clear("one");
  registry.clear("missing");
  expect(registry.get("one")).toBeUndefined();
  expect(registry.get("two")).toEqual({ kind: "qr", text: "hello", path: "/qr.png" });
});
