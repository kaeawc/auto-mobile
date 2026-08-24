import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { classifyAndroidUser, type AndroidUser, type ExecResult } from "../../../src/models";

const owner: AndroidUser = {
  userId: 0,
  name: "Owner",
  flags: 0x4c13,
  profileType: "primary",
  running: true,
};
const workProfile: AndroidUser = {
  userId: 10,
  name: "Work profile",
  flags: 0x30,
  profileType: "managed",
  running: true,
};

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search) => stdout.includes(search),
  };
}

type CommandOutcome = string | Error;

interface ListUsersCase {
  name: string;
  outcomes: CommandOutcome[];
  expectedUsers: AndroidUser[];
  expectedCommandFragments: string[];
}

const cases: ListUsersCase[] = [
  {
    name: "parses a primary user from structured dumpsys output",
    outcomes: [
      `Current user: 0

Users:
  UserInfo{0:null:4c13} serialNo=0 isPrimary=true
    Type: android.os.usertype.full.SYSTEM
    Flags: 19475 (ADMIN|FULL|INITIALIZED|MAIN|PRIMARY|SYSTEM)
    State: RUNNING_UNLOCKED

  Owner name: Owner`,
    ],
    expectedUsers: [owner],
    expectedCommandFragments: ["shell dumpsys user"],
  },
  {
    name: "parses a running work profile from structured dumpsys output",
    outcomes: [
      `Current user: 0

Users:
  UserInfo{0:null:4c13} serialNo=0 isPrimary=true
    Type: android.os.usertype.full.SYSTEM
    State: RUNNING_UNLOCKED

  UserInfo{10:Work profile:30} serialNo=10 isPrimary=false parentId=0
    Type: android.os.usertype.profile.MANAGED
    Flags: 48 (MANAGED_PROFILE)
    State: RUNNING_UNLOCKED

  Owner name: Owner`,
    ],
    expectedUsers: [owner, workProfile],
    expectedCommandFragments: ["shell dumpsys user"],
  },
  {
    name: "marks a shutdown secondary user as not running",
    outcomes: [
      `Users:
  UserInfo{0:null:4c13} serialNo=0 isPrimary=true
    State: RUNNING_UNLOCKED

  UserInfo{10:Secondary User:0} serialNo=10 isPrimary=false
    State: SHUTDOWN

  Owner name: Owner`,
    ],
    expectedUsers: [
      owner,
      {
        userId: 10,
        name: "Secondary User",
        flags: 0,
        profileType: "unknown",
        running: false,
      },
    ],
    expectedCommandFragments: ["shell dumpsys user"],
  },
  {
    name: "treats a locked user as running",
    outcomes: [
      `Users:
  UserInfo{0:null:4c13} serialNo=0 isPrimary=true
    State: RUNNING_LOCKED

  Owner name: Owner`,
    ],
    expectedUsers: [owner],
    expectedCommandFragments: ["shell dumpsys user"],
  },
  {
    name: "uses a user-ID fallback name when dumpsys omits it",
    outcomes: [
      `Users:
  UserInfo{10:null:30} serialNo=10 isPrimary=false
    State: RUNNING_UNLOCKED`,
    ],
    expectedUsers: [
      { userId: 10, name: "User 10", flags: 0x30, profileType: "managed", running: true },
    ],
    expectedCommandFragments: ["shell dumpsys user"],
  },
  {
    name: "falls back to pm output when dumpsys has no users",
    outcomes: [
      "Invalid output",
      `Users:
\tUserInfo{0:Owner:4c13} running
\tUserInfo{10:Work profile:30} running`,
    ],
    expectedUsers: [owner, workProfile],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
  {
    name: "falls back to pm output when dumpsys throws",
    outcomes: [
      new Error("dumpsys user failed"),
      `Users:
\tUserInfo{0:Owner:4c13} running`,
    ],
    expectedUsers: [owner],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
  {
    name: "marks a pm user without running status as stopped",
    outcomes: [new Error("dumpsys unavailable"), "Users:\n\tUserInfo{0:Owner:4c13}"],
    expectedUsers: [{ ...owner, running: false }],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
  {
    name: "returns no users when both user commands fail",
    outcomes: [new Error("dumpsys unavailable"), new Error("pm unavailable")],
    expectedUsers: [],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
  {
    name: "returns no users when neither parser finds a user",
    outcomes: ["Some random output with no user info", "Still no user info"],
    expectedUsers: [],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
  {
    name: "parses hexadecimal flags from pm output",
    outcomes: [
      new Error("dumpsys unavailable"),
      `Users:
\tUserInfo{0:Owner:4c13} running
\tUserInfo{10:Work:1a2b} running`,
    ],
    expectedUsers: [
      owner,
      { userId: 10, name: "Work", flags: 0x1a2b, profileType: "managed", running: true },
    ],
    expectedCommandFragments: ["shell dumpsys user", "shell pm list users"],
  },
];

describe("AdbClient.listUsers", () => {
  test.each(cases)("$name", async ({ outcomes, expectedUsers, expectedCommandFragments }) => {
    const commands: string[] = [];
    let outcomeIndex = 0;
    const client = new AdbClient(null, async (command) => {
      commands.push(command);
      const outcome = outcomes[outcomeIndex++];
      if (outcome instanceof Error) {
        throw outcome;
      }
      return execResult(outcome);
    });

    await expect(client.listUsers()).resolves.toEqual(expectedUsers);
    expect(commands.map((command) => command.replace(/^.*\badb\s+/, ""))).toEqual(
      expectedCommandFragments,
    );
  });
});

describe("classifyAndroidUser", () => {
  test("recognizes FLAG_MAIN for headless-system-user devices", () => {
    expect(classifyAndroidUser(0x800)).toBe("unknown");
    expect(classifyAndroidUser(0x4412)).toBe("primary");
  });
});
