import { ActionableError } from "../models/ActionableError";
import type { AuxiliaryDaemonSocketName } from "./types";

/** A live or replaced path must never be reclaimed by an auxiliary server. */
export class AuxiliarySocketBindConflict extends ActionableError {
  constructor(
    readonly socketPath: string,
    serverName: string,
  ) {
    super(
      `[${serverName}] Refusing to bind auxiliary socket ${socketPath}: another daemon is listening. Stop the daemon that owns it or use \`--daemon restart\` to replace it.`,
    );
  }
}

export interface AuxiliarySocketWarning {
  code: "AUXILIARY_SOCKET_UNAVAILABLE";
  name: string;
  socketPath: string;
}

// Stream delivery is optional. Keep configuration/control endpoints fail-closed:
// IDE mutations must not silently reach an incumbent's endpoint instead.
const optionalStreams = new Set<AuxiliaryDaemonSocketName>([
  "observation-stream",
  "performance-stream",
  "performance-push",
  "failures-stream",
  "failures-push",
  "telemetry-push",
  "video-stream",
  "webrtc-stream",
]);
type KnownSocketWarning = AuxiliarySocketWarning & { name: AuxiliaryDaemonSocketName };
const unavailable = new Map<AuxiliaryDaemonSocketName, KnownSocketWarning>();

export function degradeAuxiliarySocket(
  name: AuxiliaryDaemonSocketName,
  error: unknown,
): AuxiliarySocketWarning | undefined {
  if (!(error instanceof AuxiliarySocketBindConflict) || !optionalStreams.has(name)) {
    return undefined;
  }
  const warning: KnownSocketWarning = {
    code: "AUXILIARY_SOCKET_UNAVAILABLE",
    name,
    socketPath: error.socketPath,
  };
  unavailable.set(name, warning);
  return warning;
}

export function markAuxiliarySocketAvailable(name: AuxiliaryDaemonSocketName): void {
  unavailable.delete(name);
}

export function isAuxiliarySocketUnavailable(name: AuxiliaryDaemonSocketName): boolean {
  return unavailable.has(name);
}

export function getUnavailableAuxiliarySockets(): KnownSocketWarning[] {
  return [...unavailable.values()];
}

/** Degraded paths are diagnostics, never advertised endpoints owned by this daemon. */
export function availableDaemonSockets(sockets: Record<string, string>): Record<string, string> {
  const degraded = new Set<string>(getUnavailableAuxiliarySockets().map(({ name }) => name));
  return Object.fromEntries(Object.entries(sockets).filter(([name]) => !degraded.has(name)));
}
