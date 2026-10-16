import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDumpsysUsers,
  parsePmListUsers,
} from "../../../src/utils/android-cmdline-tools/parseAndroidUsers";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-adb", name), "utf8");

describe("parseDumpsysUsers", () => {
  test("captured dumpsys user yields the primary Owner with its start state", () => {
    expect(parseDumpsysUsers(fixture("dumpsys-user.txt"))).toEqual([
      {
        userId: 0,
        name: "Owner",
        flags: 0x4c13,
        profileType: "primary",
        running: true,
        startState: "RUNNING_UNLOCKED",
      },
    ]);
  });

  // Supplementary hand-typed shapes (no multi-user capture yet).
  test("supplementary: non-zero user with null name, stopped state, and state not leaking across users", () => {
    const out = [
      "Users:",
      "  UserInfo{0:null:4c13} serialNo=0",
      "    Type: android.os.usertype.full.SYSTEM",
      "  UserInfo{10:Work:30} serialNo=10",
      "    State: SHUTDOWN",
      "  UserInfo{11:null:30} serialNo=11",
      "    State: RUNNING_LOCKED",
    ].join("\n");
    const users = parseDumpsysUsers(out);
    expect(users.map((u) => [u.userId, u.name, u.running, u.startState])).toEqual([
      [0, "User 0", false, undefined],
      [10, "Work", false, "SHUTDOWN"],
      [11, "User 11", true, "RUNNING_LOCKED"],
    ]);
  });

  test("supplementary: no users", () => {
    expect(parseDumpsysUsers("Current user: 0\n")).toEqual([]);
  });
});

describe("parsePmListUsers", () => {
  test("captured pm list users yields the running Owner", () => {
    expect(parsePmListUsers(fixture("pm-list-users.txt"))).toEqual([
      { userId: 0, name: "Owner", flags: 0x4c13, profileType: "primary", running: true },
    ]);
  });

  test("supplementary: work profile and not-running user", () => {
    const users = parsePmListUsers(
      "Users:\n\tUserInfo{0:Owner:4c13} running\n\tUserInfo{10:Work profile:30}\n",
    );
    expect(users.map((u) => [u.userId, u.name, u.profileType, u.running])).toEqual([
      [0, "Owner", "primary", true],
      [10, "Work profile", "managed", false],
    ]);
  });

  test("supplementary: unparseable output yields no users", () => {
    expect(parsePmListUsers("Error: something\n")).toEqual([]);
  });
});
