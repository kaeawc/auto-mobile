import { expect, test } from "bun:test";
import { releaseCleanupStatus } from "../../src/daemon/releaseCleanupStatus";

test("complete or absent reports omit cleanup", () => {
  expect(releaseCleanupStatus({})).toBeUndefined();
  expect(
    releaseCleanupStatus({
      keepAwakeRestore: { status: "restored_to_baseline" },
      screenLockRestore: { status: "cleared" },
      powerRestore: { status: "restored" },
    }),
  ).toBeUndefined();
  expect(
    releaseCleanupStatus({
      screenLockRestore: { status: "skipped" },
      powerRestore: { status: "skipped" },
    }),
  ).toBeUndefined();
});
test.each(["screenLockRestore", "powerRestore"] as const)("%s pending cleanup", (field) => {
  expect(releaseCleanupStatus({ [field]: { status: "pending" } })).toBe("pending");
});
test.each(["keepAwakeRestore", "screenLockRestore", "powerRestore"] as const)(
  "%s failure beats pending",
  (field) => {
    expect(
      releaseCleanupStatus({
        screenLockRestore: { status: "pending" },
        powerRestore: { status: "pending" },
        [field]: { status: "failed" },
      }),
    ).toBe("failed");
  },
);
test("partial power restoration is failed cleanup", () => {
  expect(releaseCleanupStatus({ powerRestore: { status: "partial" } })).toBe("failed");
});
