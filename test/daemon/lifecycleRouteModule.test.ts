import { describe, expect, test } from "bun:test";
import {
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_REPUBLISH_IDENTITY_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
} from "../../src/daemon/daemonRestartAdmission";
import {
  daemonLifecycleRoutes,
  type DaemonLifecycleRouteDeps,
} from "../../src/daemon/socketServer/lifecycleRouteModule";
import type { DaemonRequest } from "../../src/daemon/types";

/** #11819: the eight `ide/…`-named daemon lifecycle methods are one table, wire names unchanged. */
function fixture() {
  const calls: string[] = [];
  const record = (name: string) => (params: Record<string, unknown>, owner?: string) => {
    calls.push(`${name}:${JSON.stringify(params)}:${owner ?? "-"}`);
    return { ran: name } as never;
  };
  const deps: DaemonLifecycleRouteDeps = {
    republishIdentity: async (params) => record("republish")(params),
    restart: {
      prepareDaemonRestart: record("prepareRestart"),
      prepareDaemonMaintenance: record("prepareMaintenance"),
      completeDaemonMaintenance: record("completeMaintenance"),
      restartAdmittedDaemon: record("restartAdmitted"),
      restartAcceptanceSession: record("restartAcceptance"),
      commitAcceptanceRestart: record("commitAcceptance"),
      releaseAcceptanceRestart: record("releaseAcceptance"),
    },
  };
  const routes = daemonLifecycleRoutes(deps);
  const call = async (method: string, owner?: string) => {
    const request: DaemonRequest = {
      id: "1",
      type: "daemon_request",
      method,
      params: { token: "t" },
    };
    return await routes.get(method)!(request, owner);
  };
  return { calls, call, routes };
}

const WIRE_NAMES = [
  ["ide/republishIdentity", DAEMON_REPUBLISH_IDENTITY_METHOD, "republish", "-"],
  ["ide/prepareRestart", DAEMON_PREPARE_RESTART_METHOD, "prepareRestart", "-"],
  ["ide/prepareMaintenance", DAEMON_PREPARE_MAINTENANCE_METHOD, "prepareMaintenance", "-"],
  ["ide/completeMaintenance", DAEMON_COMPLETE_MAINTENANCE_METHOD, "completeMaintenance", "-"],
  ["ide/restartAdmitted", DAEMON_RESTART_ADMITTED_METHOD, "restartAdmitted", "-"],
  [
    "ide/restartAcceptanceSession",
    DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
    "restartAcceptance",
    "owner",
  ],
  [
    "ide/commitAcceptanceRestart",
    DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
    "commitAcceptance",
    "owner",
  ],
  [
    "ide/releaseAcceptanceRestart",
    DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
    "releaseAcceptance",
    "owner",
  ],
] as const;

describe("daemon lifecycle route table", () => {
  test("serves exactly the eight lifecycle methods", () => {
    expect([...fixture().routes.keys()].sort()).toEqual(WIRE_NAMES.map(([name]) => name).sort());
  });

  test.each(WIRE_NAMES)(
    "%s keeps its wire name and runs its operation",
    async (name, constant, op, owner) => {
      expect(constant).toBe(name);
      const { calls, call } = fixture();
      expect(await call(name, owner === "-" ? undefined : owner)).toEqual({ ran: op });
      expect(calls).toEqual([`${op}:{"token":"t"}:${owner}`]);
    },
  );
});
