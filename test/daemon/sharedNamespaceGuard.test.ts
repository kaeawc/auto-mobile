import { describe, expect, spyOn, test } from "bun:test";
import {
  ALLOW_SHARED_NAMESPACE_ENV,
  assertDaemonNamespaceMatchesState,
  SharedDaemonNamespaceError,
  SHARED_DAEMON_NAMESPACE_CODE,
} from "../../src/daemon/sharedNamespaceGuard";
import { resolveDaemonStatePath } from "../../src/daemon/constants";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

const refusal = (env: NodeJS.ProcessEnv, allowShared = false): unknown => {
  try {
    assertDaemonNamespaceMatchesState("restart the daemon", env, allowShared);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("shared daemon namespace guard (#11252)", () => {
  test.each([
    "AUTOMOBILE_DATA_DIR",
    "AUTOMOBILE_DB_DIR",
    "AUTOMOBILE_DB_PATH",
    "AUTO_MOBILE_DB_PATH",
  ])("%s without a private namespace is refused with a typed error", (name) => {
    const error = refusal({ [name]: "/tmp/private" });
    expect(error).toBeInstanceOf(SharedDaemonNamespaceError);
    const typed = error as SharedDaemonNamespaceError;
    expect(typed.code).toBe(SHARED_DAEMON_NAMESPACE_CODE);
    expect(typed.message).toContain(`${name} is set`);
    expect(typed.message).toContain(resolveDaemonStatePath("sock", {}));
    expect(typed.nextAction).toContain("AUTOMOBILE_AUX_SOCKET_DIR");
    expect(typed.nextAction).toContain("--allow-shared-namespace");
  });

  test.each<[string, NodeJS.ProcessEnv]>([
    ["no state env", {}],
    ["log dir only", { AUTOMOBILE_LOG_DIR: "/tmp/logs" }],
    [
      "shared coordination roots only",
      {
        AUTOMOBILE_COORDINATION_DIR: "/tmp/coord",
        AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/tmp/adb-servers",
      },
    ],
    ["blank data dir", { AUTOMOBILE_DATA_DIR: "  " }],
    [
      "private aux socket dir",
      { AUTOMOBILE_DATA_DIR: "/tmp/private", AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/aux" },
    ],
    [
      "explicit socket path",
      { AUTOMOBILE_DB_DIR: "/tmp/private", AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/private.sock" },
    ],
    ["env opt-in", { AUTOMOBILE_DATA_DIR: "/tmp/private", [ALLOW_SHARED_NAMESPACE_ENV]: "1" }],
  ])("%s is allowed", (_label, env) => {
    expect(refusal(env)).toBeUndefined();
  });

  test("an explicit socket path equal to the resident default is still shared", () => {
    expect(
      refusal({
        AUTOMOBILE_DATA_DIR: "/tmp/private",
        AUTOMOBILE_DAEMON_SOCKET_PATH: resolveDaemonStatePath("sock", {}),
      }),
    ).toBeInstanceOf(SharedDaemonNamespaceError);
  });

  test("the --allow-shared-namespace opt-in allows it", () => {
    expect(refusal({ AUTOMOBILE_DATA_DIR: "/tmp/private" }, true)).toBeUndefined();
  });
});

describe("daemon CLI lifecycle commands honor the namespace guard (#11252)", () => {
  async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
    const events: unknown[] = [];
    const exited = new Error("fake exit");
    class Manager extends SafeDaemonManager {
      override async start() {
        events.push("start");
        return "started" as const;
      }
      override async stop() {
        events.push("stop");
      }
      override async restart() {
        events.push("restart");
        return "restarted" as const;
      }
      override createClient() {
        events.push("client");
        throw new Error("no daemon in this test");
      }
    }
    const error = spyOn(console, "error").mockImplementation((text) => {
      events.push(["stderr", text]);
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      events.push(["exit", code]);
      throw exited;
    });
    try {
      await runDaemonCommand(command, args, { namespaceEnv: env }, Manager).catch((caught) => {
        if (caught !== exited) {
          throw caught;
        }
      });
    } finally {
      exit.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
    return events;
  }

  const privateDataDir = { AUTOMOBILE_DATA_DIR: "/tmp/private-lane-data" };

  test.each<[string, string[]]>([
    ["start", []],
    ["stop", []],
    ["restart", []],
    ["release-session", ["session-1"]],
    ["release-liveness-ownership", ["session-1", "--liveness-owner-token", "t"]],
  ])("%s is refused before touching the daemon", async (command, args) => {
    const events = await run(command, args, privateDataDir);
    expect(events[0]).toEqual([
      "stderr",
      expect.stringContaining(`Refusing to run daemon ${command}: AUTOMOBILE_DATA_DIR is set`),
    ]);
    expect(events).toContainEqual(["exit", 1]);
    expect(events).not.toContain(command);
    expect(events).not.toContain("client");
  });

  test("--allow-shared-namespace lets restart act on the shared daemon", async () => {
    expect(await run("restart", ["--allow-shared-namespace"], privateDataDir)).toEqual(["restart"]);
  });

  test("--allow-shared-namespace does not break release-liveness-ownership parsing", async () => {
    const events = await run(
      "release-liveness-ownership",
      ["session-1", "--liveness-owner-token", "t", "--allow-shared-namespace"],
      privateDataDir,
    );
    expect(events[0]).toBe("client");
  });

  test("a private namespace or log-only env is not refused", async () => {
    expect(
      await run("stop", [], { ...privateDataDir, AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/aux" }),
    ).toEqual(["stop"]);
    expect(await run("stop", [], { AUTOMOBILE_LOG_DIR: "/tmp/logs" })).toEqual(["stop"]);
  });

  test("read-only commands are not refused", async () => {
    const events = await run("active-sessions", [], privateDataDir);
    expect(events[0]).toBe("client");
  });
});
