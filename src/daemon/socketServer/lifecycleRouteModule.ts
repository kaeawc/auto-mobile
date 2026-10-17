import {
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_REPUBLISH_IDENTITY_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
} from "../daemonRestartAdmission";
import type { RestartAdmission } from "./restartAdmission";
import type { IdeRouteHandler } from "./ideRouteModule";

/**
 * The daemon lifecycle control methods (#11819): named `ide/…` on the wire for compatibility, but
 * they belong to the daemon, not to an IDE. One table maps each wire name to the restart-admission
 * or identity operation it runs. Wire names are unchanged.
 */
export interface DaemonLifecycleRouteDeps {
  republishIdentity: (params: Record<string, unknown>) => Promise<unknown>;
  restart: Pick<
    RestartAdmission,
    | "prepareDaemonRestart"
    | "prepareDaemonMaintenance"
    | "completeDaemonMaintenance"
    | "restartAdmittedDaemon"
    | "restartAcceptanceSession"
    | "commitAcceptanceRestart"
    | "releaseAcceptanceRestart"
  >;
}

export function daemonLifecycleRoutes(
  deps: DaemonLifecycleRouteDeps,
): ReadonlyMap<string, IdeRouteHandler> {
  return new Map<string, IdeRouteHandler>([
    [
      DAEMON_REPUBLISH_IDENTITY_METHOD,
      async (request) => await deps.republishIdentity(request.params),
    ],
    [
      DAEMON_PREPARE_RESTART_METHOD,
      async (request) => deps.restart.prepareDaemonRestart(request.params),
    ],
    [
      DAEMON_PREPARE_MAINTENANCE_METHOD,
      async (request) => deps.restart.prepareDaemonMaintenance(request.params),
    ],
    [
      DAEMON_COMPLETE_MAINTENANCE_METHOD,
      async (request) => deps.restart.completeDaemonMaintenance(request.params),
    ],
    [
      DAEMON_RESTART_ADMITTED_METHOD,
      async (request) => deps.restart.restartAdmittedDaemon(request.params),
    ],
    [
      DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
      async (request, socketSessionId) =>
        deps.restart.restartAcceptanceSession(request.params, socketSessionId),
    ],
    [
      DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
      async (request, socketSessionId) =>
        deps.restart.commitAcceptanceRestart(request.params, socketSessionId),
    ],
    [
      DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
      async (request, socketSessionId) =>
        deps.restart.releaseAcceptanceRestart(request.params, socketSessionId),
    ],
  ]);
}
