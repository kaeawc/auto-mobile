import { describe, expect, test } from "bun:test";
import {
  AndroidUserTargetResolver,
  type ResolvedUserTarget,
  type UserTargetRequest,
} from "../../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";
import type { AndroidUser } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const owner: AndroidUser = { userId: 0, name: "Owner", flags: 0x13, running: true };
const pausedWork: AndroidUser = { userId: 11, name: "Paused work", flags: 0x30, running: false };
const work: AndroidUser = { userId: 12, name: "Work", flags: 0x20, running: true };
const otherWork: AndroidUser = { userId: 13, name: "Other work", flags: 0x30, running: true };

interface ResolveCase {
  name: string;
  request: UserTargetRequest;
  users?: AndroidUser[];
  foreground?: { packageName: string; userId: number } | null;
  expected: ResolvedUserTarget;
}

const cases: ResolveCase[] = [
  {
    name: "uses explicit primary user zero before every other signal",
    request: { explicitUserId: 0, packageName: "com.example.app" },
    users: [work],
    foreground: { packageName: "com.example.app", userId: 12 },
    expected: { userId: 0, source: "explicit" },
  },
  {
    name: "uses an explicit non-primary user before profile fallback",
    request: { explicitUserId: 10 },
    users: [work],
    expected: { userId: 10, source: "explicit" },
  },
  {
    name: "uses a matching foreground package before a managed profile",
    request: { packageName: "com.example.app" },
    users: [work],
    foreground: { packageName: "com.example.app", userId: 10 },
    expected: { userId: 10, source: "foregroundPackage" },
  },
  {
    name: "uses a running managed profile when the foreground package differs",
    request: { packageName: "com.example.app" },
    users: [work],
    foreground: { packageName: "com.example.other", userId: 10 },
    expected: { userId: 12, source: "managedProfile" },
  },
  {
    name: "uses a running managed profile when no foreground package is available",
    request: { packageName: "com.example.app" },
    users: [work],
    foreground: null,
    expected: { userId: 12, source: "managedProfile" },
  },
  {
    name: "uses a managed profile when no package was requested",
    request: {},
    users: [work],
    expected: { userId: 12, source: "managedProfile" },
  },
  {
    name: "skips a paused managed profile and falls back to the primary user",
    request: {},
    users: [owner, pausedWork],
    expected: { userId: 0, source: "primary" },
  },
  {
    name: "does not treat a running secondary user as managed",
    request: {},
    users: [owner, { userId: 10, name: "Secondary", flags: 0, running: true }],
    expected: { userId: 0, source: "primary" },
  },
  {
    name: "rejects ambiguous running managed profiles",
    request: {},
    users: [pausedWork, work, otherWork],
    expected: { userId: 0, source: "primary" },
  },
  {
    name: "falls back to the primary user when no users are reported",
    request: {},
    users: [],
    expected: { userId: 0, source: "primary" },
  },
];

describe("AndroidUserTargetResolver.resolve", () => {
  test("uses Android's current user before managed-profile fallback when requested", async () => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([
      { userId: 0, name: "Owner", flags: 13, running: true },
      { userId: 10, name: "Work", flags: 32, running: true },
    ]);
    adb.setCommandResponse("am get-current-user", {
      stdout: "0",
      stderr: "",
      toString: () => "0",
      trim: () => "0",
      includes: (value) => value === "0",
    });

    await expect(
      new AndroidUserTargetResolver(adb).resolve({ currentUser: true }),
    ).resolves.toEqual({
      userId: 0,
      source: "currentUser",
    });
  });

  test.each(cases)("$name", async ({ request, users, foreground, expected }) => {
    const adb = new FakeAdbExecutor();
    if (users) {
      adb.setUsers(users);
    }
    if (foreground !== undefined) {
      adb.setForegroundApp(foreground);
    }

    const resolution = new AndroidUserTargetResolver(adb).resolve(request);
    if (users?.length === 0) {
      await expect(resolution).rejects.toThrow("unavailable");
    } else if (users?.filter((user) => user.running && (user.flags & 0x20) !== 0).length === 2) {
      await expect(resolution).rejects.toThrow("ambiguous");
    } else {
      await expect(resolution).resolves.toEqual(expected);
    }
  });

  test("rejects unavailable user state instead of fabricating user zero", async () => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([]);

    await expect(new AndroidUserTargetResolver(adb).resolve()).rejects.toThrow("unavailable");
  });
});
