import { describe, expect, test } from "bun:test";
import { AndroidUserTargetResolver } from "../../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

describe("AndroidUserTargetResolver", () => {
  test("preserves an explicit primary user", async () => {
    const resolver = new AndroidUserTargetResolver(new FakeAdbExecutor());
    expect(await resolver.resolve({ explicitUserId: 0 })).toEqual({ userId: 0, source: "explicit" });
  });

  test("uses the package's foreground user before profile fallback", async () => {
    const adb = new FakeAdbExecutor();
    adb.setForegroundApp({ packageName: "com.example.app", userId: 12 });
    const resolver = new AndroidUserTargetResolver(adb);
    expect(await resolver.resolve({ packageName: "com.example.app" })).toEqual({ userId: 12, source: "foregroundPackage" });
  });

  test("ignores a running non-managed secondary user", async () => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }, { userId: 10, name: "Secondary", flags: 0, running: true }]);
    const resolver = new AndroidUserTargetResolver(adb);
    expect(await resolver.resolve()).toEqual({ userId: 0, source: "primaryFallback" });
  });

  test("selects the first running managed profile and ignores paused profiles", async () => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([
      { userId: 11, name: "Paused work", flags: 0x30, running: false },
      { userId: 12, name: "Work", flags: 0x20, running: true },
      { userId: 13, name: "Other work", flags: 0x30, running: true },
    ]);
    const resolver = new AndroidUserTargetResolver(adb);
    expect(await resolver.resolve()).toEqual({ userId: 12, source: "managedProfile" });
  });
});
