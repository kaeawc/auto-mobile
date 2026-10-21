import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PROTOTYPE_BUNDLE_ID_PREFIX,
  isPrototypeBundleId,
  prototypeBundleId,
} from "../../../../src/features/prototype/ios/iosPrototypeBundleId";
import { InvalidPrototypeIdError } from "../../../../src/features/prototype/ios/iosPrototypeInstallerErrors";

for (const [id, slug] of [
  ["Hello WORLD", "hello-world"],
  ["..foo...Bar__", "foo-bar"],
  ["日本", "prototype"],
  ["--a---b--", "a-b"],
]) {
  test(`slug rules: ${id}`, () => {
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
    expect(prototypeBundleId(id)).toBe(`${PROTOTYPE_BUNDLE_ID_PREFIX}${slug}-${hash}`);
    expect(prototypeBundleId(id)).toBe(prototypeBundleId(id));
  });
}
for (const id of ["", " \t\n "]) {
  test("empty/whitespace id is invalid", () =>
    expect(() => prototypeBundleId(id)).toThrow(InvalidPrototypeIdError));
}
test("bounds long ids, trims cut hyphens, and hashes original ids to distinguish normalized collisions", () => {
  const long = prototypeBundleId("A-".repeat(1000));
  expect(long.length).toBeLessThanOrEqual(155);
  expect(long.slice(PROTOTYPE_BUNDLE_ID_PREFIX.length)).toMatch(
    /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/,
  );
  expect(prototypeBundleId("A.B")).not.toBe(prototypeBundleId("a-b"));
  expect(prototypeBundleId("A".repeat(1000))).not.toBe(prototypeBundleId("A".repeat(1001)));
  expect(prototypeBundleId("Foo")).not.toBe(prototypeBundleId("foo"));
});
test("prefix detection is exact", () => {
  expect(isPrototypeBundleId(prototypeBundleId("mine"))).toBe(true);
  expect(isPrototypeBundleId("com.example.app")).toBe(false);
  expect(isPrototypeBundleId(PROTOTYPE_BUNDLE_ID_PREFIX.slice(0, -1))).toBe(false);
});
