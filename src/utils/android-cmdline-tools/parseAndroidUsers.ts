import { classifyAndroidUser, type AndroidUser } from "../../models/AndroidUser";

// UserInfo{userId:name:flags}; the name may be "null" and flags are hexadecimal.
const USER_INFO = /UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}/;
const PM_USER_LINE = /UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}\s*(running)?/;
const START_STATE_LOOKAHEAD_LINES = 10;

function findUserStartState(lines: string[], userLineIndex: number): string | undefined {
  const end = Math.min(userLineIndex + START_STATE_LOOKAHEAD_LINES, lines.length);
  for (let j = userLineIndex + 1; j < end; j++) {
    const stateLine = lines[j];
    // Stop at the next user so its state is not attributed to this one.
    if (stateLine.match(/UserInfo\{/)) {
      return undefined;
    }
    const stateMatch = stateLine.match(/State:\s+(\S+)/);
    if (stateMatch) {
      return stateMatch[1];
    }
  }
  return undefined;
}

/**
 * Parse `dumpsys user` output. Example line: "  UserInfo{0:null:4c13} serialNo=0 isPrimary=true"
 * followed by "    State: RUNNING_UNLOCKED". A "null" name falls back to the
 * "Owner name:" line for user 0, else "User <id>".
 */
export function parseDumpsysUsers(output: string): AndroidUser[] {
  const users: AndroidUser[] = [];
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const userMatch = lines[i].match(USER_INFO);
    if (!userMatch) {
      continue;
    }
    const userId = parseInt(userMatch[1], 10);
    let userName = userMatch[2];
    const flags = parseInt(userMatch[3], 16);

    const startState = findUserStartState(lines, i);
    const running = startState === "RUNNING_UNLOCKED" || startState === "RUNNING_LOCKED";

    if (userName === "null") {
      const ownerMatch = output.match(/Owner name:\s+(.+)/);
      userName = ownerMatch && userId === 0 ? ownerMatch[1].trim() : `User ${userId}`;
    }

    users.push({
      userId,
      name: userName,
      flags,
      profileType: classifyAndroidUser(flags),
      running,
      ...(startState ? { startState } : {}),
    });
  }

  return users;
}

/**
 * Parse `pm list users` output, e.g. "\tUserInfo{0:Owner:4c13} running".
 * Unlike dumpsys, this carries only a running flag and no start state.
 */
export function parsePmListUsers(output: string): AndroidUser[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(PM_USER_LINE);
    if (!match) {
      return [];
    }
    const flags = parseInt(match[3], 16);
    return [
      {
        userId: parseInt(match[1], 10),
        name: match[2],
        flags,
        profileType: classifyAndroidUser(flags),
        running: match[4] === "running",
      },
    ];
  });
}
