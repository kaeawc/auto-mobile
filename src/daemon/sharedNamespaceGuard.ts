import { ActionableError } from "../models/ActionableError";
import { resolveDaemonStatePath } from "./constants";

/** CLI opt-in to act on the shared (resident) daemon despite a private state environment. */
export const ALLOW_SHARED_NAMESPACE_FLAG = "--allow-shared-namespace";
/** Env opt-in for the same, for hosts whose only daemon uses relocated state (e.g. containers). */
export const ALLOW_SHARED_NAMESPACE_ENV = "AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE";
/** Typed refusal code for a lifecycle action blocked by {@link assertDaemonNamespaceMatchesState}. */
export const SHARED_DAEMON_NAMESPACE_CODE = "shared_daemon_namespace";

/**
 * Env vars that relocate one daemon's own state: its data root and its SQLite file (the daemon
 * reports the one `dbPath` it owns, #2795). Setting one means "this caller expects a daemon that
 * uses this state". The daemon namespace (control socket, PID and lock files) is resolved
 * separately, only from `AUTOMOBILE_AUX_SOCKET_DIR` or the explicit `AUTOMOBILE_DAEMON_*_PATH`
 * overrides (`resolveDaemonStatePath`), so with one of these set and no namespace override the
 * caller still reaches the shared resident daemon, which runs on different state (#11252).
 *
 * Deliberately absent:
 * - `AUTOMOBILE_LOG_DIR` only redirects log files and holds no daemon state.
 * - `AUTOMOBILE_COORDINATION_DIR` and `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` are lease roots
 *   every cooperating daemon must share (docs/using/environment-variables.md; the benchmark
 *   harness keeps the coordination dir inherited because it "is shared, not a daemon
 *   selector"), and a read-only home sets them permanently.
 */
export const DAEMON_STATE_ENV_VARS = [
  ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"],
  ["AUTOMOBILE_DB_DIR", "AUTO_MOBILE_DB_DIR"],
  ["AUTOMOBILE_DB_PATH", "AUTO_MOBILE_DB_PATH"],
] as const;

/** Names of the daemon-state env vars set (non-blank) in `env`, primary name first. */
export function setDaemonStateEnvVars(env: NodeJS.ProcessEnv): string[] {
  return DAEMON_STATE_ENV_VARS.flatMap(([primary, legacy]) => {
    if (env[primary]?.trim()) {
      return [primary];
    }
    return env[legacy]?.trim() ? [legacy] : [];
  });
}

/** Whether `env` resolves the daemon control socket away from the resident default path. */
export function isDaemonNamespaceIsolated(env: NodeJS.ProcessEnv): boolean {
  return resolveDaemonStatePath("sock", env) !== resolveDaemonStatePath("sock", {});
}

/** A lifecycle action refused because it would reach the shared daemon (#11252). */
export class SharedDaemonNamespaceError extends ActionableError {
  readonly code = SHARED_DAEMON_NAMESPACE_CODE;
  readonly nextAction: string;

  constructor(action: string, stateVars: string[], socketPath: string) {
    const nextAction =
      `Set AUTOMOBILE_AUX_SOCKET_DIR (or AUTOMOBILE_DAEMON_SOCKET_PATH, AUTOMOBILE_DAEMON_PID_FILE_PATH ` +
      `and AUTOMOBILE_DAEMON_LOCK_FILE_PATH) to target a private daemon, or pass ` +
      `${ALLOW_SHARED_NAMESPACE_FLAG} (or set ${ALLOW_SHARED_NAMESPACE_ENV}=1) to act on the shared daemon deliberately.`;
    super(
      `Refusing to ${action}: ${stateVars.join(", ")} ${stateVars.length === 1 ? "is" : "are"} set, ` +
        `but AUTOMOBILE_AUX_SOCKET_DIR and AUTOMOBILE_DAEMON_SOCKET_PATH are not, so this would act on ` +
        `the shared daemon at ${socketPath}, which runs on different state. ${nextAction} ` +
        `[${SHARED_DAEMON_NAMESPACE_CODE}]`,
    );
    this.nextAction = nextAction;
  }
}

/**
 * Refuse a daemon lifecycle or release action when `env` relocates daemon state but not the
 * daemon namespace, so the action would stop, replace or release on the resident daemon instead
 * of the private one the caller configured (#11252). `allowShared` (the
 * {@link ALLOW_SHARED_NAMESPACE_FLAG} flag) or {@link ALLOW_SHARED_NAMESPACE_ENV}=1 opts out.
 */
export function assertDaemonNamespaceMatchesState(
  action: string,
  env: NodeJS.ProcessEnv,
  allowShared = false,
): void {
  if (allowShared || env[ALLOW_SHARED_NAMESPACE_ENV]?.trim() === "1") {
    return;
  }
  const stateVars = setDaemonStateEnvVars(env);
  if (stateVars.length === 0 || isDaemonNamespaceIsolated(env)) {
    return;
  }
  throw new SharedDaemonNamespaceError(action, stateVars, resolveDaemonStatePath("sock", env));
}
