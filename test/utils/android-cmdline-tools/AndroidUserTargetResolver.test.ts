import { describe, expect, test, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
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
  test.each([
    { name: "personal-only", personal: true, managed: false, userId: 0, source: "installedUser" },
    { name: "work-only", personal: false, managed: true, userId: 10, source: "installedUser" },
    { name: "both", personal: true, managed: true, userId: 10, source: "managedProfile" },
    { name: "none", personal: false, managed: false, userId: 10, source: "managedProfile" },
  ])("installedOnly selects $name", async ({ personal, managed, userId, source }) => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([owner, { ...work, userId: 10 }, pausedWork]);
    adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    adb.setCommandResponse("shell pm list packages --user 0", {
      stdout: personal ? "package:com.example.app" : "package:com.example.other",
      stderr: "",
    });
    adb.setCommandResponse("shell pm list packages --user 10", {
      stdout: managed ? "package:com.example.app" : "package:com.example.other",
      stderr: "",
    });
    const log = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await expect(
        new AndroidUserTargetResolver(adb).resolve({
          packageName: "com.example.app",
          installedOnly: true,
        }),
      ).resolves.toEqual({ userId, source });
      expect(adb.getExecutedCommands()).toEqual([
        "shell pm list packages --user 0",
        "shell pm list packages --user 10",
      ]);
      if (!personal && !managed) {
        expect(log).toHaveBeenCalledWith(
          "Android app com.example.app is not installed for any running user; checked users: 0, 10",
        );
      }
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    {
      name: "one running user",
      request: { installedOnly: true as const },
      users: [owner, pausedWork],
      foreground: null,
      expected: { userId: 0, source: "primary" },
    },
    {
      name: "explicit user",
      request: { installedOnly: true as const, explicitUserId: 0 },
      users: [owner, work],
      foreground: null,
      expected: { userId: 0, source: "explicit" },
    },
    {
      name: "foreground package",
      request: { installedOnly: true as const },
      users: [owner, work],
      foreground: { packageName: "com.example.app", userId: 0 },
      expected: { userId: 0, source: "foregroundPackage" },
    },
    {
      name: "opt-in off for install-style callers",
      request: {},
      users: [owner, work],
      foreground: null,
      expected: { userId: 12, source: "managedProfile" },
    },
    {
      name: "currentUser fallback",
      request: { installedOnly: true as const, currentUser: true },
      users: [owner, work],
      foreground: null,
      expected: { userId: 12, source: "managedProfile" },
    },
  ])(
    "installedOnly preserves $name without package listings",
    async ({ request, users, foreground, expected }) => {
      const adb = new FakeAdbExecutor();
      adb.setUsers(users);
      adb.setForegroundApp(foreground);
      const usersSpy = spyOn(adb, "listUsers");
      const foregroundSpy = spyOn(adb, "getForegroundApp");
      await expect(
        new AndroidUserTargetResolver(adb).resolve({ packageName: "com.example.app", ...request }),
      ).resolves.toEqual(expected);
      expect(adb.wasCommandExecuted("pm list packages")).toBe(false);
      if (expected.source === "explicit") {
        expect(usersSpy).not.toHaveBeenCalled();
        expect(foregroundSpy).not.toHaveBeenCalled();
        expect(adb.getExecutedCommands()).toEqual([]);
      } else if (expected.source === "foregroundPackage") {
        expect(usersSpy).not.toHaveBeenCalled();
        expect(adb.getExecutedCommands()).toEqual([]);
      }
    },
  );

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
  describe("includeForegroundApp", () => {
    const foreground = { packageName: "com.example.other", userId: 10 };

    test("returns the foreground read when it matched the package", async () => {
      const adb = new FakeAdbExecutor();
      const match = { packageName: "com.example.app", userId: 10 };
      adb.setForegroundApp(match);
      await expect(
        new AndroidUserTargetResolver(adb).resolve({
          packageName: "com.example.app",
          includeForegroundApp: true,
        }),
      ).resolves.toEqual({ userId: 10, source: "foregroundPackage", foregroundApp: match });
    });

    test("returns the non-matching foreground read alongside the fallback user", async () => {
      const adb = new FakeAdbExecutor();
      adb.setUsers([work]);
      adb.setForegroundApp(foreground);
      const foregroundSpy = spyOn(adb, "getForegroundApp");
      await expect(
        new AndroidUserTargetResolver(adb).resolve({
          packageName: "com.example.app",
          includeForegroundApp: true,
        }),
      ).resolves.toEqual({ userId: 12, source: "managedProfile", foregroundApp: foreground });
      expect(foregroundSpy).toHaveBeenCalledTimes(1);
    });

    test("omits it when no foreground read happened", async () => {
      const adb = new FakeAdbExecutor();
      await expect(
        new AndroidUserTargetResolver(adb).resolve({
          packageName: "com.example.app",
          explicitUserId: 0,
          includeForegroundApp: true,
        }),
      ).resolves.toEqual({ userId: 0, source: "explicit" });
    });
  });
});
