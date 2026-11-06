import type { AdbReverseEntry } from "../../utils/android-cmdline-tools/adbReverse";
import type { AdbReverseHolderKind } from "./AdbReverseOwnership";
import type { HostLoopbackProbe, HostLoopbackState } from "./HostLoopbackProbe";
import {
  PortReverseError,
  type PortReverseConflict,
  type PortReverseConflictKind,
} from "./PortReverseError";

/** One device port to reverse to a host loopback port. */
interface ConflictRequest {
  devicePort: number;
  hostPort: number;
}

/** What `ensure` knows about the device and the caller when judging conflicts. */
export interface ConflictContext {
  owner: string;
  /** The call is session-routed, so the device is bound to the caller. */
  holdsDevice: boolean;
  /** Device port -> what `adb reverse --list` shows there. */
  view: ReadonlyMap<number, AdbReverseEntry>;
  /** Device port -> the session that owns AutoMobile's mapping there. */
  owned: ReadonlyMap<number, { hostPort: number; owner: string }>;
  /** The other AutoMobile manager (a prototype) holding the device port, if any (#17253). */
  heldElsewhere: (devicePort: number) => AdbReverseHolderKind | undefined;
}

/** Stale mappings `ensure` may replace, and prototype-held ones it may share as they are. */
export interface ConflictOutcome {
  reclaimable: Map<number, AdbReverseEntry>;
  shared: number[];
}

export interface ConflictOptions {
  hostProbe: HostLoopbackProbe;
  reclaimStale: boolean;
}

/** A conflicting port, with the text that explains it. */
interface ConflictFinding extends PortReverseConflict {
  reason: string;
}

type Finding =
  | { kind: "conflict"; conflict: ConflictFinding }
  | { kind: "reclaim"; entry: AdbReverseEntry }
  | { kind: "share"; devicePort: number }
  | undefined;

const tcp = (port: number) => `tcp:${port}`;

/**
 * Throws `port_reverse_conflict` for every requested port held by someone else; returns the ports
 * whose stale mapping may be reclaimed instead (only with `reclaimStale`), and the prototype-held
 * ports already mapped as requested, which the caller joins rather than adds.
 */
export async function assertNoConflicts(
  context: ConflictContext,
  wanted: readonly ConflictRequest[],
  options: ConflictOptions,
): Promise<ConflictOutcome> {
  const reclaimable = new Map<number, AdbReverseEntry>();
  const shared: number[] = [];
  const findings = await Promise.all(
    wanted.map((request) => conflictFor(context, request, options)),
  );
  const conflicts = findings.flatMap((finding) => {
    if (finding?.kind === "reclaim") {
      reclaimable.set(finding.entry.devicePort, finding.entry);
      return [];
    }
    if (finding?.kind === "share") {
      shared.push(finding.devicePort);
      return [];
    }
    return finding === undefined ? [] : [finding.conflict];
  });
  if (conflicts.length > 0) {
    throw new PortReverseError(
      "port_reverse_conflict",
      `Cannot reverse ports already in use: ${conflicts.map((c) => c.reason).join("; ")}. ` +
        "Existing mappings were left in place; remove them first or choose another port.",
      conflicts.map((c) => c.devicePort),
      conflicts.map(({ devicePort, conflictKind }) =>
        conflictKind === undefined ? { devicePort } : { devicePort, conflictKind },
      ),
    );
  }
  return { reclaimable, shared };
}

/** Why one request clashes, whether its stale mapping may be replaced, or undefined. */
async function conflictFor(
  context: ConflictContext,
  request: ConflictRequest,
  options: ConflictOptions,
): Promise<Finding> {
  const owned = context.owned.get(request.devicePort);
  const live = context.view.get(request.devicePort);
  const own = ownConflict(context.owner, owned, request);
  if (own !== undefined) {
    return { kind: "conflict", conflict: own };
  }
  const shared = prototypeFinding(context, owned, live, request);
  if (shared !== undefined) {
    return shared;
  }
  if (live === undefined || (owned !== undefined && live.hostPort === owned.hostPort)) {
    return undefined;
  }
  const host =
    live.hostPort === undefined ? "unknown" : await options.hostProbe.probe(live.hostPort);
  const conflictKind: PortReverseConflictKind =
    host === "listening" ? "external_live" : "external_unknown";
  const port = tcp(request.devicePort);
  const held =
    owned === undefined
      ? `${port} already maps to ${live.host}, not created by AutoMobile`
      : `${port} was re-pointed to ${live.host} outside AutoMobile`;
  const conflict = (reason: string): Finding => ({
    kind: "conflict",
    conflict: { devicePort: request.devicePort, conflictKind, reason },
  });
  if (owned !== undefined || !options.reclaimStale) {
    return conflict(held);
  }
  const refusal = reclaimRefusal(context.holdsDevice, live, host);
  return refusal === undefined
    ? { kind: "reclaim", entry: live }
    : conflict(`${held}; not reclaimed: ${refusal}`);
}

/**
 * A mapping no session owns but a prototype holds: shared when it already points where asked, else
 * a `prototype` conflict. Undefined for any other port.
 */
function prototypeFinding(
  context: ConflictContext,
  owned: { hostPort: number; owner: string } | undefined,
  live: AdbReverseEntry | undefined,
  request: ConflictRequest,
): Finding {
  if (owned !== undefined || live === undefined || !context.heldElsewhere(request.devicePort)) {
    return undefined;
  }
  if (live.hostPort === request.hostPort) {
    return { kind: "share", devicePort: request.devicePort };
  }
  return {
    kind: "conflict",
    conflict: {
      devicePort: request.devicePort,
      conflictKind: "prototype",
      reason: `${tcp(request.devicePort)} maps to ${live.host} for a prototype's via "device" request`,
    },
  };
}

/** A clash with a mapping a session owns: another session's, or this one's to another host port. */
function ownConflict(
  owner: string,
  owned: { hostPort: number; owner: string } | undefined,
  request: ConflictRequest,
): ConflictFinding | undefined {
  if (owned === undefined) {
    return undefined;
  }
  const port = tcp(request.devicePort);
  if (owned.owner !== owner) {
    return {
      devicePort: request.devicePort,
      conflictKind: "other_session",
      reason: `${port} is owned by another session`,
    };
  }
  return owned.hostPort === request.hostPort
    ? undefined
    : {
        devicePort: request.devicePort,
        reason: `${port} already maps to ${tcp(owned.hostPort)} for this session`,
      };
}

/** Why a stale mapping may not be reclaimed, or undefined when every condition holds. */
function reclaimRefusal(
  holdsDevice: boolean,
  live: AdbReverseEntry,
  host: HostLoopbackState,
): string | undefined {
  if (!holdsDevice) {
    return "reclaimStale needs a session that holds the device";
  }
  if (live.hostPort === undefined) {
    return `its host side ${live.host} is not tcp:`;
  }
  if (host === "listening") {
    return `host port ${live.hostPort} accepts connections`;
  }
  return host === "refused" ? undefined : `host port ${live.hostPort} could not be checked`;
}
