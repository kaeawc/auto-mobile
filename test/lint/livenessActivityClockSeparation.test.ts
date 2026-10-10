import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  PROXY_ACTIVITY_CLOCKS,
  SESSION_ACTIVITY_CLOCKS,
  SESSION_LIVENESS_CLOCKS,
} from "../../src/daemon/sessionClocks";

/**
 * Liveness never counts as use (issues #10656 and #10668).
 *
 * A session has two kinds of clock:
 *
 * - **Activity clocks** say when the session was last USED. Only tool usage may
 *   write them: the daemon's idle deadline (`lastUsedAt`, `expiresAt`) and the
 *   stdio proxy's replay lease (`boundSessionUuidAt`).
 * - **Liveness clocks** say the owner process is still ALIVE: `lastHeartbeat`,
 *   `lastOwnerHeartbeat`, `stallForgivenAt`, `hasReceivedHeartbeat`. Heartbeats,
 *   claims and keeper ticks write these.
 *
 * #10656 was one line class: `SessionManager.recordHeartbeat` wrote
 * `lastUsedAt`/`expiresAt`, and the proxy's heartbeat ack wrote
 * `boundSessionUuidAt`. The stdio proxy heartbeats every 5 s whether or not its
 * agent calls a tool, so an idle but live owner held its device forever. Those
 * sites had been edited repeatedly, with comments claiming the opposite of the
 * code, so this is a structural guard rather than a convention.
 *
 * The rule, checked on the TypeScript AST (not line regexes):
 *
 * 1. No liveness-only or cache-only function writes an activity clock, directly
 *    or through a same-file helper it calls (`this.m()` or a module function),
 *    transitively. A write is an assignment (`=`, compound, `++`/`--`), an
 *    object-literal property that computes a clock (anything but a copy of the
 *    same clock from another object, such as `{ lastUsedAt: now }` or
 *    `{ expiresAt }`), or an `Object.assign` / `map.set(key, value)` that stores
 *    a copied clock (a restoration). Retiring a clock (`= undefined`, `delete`)
 *    is not a write: it can only end a lease, never extend one. Cache-only paths
 *    are included because they are reached by callers that are not the owner's
 *    tool usage (a device incarnation change, an observe by device id, #10703).
 * 2. The one sanctioned exception: a policy change (CLI adoption/restoration)
 *    may re-derive the idle deadline through a named helper whose body never
 *    reads the current time, so the deadline stays anchored on the last tool
 *    call. The helpers are verified, not trusted.
 * 3. Every write site of an activity clock in `src/daemon`, `src/server` and
 *    `src/db` is inventoried by file and function with a count and a reason. A
 *    new write site fails until someone classifies it as tool usage.
 * 4. The persistence mirror: the persisted `lastUsedAtMs`/`expiresAtMs` are
 *    copied from the session object, never computed from the clock, so a
 *    liveness path that persists the session cannot write fresh activity.
 * 5. The read side (#10700, #10703): an idle-expiry judgement reads only
 *    activity clocks, and a lease judgement reads only liveness clocks.
 * 6. Reads are not use (#10964): in the device-tool registry, every
 *    `markSessionAdmitted` call (which makes the call's end session activity) is
 *    in the then-branch of an `if` that negates the call's read classification,
 *    so a `deviceReadOnly` call can never be credited.
 *
 * The clock names come from `src/daemon/sessionClocks.ts`, which checks them
 * against the `Session` fields, so a rename cannot silently escape this guard.
 */

const ROOT = join(import.meta.dir, "..", "..");

const ACTIVITY_CLOCKS: ReadonlySet<string> = new Set([
  ...SESSION_ACTIVITY_CLOCKS,
  ...PROXY_ACTIVITY_CLOCKS,
]);
/** Liveness clocks, and the lease helpers that read them, for the read-side rule. */
const LIVENESS_READS: ReadonlySet<string> = new Set([
  ...SESSION_LIVENESS_CLOCKS,
  "effectiveLastHeartbeat",
  "ownerLeaseHeartbeat",
  "livenessLeaseState",
]);

/** Liveness-only entry points, per file. Keys are `Class.method` or a module function name. */
const LIVENESS_ONLY: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/sessionManager.ts": [
    "SessionManager.recordHeartbeat",
    "SessionManager.claimLivenessOwnership",
    "SessionManager.claimLivenessOwnershipForSession",
    "SessionManager.persistNewLivenessOwnershipClaim",
    "SessionManager.claimUnownedLivenessOwnership",
    "SessionManager.releaseLivenessOwnership",
    "SessionManager.adoptCliLivenessPolicy",
    "SessionManager.restoreHeartbeatLivenessPolicy",
    "SessionManager.forgiveDaemonStall",
  ],
  "src/daemon/daemonRequestHandlers.ts": ["handleHeartbeat"],
  "src/daemon/daemon.ts": ["Daemon.handleHeartbeatHttpRequest"],
  "src/daemon/cli/runDaemonCommand.ts": ["recordLocalDaemonHeartbeat"],
  "src/daemon/daemonMcpProxy.ts": [
    "DaemonMcpProxy.sendFirstBoundSessionHeartbeat",
    "DaemonMcpProxy.sendBoundSessionHeartbeat",
    "DaemonMcpProxy.recordBoundSessionHeartbeatSuccess",
    "DaemonMcpProxy.heartbeatHeldSession",
  ],
};

/**
 * Cache-only entry points (#10703): they store session cache data and are reached by callers
 * that are not the owner's tool usage, so like liveness paths they never write activity clocks.
 */
const CACHE_ONLY: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/sessionManager.ts": [
    "SessionManager.updateSessionCache",
    "SessionManager.getSessionCache",
    "SessionManager.setLastHierarchy",
    "SessionManager.resetDeviceReadinessForDevice",
    "SessionManager.invalidateAutomationReadinessForDevice",
  ],
};

/** Every path that is not tool usage: liveness-only and cache-only roots, per file. */
const NON_ACTIVITY_PATHS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [...new Set([...Object.keys(LIVENESS_ONLY), ...Object.keys(CACHE_ONLY)])].map((path) => [
    path,
    [...(LIVENESS_ONLY[path] ?? []), ...(CACHE_ONLY[path] ?? [])],
  ]),
);

/** Rule 5: idle-expiry judgements read only activity clocks. */
const EXPIRY_JUDGEMENTS: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/sessionManager.ts": [
    "SessionManager.isSessionExpired",
    "SessionManager.isSessionExpiredForNewExecution",
  ],
  "src/daemon/sessionHoldDiagnostics.ts": ["idleReleaseAt", "vetoedIdleReleaseAt"],
  "src/daemon/daemonMcpProxy.ts": [
    "DaemonMcpProxy.evictAbandonedHeldSessions",
    // The replay-lease TTL (#10656): a heartbeat ack must not keep a dead binding replayable.
    "DaemonMcpProxy.isBoundSessionReplayExpired",
  ],
};

/**
 * Rule 7 (#11105): functions that compare session stamps (`lastHeartbeat`, `expiresAt`,
 * `released_at_ms`, ...) with "now". Session stamps are on the steady session clock, so these
 * read `sessionNow()` / `recoveryNow()`, never the raw wall clock `timer.now()`, which a wall
 * step moves away from them.
 */
const SESSION_CLOCK_JUDGEMENTS: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/sessionManager.ts": ["SessionManager.isSessionExpired"],
  "src/daemon/ownerDisconnectRelease.ts": ["ownerDisconnectReleaseBlocker"],
  "src/daemon/devicePool.ts": [
    "DevicePool.recoveryAssignmentError",
    "DevicePool.recoveryNow",
    // #11162: the restart-recovery wait and retry gate compare with the recovery deadline.
    "DevicePool.assignmentRetryPolicy",
  ],
};

/** Rule 5: lease judgements read only liveness clocks. */
const LEASE_JUDGEMENTS: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/livenessOwnerLease.ts": [
    "livenessLeaseState",
    "isLivenessOwnerLeaseLive",
    "effectiveLastHeartbeat",
    "ownerLeaseHeartbeat",
    // #11080: whether an owner was live when a daemon stall began, for narrow forgiveness.
    "ownerLeaseLiveAt",
    // #11162: the judged lease start, which stall forgiveness also anchors on.
    "judgedLeaseHeartbeat",
  ],
  "src/daemon/SessionHeartbeatMonitor.ts": [
    "SessionHeartbeatMonitor.heartbeatLeaseStaleReason",
    "SessionHeartbeatMonitor.rehydrationOwnerStaleReason",
  ],
};

/**
 * Helpers a liveness-only policy change may call to re-derive the idle deadline
 * from the last tool activity. Rule 2 verifies each one never reads the clock.
 */
const DEADLINE_REDERIVATION_HELPERS: Readonly<Record<string, readonly string[]>> = {
  "src/daemon/sessionManager.ts": [
    "widenIdleDeadlineFromLastActivity",
    "rebaseIdleDeadlineOnLastActivity",
  ],
};

interface Classified {
  /** Exact number of activity-clock writes in the function. */
  readonly writes: number;
  readonly reason: string;
}

/**
 * Liveness-only functions that still write an activity clock: known exceptions,
 * each with the issue that justifies it. An entry that no longer matches fails, so
 * removing or adding a write forces this list to be updated.
 */
const KNOWN_LIVENESS_WRITES: Readonly<Record<string, Classified>> = {
  "src/daemon/sessionManager.ts SessionManager.forgiveDaemonStall": {
    writes: 2,
    reason:
      "#10662: stall forgiveness compensates for time the daemon itself lost. It shifts " +
      "expiresAt by at most the lost interval (never to a full window from resume), so it grants " +
      "no hold time a non-stalled session would not have had. #10835: a cli-idle session's " +
      "idleStallForgivenAt moves by the same bounded lost interval.",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.holdTokenOwnedSession": {
    writes: 1,
    reason:
      "#10990: any connection, including one a keeper heartbeat re-establishes, resumes the " +
      "sessions the proxy's stable owner token holds. The held session's lastUsedAt is copied " +
      "from the daemon's own last-tool-use clock, never the current time, so resuming grants no " +
      "idle time.",
  },
};

/**
 * Every activity-clock write site in src/daemon, src/server and src/db, keyed by
 * `<file> <function>`. Keys must stay exact: a new site fails until classified.
 */
const WRITE_INVENTORY: Readonly<Record<string, Classified>> = {
  // --- Session idle clocks (SessionManager) --------------------------------
  "src/daemon/sessionManager.ts SessionManager.reclaimAndRefreshExistingSession": {
    writes: 4,
    reason:
      "Tool usage: getOrCreateSession resolving a session for a tool call refreshes " +
      "lastUsedAt/expiresAt, and restores both if the durable write fails.",
  },
  "src/daemon/sessionManager.ts SessionManager.createSession": {
    writes: 2,
    reason:
      "Tool usage: a session is created for a device acquisition (a tool call), and its " +
      "lastUsedAt/expiresAt start the idle window from that moment.",
  },
  "src/daemon/sessionManager.ts SessionManager.recordToolCallEnded": {
    writes: 2,
    reason:
      "Tool usage: the end of a tool call restarts the idle window (owner decision 2026-10-08), " +
      "so idleness counts from the end of the last call; the execution tracker fires it, and " +
      "only a call admitted under the session writes (#10824).",
  },
  "src/daemon/sessionManager.ts widenIdleDeadlineFromLastActivity": {
    writes: 1,
    reason: "Policy: CLI adoption re-derives expiresAt from lastUsedAt (verified by rule 2).",
  },
  "src/daemon/sessionManager.ts rebaseIdleDeadlineOnLastActivity": {
    writes: 1,
    reason: "Policy: heartbeat restoration re-derives expiresAt from lastUsedAt (rule 2).",
  },
  "src/daemon/sessionManager.ts SessionManager.forgiveDaemonStall": {
    writes: 2,
    reason:
      "Stall compensation (shift by the lost interval), listed in KNOWN_LIVENESS_WRITES " +
      "(#10662, #10835).",
  },

  // --- Proxy replay lease (DaemonMcpProxy) ---------------------------------
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.constructor": {
    writes: 1,
    reason: "Binding: a configured --initial-session-uuid starts its replay lease.",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.bindResultMintedDeviceSession": {
    writes: 1,
    reason: "Tool usage: a device-acquisition result (getAndroid/getApple/startDevice) binds.",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.creditSessionUse": {
    writes: 2,
    reason:
      "Tool usage: the end of a forwarded call that reached the session restarts the latest " +
      "binding's replay lease and a held session's lastUsedAt, so idleness counts from the end " +
      "of the last call however long it ran. Called for the session a call named " +
      "(endOneSessionCall) and for the session the daemon echoed as the one it routed an " +
      "admitted control call to (#10692, #10974); a read or refused call carries no echo.",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.holdPreviousBinding": {
    writes: 1,
    reason:
      "Tool usage: a newer binding demotes the previous one to a held session whose lastUsedAt " +
      "carries that binding's replay lease (boundSessionUuidAt, itself only stamped by tool " +
      "calls), so held-session idle eviction keys off tool use, never heartbeat acks (#10677).",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.holdTokenOwnedSession": {
    writes: 1,
    reason:
      "Resume (#10990): a session the stable owner token holds is held with the daemon's own " +
      "lastUsedAt, listed in KNOWN_LIVENESS_WRITES.",
  },
  "src/daemon/daemonRequestHandlers.ts handleTokenOwnedSessions": {
    writes: 1,
    reason:
      "A read projection (#11117): the tokenOwnedSessions answer reports the session's lastUsedAt " +
      "converted to wall-clock ms for the resuming proxy; it stamps nothing.",
  },
  "src/daemon/daemonMcpProxy.ts <module>": {
    writes: 1,
    reason: "The tokenOwnedSessions answer schema (zod) declares lastUsedAt, not a clock value.",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.stallRestoreSnapshot": {
    writes: 1,
    reason:
      "Rollback record: a daemon_stalled handover copies the session's tool-use clock " +
      "(boundSessionUuidAt or the held lastUsedAt) unchanged, so a resume can put it back (#10989).",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.restoreResumedSession": {
    writes: 1,
    reason:
      "Rollback: a session resumed after a daemon_stalled handover is held again with the " +
      "lastUsedAt it had before the handover; the heartbeat ack that resumed it renews nothing (#10989).",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.rebindResumedSession": {
    writes: 1,
    reason:
      "Rollback: a latest binding resumed after a daemon_stalled handover gets back the replay " +
      "lease it had before the handover; the heartbeat ack that resumed it renews nothing (#10989).",
  },
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.updateBoundSessionUuid": {
    writes: 1,
    reason: "Tool usage: a forwarded call (explicit or injected sessionUuid) renews the lease.",
  },

  // --- Same names, different clocks -----------------------------------------
  "src/daemon/devicePool.ts DevicePool.addDevice": {
    writes: 2,
    reason:
      "PooledDevice.lastUsedAt is the pool's LRU order (assigned, or stored with a new pool " +
      "entry), not a session idle clock.",
  },
  "src/daemon/devicePool.ts DevicePool.initializeWithDevices": {
    writes: 1,
    reason: "PooledDevice LRU order seeded for each discovered device, not a session idle clock.",
  },
  "src/daemon/devicePoolRefresh.ts DevicePoolRefresh.refreshDevicesInternal": {
    writes: 1,
    reason:
      "PooledDevice LRU order seeded for a newly discovered device, not a session idle clock.",
  },
  "src/daemon/devicePool.ts DevicePool.assignDeviceToBoundSession": {
    writes: 1,
    reason: "PooledDevice LRU order on assignment, not a session idle clock.",
  },
  "src/daemon/devicePool.ts DevicePool.claimSelectedDeviceForSession": {
    writes: 1,
    reason: "PooledDevice LRU order on assignment, not a session idle clock.",
  },
  "src/daemon/devicePool.ts DevicePool.adoptSystemUiAnrReplacement": {
    writes: 1,
    reason: "PooledDevice LRU order carried to a SystemUI-ANR replacement device.",
  },
  "src/daemon/devicePool.ts DevicePool.replaceStoppedDeviceForSystemUiAnr": {
    writes: 1,
    reason: "PooledDevice LRU order carried to a SystemUI-ANR replacement device.",
  },
  "src/daemon/devicePool.ts DevicePool.restoreSystemUiAnrRecoverySession": {
    writes: 1,
    reason: "PooledDevice LRU order on SystemUI-ANR recovery.",
  },
  "src/daemon/deviceAutolockManager.ts DeviceAutolockManager.autolockDeviceExclusive": {
    writes: 1,
    reason: "PooledDevice LRU order on autolock assignment, not a session idle clock.",
  },
  "src/server/webrtcStreamManager.ts acquireLease": {
    writes: 2,
    reason:
      "WebRTC stream subscription lease expiry (renewed, or stored with a new lease), unrelated " +
      "to device sessions.",
  },
  "src/server/webrtcStreamManager.ts endLease": {
    writes: 1,
    reason: "WebRTC stream end-of-lease record expiry, unrelated to device sessions.",
  },
  "src/server/appResources.ts getAppMetadataResource": {
    writes: 1,
    reason: "App-metadata resource cache TTL, unrelated to device sessions.",
  },
  "src/server/appResources.ts fetchAppsForDevice": {
    writes: 2,
    reason: "Installed-apps resource cache TTL, unrelated to device sessions.",
  },
  "src/server/webrtcStreamManager.ts describeRecord": {
    writes: 1,
    reason:
      "WebRTC stream descriptor reporting its subscription lease expiry, not a session clock.",
  },
  "src/server/NetworkState.ts NetworkState.startSimulationUntil": {
    writes: 1,
    reason: "Network-error simulation expiry, unrelated to device sessions.",
  },
  "src/server/retainedScreenshot.ts readRetainedScreenshot": {
    writes: 1,
    reason: "Retained screenshot file-protection expiry, unrelated to device sessions.",
  },
  "src/server/snapshotOfTools.ts registerSnapshotOfTools": {
    writes: 1,
    reason: "Retained screenshot file-protection expiry in a tool response, not a session clock.",
  },
  "src/server/toolOutputSchemas.ts <module>": {
    writes: 2,
    reason: "Output-schema field declarations (zod), not clock values.",
  },
  "src/daemon/cli/runDaemonCommand.ts parseAcceptanceSessionRestartScope": {
    writes: 1,
    reason: "Acceptance-harness restart scope expiry parsed from CLI flags, not a session clock.",
  },
};

const INVENTORY_DIRS = ["src/daemon", "src/server", "src/db"] as const;

interface FunctionUnit {
  readonly key: string;
  readonly className: string | undefined;
  readonly node: ts.Node;
}

interface Write {
  readonly clock: string;
  readonly line: number;
}

interface FileModel {
  readonly path: string;
  readonly source: ts.SourceFile;
  readonly functions: ReadonlyMap<string, FunctionUnit>;
  readonly keyByNode: ReadonlyMap<ts.Node, string>;
}

function parse(path: string, text: string): FileModel {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = collectFunctions(source);
  const keyByNode = new Map([...functions.values()].map((unit) => [unit.node, unit.key]));
  return { path, source, functions, keyByNode };
}

function propertyNameText(name: ts.PropertyName | ts.MemberName): string | undefined {
  return ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function isFunctionInitializer(initializer: ts.Expression | undefined): boolean {
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  );
}

function classMemberUnits(node: ts.ClassLikeDeclaration): FunctionUnit[] {
  const className = node.name?.text ?? "<anonymous class>";
  return node.members.flatMap((member) => {
    if (ts.isConstructorDeclaration(member)) {
      return [{ key: `${className}.constructor`, className, node: member }];
    }
    const memberName = member.name ? propertyNameText(member.name) : undefined;
    const isFunctionMember =
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      (ts.isPropertyDeclaration(member) && isFunctionInitializer(member.initializer));
    return memberName && isFunctionMember
      ? [{ key: `${className}.${memberName}`, className, node: member }]
      : [];
  });
}

/** Named functions: members of every class, and module-level functions (declared or `const f = () => …`). */
function collectFunctions(source: ts.SourceFile): Map<string, FunctionUnit> {
  const functions = new Map<string, FunctionUnit>();
  const add = (unit: FunctionUnit): void => {
    functions.set(unit.key, unit);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add({ key: statement.name.text, className: undefined, node: statement });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionInitializer(declaration.initializer)) {
          add({ key: declaration.name.text, className: undefined, node: declaration });
        }
      }
    }
  }
  const visitClasses = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      classMemberUnits(node).forEach(add);
    }
    ts.forEachChild(node, visitClasses);
  };
  visitClasses(source);
  return functions;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function clockOf(target: ts.Expression): string | undefined {
  const node = unwrap(target);
  if (ts.isPropertyAccessExpression(node) && ACTIVITY_CLOCKS.has(node.name.text)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    ACTIVITY_CLOCKS.has(node.argumentExpression.text)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** The activity clock an object-literal property carries, if any. */
function literalPropertyClock(property: ts.Node): string | undefined {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return undefined;
  }
  if (!ts.isObjectLiteralExpression(property.parent)) {
    return undefined;
  }
  const name = propertyNameText(property.name);
  return name !== undefined && ACTIVITY_CLOCKS.has(name) ? name : undefined;
}

/**
 * A literal property that copies the same clock from another object (`{ lastUsedAt:
 * session.lastUsedAt }`): a projection or a saved value, not a write on its own. Storing it back
 * (`Object.assign`, `map.set`) is a restoration and counts there.
 */
function isCopiedClockProperty(property: ts.Node, clock: string): boolean {
  if (!ts.isPropertyAssignment(property)) {
    return false;
  }
  const value = unwrap(property.initializer);
  return ts.isPropertyAccessExpression(value) && value.name.text === clock;
}

/** Copied activity clocks carried by a literal; computed ones count as writes where they stand. */
function literalClockKeys(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((property) => {
    const clock = literalPropertyClock(property);
    return clock !== undefined && isCopiedClockProperty(property, clock) ? [clock] : [];
  });
}

/**
 * Copied activity-clock keys stored from an object literal, or from a `const x = { … }` in `scope`
 * it names.
 */
function objectClockKeys(expression: ts.Expression, scope: ts.Node): string[] {
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) {
    return literalClockKeys(node);
  }
  if (!ts.isIdentifier(node)) {
    return [];
  }
  const keys: string[] = [];
  const find = (child: ts.Node): void => {
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.name.text === node.text &&
      child.initializer !== undefined
    ) {
      const initializer = unwrap(child.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        keys.push(...literalClockKeys(initializer));
      }
      return;
    }
    ts.forEachChild(child, find);
  };
  find(scope);
  return keys;
}

function isObjectAssign(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "assign" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object"
  );
}

/**
 * `<map>.set(key, { …clock })`: a keyed record stored with an activity clock, such as the proxy's
 * held-session `lastUsedAt` (#10677). Storing it stamps the clock just like an assignment.
 */
function isMapEntrySet(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "set" &&
    call.arguments.length === 2
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isIncrementOrDecrement(
  node: ts.Node,
): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function enclosingFunctionNode(node: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
  }
  return undefined;
}

function isUndefinedLiteral(node: ts.Expression): boolean {
  const value = unwrap(node);
  return (
    (ts.isIdentifier(value) && value.text === "undefined") ||
    ts.isVoidExpression(value) ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The activity clocks a single node writes (empty for anything that is not a
 * write). Retiring a clock — `= undefined`/`null`, `delete` — is not a write.
 */
function clocksWrittenBy(node: ts.Node, source: ts.SourceFile): string[] {
  const literalClock = literalPropertyClock(node);
  if (literalClock !== undefined) {
    // An object literal that computes a clock (#10703): a session or record built with it,
    // like `createSession`'s `{ lastUsedAt: now }`, stamps the clock as surely as an assignment.
    return isCopiedClockProperty(node, literalClock) ? [] : [literalClock];
  }
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isUndefinedLiteral(node.right)) {
      return [];
    }
    return [clockOf(node.left)].filter((clock): clock is string => clock !== undefined);
  }
  if (isIncrementOrDecrement(node)) {
    return [clockOf(node.operand)].filter((clock): clock is string => clock !== undefined);
  }
  if (ts.isCallExpression(node) && isObjectAssign(node)) {
    const scope = enclosingFunctionNode(node) ?? source;
    return node.arguments.slice(1).flatMap((argument) => objectClockKeys(argument, scope));
  }
  if (ts.isCallExpression(node) && isMapEntrySet(node)) {
    const scope = enclosingFunctionNode(node) ?? source;
    return objectClockKeys(node.arguments[1]!, scope);
  }
  return [];
}

/** Every activity-clock write inside `root`, including nested callbacks. */
function writesIn(source: ts.SourceFile, root: ts.Node): Write[] {
  const writes: Write[] = [];
  const visit = (node: ts.Node): void => {
    for (const clock of clocksWrittenBy(node, source)) {
      writes.push({ clock, line: lineOf(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return writes;
}

// Per-function analysis is memoized: the closure walks revisit the same functions many times.
const unitWrites = new WeakMap<FunctionUnit, Write[]>();
const unitCallees = new WeakMap<FunctionUnit, string[]>();

function unitWritesOf(model: FileModel, unit: FunctionUnit): Write[] {
  let writes = unitWrites.get(unit);
  if (!writes) {
    writes = writesIn(model.source, unit.node);
    unitWrites.set(unit, writes);
  }
  return writes;
}

/** Same-file functions `unit` calls: `this.m()` on its own class, or a module-level function. */
function calleesOf(model: FileModel, unit: FunctionUnit): string[] {
  const cached = unitCallees.get(unit);
  if (cached) {
    return cached;
  }
  const callees = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const key =
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        unit.className !== undefined
          ? `${unit.className}.${callee.name.text}`
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
      if (key !== undefined && model.functions.has(key)) {
        callees.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.node);
  const result = [...callees];
  unitCallees.set(unit, result);
  return result;
}

interface Violation {
  readonly root: string;
  readonly via: string;
  readonly clock: string;
  readonly line: number;
}

/**
 * Rule 1: walk each liveness-only root through its same-file callees and report
 * every activity-clock write, except inside a sanctioned re-derivation helper.
 */
function livenessViolations(
  model: FileModel,
  roots: readonly string[],
  sanctioned: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const root of roots) {
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0) {
      const key = queue.shift()!;
      const unit = model.functions.get(key);
      if (!unit || sanctioned.has(key)) {
        continue;
      }
      violations.push(...unitWritesOf(model, unit).map((write) => ({ root, via: key, ...write })));
      const next = calleesOf(model, unit).filter((callee) => !seen.has(callee));
      next.forEach((callee) => seen.add(callee));
      queue.push(...next);
    }
  }
  return violations;
}

/**
 * Methods of `className` whose same-file closure writes an activity clock: the
 * tool-usage entry points a liveness path in ANOTHER file must not call.
 */
function activityWritingMethods(
  model: FileModel,
  className: string,
  sanctioned: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...model.functions.values()]
      .filter((unit) => unit.className === className)
      .filter((unit) => livenessViolations(model, [unit.key], sanctioned).length > 0)
      .map((unit) => unit.key.slice(className.length + 1)),
  );
}

/** Calls `<receiver>.<method>(…)` on a non-`this` receiver anywhere in the closure of `roots`. */
function crossFileCalls(
  model: FileModel,
  roots: readonly string[],
  methods: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const unit = model.functions.get(key);
    if (!unit) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind !== ts.SyntaxKind.ThisKeyword &&
          methods.has(callee.name.text)
        ) {
          found.push(
            `${model.path} ${key}:${lineOf(model.source, node)} calls ${callee.name.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.node);
    const next = calleesOf(model, unit).filter((callee) => !seen.has(callee));
    next.forEach((callee) => seen.add(callee));
    queue.push(...next);
  }
  return found;
}

/** Rule 2: a re-derivation helper writes only `expiresAt`, from `lastUsedAt`, and never reads the clock. */
function rederivationProblems(model: FileModel, helper: string): string[] {
  const unit = model.functions.get(helper);
  if (!unit) {
    return [`${helper} is missing`];
  }
  const problems: string[] = [];
  const writes = writesIn(model.source, unit.node);
  if (writes.length === 0 || writes.some((write) => write.clock !== "expiresAt")) {
    problems.push(`${helper} must write exactly the idle deadline (expiresAt)`);
  }
  let readsLastUsedAt = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "lastUsedAt") {
      readsLastUsedAt = true;
    }
    // `sessionNow` is the session clock (#11080), a clock read like `now`.
    const readsClock =
      (ts.isPropertyAccessExpression(node) &&
        (node.name.text === "now" || node.name.text === "sessionNow")) ||
      (ts.isIdentifier(node) && (node.text === "Date" || node.text === "now"));
    if (readsClock) {
      problems.push(`${helper} reads the current time at line ${lineOf(model.source, node)}`);
    }
    // `Math.max(...)` is fine; a bare call could hide a clock read in another function.
    if (ts.isCallExpression(node) && !ts.isPropertyAccessExpression(unwrap(node.expression))) {
      problems.push(`${helper} may not call other functions (line ${lineOf(model.source, node)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.node);
  if (!readsLastUsedAt) {
    problems.push(`${helper} must anchor the deadline on lastUsedAt`);
  }
  return problems;
}

function readNameOf(node: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)
      ? node.text
      : undefined;
}

/** `timer.now` / `this.timer.now`: the raw wall clock a wall step moves (#11105). */
function wallTimerReadOf(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "now") {
    return undefined;
  }
  const owner = node.expression;
  const ownerName = ts.isPropertyAccessExpression(owner)
    ? owner.name.text
    : ts.isIdentifier(owner)
      ? owner.text
      : undefined;
  return ownerName === "timer" ? "timer.now" : undefined;
}

/**
 * Rule 5: names from `forbidden` a judgement reads, directly or through same-file callees, as
 * `<function>:<line> reads <name>`. A read is a property access (`session.lastHeartbeat`) or an
 * identifier (`effectiveLastHeartbeat(...)`); type positions do not count.
 */
function forbiddenReads(
  model: FileModel,
  root: string,
  forbidden: ReadonlySet<string>,
  nameOf: (node: ts.Node) => string | undefined = readNameOf,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const unit = model.functions.get(key);
    if (!unit) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) {
        return;
      }
      const name = nameOf(node);
      if (name !== undefined && forbidden.has(name)) {
        found.push(`${model.path} ${key}:${lineOf(model.source, node)} reads ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit.node, visit);
    const next = calleesOf(model, unit).filter((callee) => !seen.has(callee));
    next.forEach((callee) => seen.add(callee));
    queue.push(...next);
  }
  return found;
}

/** The innermost named function enclosing `node`, or `<module>`. */
/** The device-tool admission sites, and the read-classification names their guard must negate. */
const ADMISSION_SITES: Readonly<Record<string, readonly string[]>> = {
  "src/server/toolRegistry.ts": ["readOnly", "readSession"],
};

/** Whether `condition` contains `!name` for one of `names`, possibly among `&&` operands. */
function negatesOneOf(condition: ts.Expression, names: readonly string[]): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(unwrap(node.operand)) &&
      names.includes((unwrap(node.operand) as ts.Identifier).text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return found;
}

/** Rule 6: `markSessionAdmitted` calls not guarded by a negated read classification. */
function unguardedAdmissions(model: FileModel, readNames: readonly string[]): string[] {
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "markSessionAdmitted"
    ) {
      let guarded = false;
      for (let child: ts.Node = node, parent = node.parent; parent;) {
        if (
          ts.isIfStatement(parent) &&
          parent.thenStatement === child &&
          negatesOneOf(parent.expression, readNames)
        ) {
          guarded = true;
          break;
        }
        if (ts.isFunctionLike(parent)) {
          break;
        }
        child = parent;
        parent = parent.parent;
      }
      if (!guarded) {
        problems.push(`${model.path}:${lineOf(model.source, node)} credits a read`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(model.source);
  return problems;
}

function enclosingKey(model: FileModel, node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const key = model.keyByNode.get(current);
    if (key) {
      return key;
    }
  }
  return "<module>";
}

/** Rule 3 input: activity-clock write counts and lines per `<file> <function>`. */
function inventoryOf(model: FileModel): Map<string, number[]> {
  const sites = new Map<string, number[]>();
  const visit = (node: ts.Node): void => {
    const clocks = clocksWrittenBy(node, model.source);
    if (clocks.length > 0) {
      const key = `${model.path} ${enclosingKey(model, node)}`;
      const line = lineOf(model.source, node);
      sites.set(key, [...(sites.get(key) ?? []), ...clocks.map(() => line)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(model.source);
  return sites;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function repoPath(full: string): string {
  return relative(ROOT, full).split(sep).join("/");
}

describe("liveness paths never write activity clocks (#10656, #10668)", () => {
  const models = new Map<string, FileModel>();
  const inventory = new Map<string, number[]>();
  // Parsing the scanned daemon/server/db files can take seconds on a loaded runner.
  const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;

  beforeAll(() => {
    // Matching raw bytes first skips decoding and parsing every file that names no clock.
    const clockBytes = [...ACTIVITY_CLOCKS].map((clock) => Buffer.from(clock));
    for (const full of INVENTORY_DIRS.flatMap((dir) => walk(join(ROOT, dir)))) {
      const bytes = readFileSync(full);
      if (!clockBytes.some((clock) => bytes.includes(clock))) {
        continue;
      }
      const model = parse(repoPath(full), bytes.toString("utf8"));
      models.set(model.path, model);
      for (const [key, lines] of inventoryOf(model)) {
        inventory.set(key, lines);
      }
    }
    for (const path of [
      ...Object.keys(NON_ACTIVITY_PATHS),
      ...Object.keys(DEADLINE_REDERIVATION_HELPERS),
      ...Object.keys(EXPIRY_JUDGEMENTS),
      ...Object.keys(LEASE_JUDGEMENTS),
      ...Object.keys(SESSION_CLOCK_JUDGEMENTS),
    ]) {
      if (!models.has(path)) {
        models.set(path, parse(path, readFileSync(join(ROOT, path), "utf8")));
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("every liveness-only entry point and re-derivation helper still exists", () => {
    const missing = [
      ...Object.entries(NON_ACTIVITY_PATHS),
      ...Object.entries(DEADLINE_REDERIVATION_HELPERS),
      ...Object.entries(EXPIRY_JUDGEMENTS),
      ...Object.entries(LEASE_JUDGEMENTS),
    ].flatMap(([path, keys]) =>
      keys.filter((key) => !models.get(path)?.functions.has(key)).map((key) => `${path} ${key}`),
    );
    // A rename must move the entry here too, or the guard silently stops covering it.
    expect(missing).toEqual([]);
  });

  test("no liveness-only or cache-only path writes lastUsedAt, expiresAt or boundSessionUuidAt", () => {
    const found = new Map<string, Violation[]>();
    for (const [path, roots] of Object.entries(NON_ACTIVITY_PATHS)) {
      const sanctioned = new Set(DEADLINE_REDERIVATION_HELPERS[path] ?? []);
      for (const violation of livenessViolations(models.get(path)!, roots, sanctioned)) {
        const key = `${path} ${violation.via}`;
        const list = found.get(key) ?? [];
        // One write reached from several roots is still one write.
        if (!list.some((existing) => existing.line === violation.line)) {
          found.set(key, [...list, violation]);
        }
      }
    }
    const unexpected = [...found.entries()]
      .filter(([key, list]) => KNOWN_LIVENESS_WRITES[key]?.writes !== list.length)
      .flatMap(([key, list]) =>
        list.map(
          (violation) =>
            `${key}:${violation.line} writes ${violation.clock} (reached from ${violation.root})`,
        ),
      );
    expect(unexpected).toEqual([]);
    // A fixed baseline entry must be removed so the write cannot quietly return.
    expect(Object.keys(KNOWN_LIVENESS_WRITES).filter((key) => !found.has(key))).toEqual([]);
  });

  test("liveness paths in other files never call a SessionManager method that records tool activity", () => {
    const sessionManagerPath = "src/daemon/sessionManager.ts";
    const writers = activityWritingMethods(
      models.get(sessionManagerPath)!,
      "SessionManager",
      new Set(DEADLINE_REDERIVATION_HELPERS[sessionManagerPath] ?? []),
    );
    // Sanity: the tool-usage paths are detected, so an empty result cannot pass vacuously.
    expect([...writers]).toEqual(
      expect.arrayContaining(["getOrCreateSession", "recordToolCallEnded", "createSession"]),
    );
    // Cache reads and writes are not tool usage (#10703): reachable from any caller.
    expect([...writers]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/SessionCache$|^setLastHierarchy$/)]),
    );
    // The baselined stall forgiveness (#10662) is the daemon's own path, not a liveness call.
    writers.delete("forgiveDaemonStall");
    const calls = Object.entries(LIVENESS_ONLY)
      .filter(([path]) => path !== sessionManagerPath)
      .flatMap(([path, roots]) => crossFileCalls(models.get(path)!, roots, writers));
    expect(calls).toEqual([]);
  });

  test("deadline re-derivation helpers anchor on the last tool call and never read the clock", () => {
    const problems = Object.entries(DEADLINE_REDERIVATION_HELPERS).flatMap(([path, helpers]) =>
      helpers.flatMap((helper) => rederivationProblems(models.get(path)!, helper)),
    );
    expect(problems).toEqual([]);
  });

  test("every activity-clock write site is inventoried", () => {
    const describe = (counts: Iterable<readonly [string, number]>): string[] =>
      [...counts].map(([key, writes]) => `${key} = ${writes}`).sort();
    const actual = describe([...inventory].map(([key, lines]) => [key, lines.length] as const));
    const expected = describe(
      Object.entries(WRITE_INVENTORY).map(([key, entry]) => [key, entry.writes] as const),
    );
    // A new write site: classify it in WRITE_INVENTORY as tool usage (or policy/rollback), or
    // route it away from the activity clocks. The lines below locate each site.
    const located = [...inventory]
      .map(([key, lines]) => `${key} @ ${lines.join(",")}`)
      .sort()
      .join("\n");
    expect({ actual, located }).toEqual({ actual: expected, located });
  });

  test("idle-expiry judgements read only activity clocks, never a liveness clock (#10703)", () => {
    const reads = Object.entries(EXPIRY_JUDGEMENTS).flatMap(([path, roots]) =>
      roots.flatMap((root) => forbiddenReads(models.get(path)!, root, LIVENESS_READS)),
    );
    expect(reads).toEqual([]);
  });

  test("lease judgements read only liveness clocks, never an activity clock (#10703)", () => {
    const reads = Object.entries(LEASE_JUDGEMENTS).flatMap(([path, roots]) =>
      roots.flatMap((root) => forbiddenReads(models.get(path)!, root, ACTIVITY_CLOCKS)),
    );
    expect(reads).toEqual([]);
  });

  test("session-stamp judgements read the session clock, never the raw wall clock (#11105)", () => {
    const reads = Object.entries(SESSION_CLOCK_JUDGEMENTS).flatMap(([path, roots]) =>
      roots.flatMap((root) =>
        forbiddenReads(models.get(path)!, root, new Set(["timer.now"]), wallTimerReadOf),
      ),
    );
    expect(reads).toEqual([]);
  });

  test("the session-clock guard sees a raw wall-clock read", () => {
    const model = parse(
      "fixture.ts",
      "class A { timer: { now(): number }; judge(s: { expiresAt: number }) { return this.timer.now() > s.expiresAt; } }",
    );
    expect(forbiddenReads(model, "A.judge", new Set(["timer.now"]), wallTimerReadOf)).toHaveLength(
      1,
    );
  });

  test("the CLI idle release is judged on the tool-activity clock, never a heartbeat clock", () => {
    // A `--daemon heartbeat` loop proves the CLI owner is alive, not that it uses the device, so
    // it must never hold a CLI session past the idle window (owner decision 2026-10-08).
    const path = "src/daemon/SessionHeartbeatMonitor.ts";
    const model = parse(path, readFileSync(join(ROOT, path), "utf8"));
    const heartbeatClocks = LIVENESS_READS;
    const judgements: { line: number; readsActivity: boolean; heartbeatReads: string[] }[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isConditionalExpression(node) &&
        ts.isStringLiteral(unwrap(node.whenTrue)) &&
        (unwrap(node.whenTrue) as ts.StringLiteral).text === "cli-idle-timeout"
      ) {
        let readsActivity = false;
        const heartbeatReads: string[] = [];
        const scan = (inner: ts.Node): void => {
          if (ts.isPropertyAccessExpression(inner) && inner.name.text === "lastUsedAt") {
            readsActivity = true;
          }
          // The stall-forgiven tool-activity clock (#10835) reads only activity clocks.
          if (ts.isIdentifier(inner) && inner.text === "effectiveLastToolActivity") {
            readsActivity = true;
          }
          if (
            (ts.isIdentifier(inner) || ts.isPrivateIdentifier(inner)) &&
            heartbeatClocks.has(inner.text)
          ) {
            heartbeatReads.push(inner.text);
          }
          ts.forEachChild(inner, scan);
        };
        scan(node.condition);
        judgements.push({ line: lineOf(model.source, node), readsActivity, heartbeatReads });
      }
      ts.forEachChild(node, visit);
    };
    visit(model.source);
    // Sanity: the judgement exists, so the check cannot pass vacuously.
    expect(judgements.length).toBeGreaterThan(0);
    expect(
      judgements.filter((judgement) => !judgement.readsActivity || judgement.heartbeatReads.length),
    ).toEqual([]);
  });

  test("the persisted activity mirror copies the session's clocks instead of computing new ones", () => {
    const model = models.get("src/daemon/sessionManager.ts")!;
    const problems: string[] = [];
    const visit = (node: ts.Node): void => {
      const name = ts.isPropertyAssignment(node) ? propertyNameText(node.name) : undefined;
      const mirrored =
        name === "lastUsedAtMs" ? "lastUsedAt" : name === "expiresAtMs" ? "expiresAt" : undefined;
      if (mirrored && ts.isPropertyAssignment(node)) {
        const value = unwrap(node.initializer);
        if (!ts.isPropertyAccessExpression(value) || value.name.text !== mirrored) {
          problems.push(
            `${name} at line ${lineOf(model.source, node)} is not copied from .${mirrored}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(model.source);
    expect(problems).toEqual([]);
  });

  test("a device-tool admission is credited only for a control call, never a read (#10964)", () => {
    for (const [path, readNames] of Object.entries(ADMISSION_SITES)) {
      const model = parse(path, readFileSync(join(ROOT, path), "utf8"));
      expect(model.source.text).toContain("markSessionAdmitted");
      expect(unguardedAdmissions(model, readNames)).toEqual([]);
    }
  });

  describe("rule coverage on a seeded source", () => {
    const SEEDED = `
      function widen(session) { session.expiresAt = Math.max(session.expiresAt, session.lastUsedAt + 1); }
      function bad(session, timer) { session.expiresAt = timer.now() + 1; }
      class Manager {
        heartbeat(session) {
          session.lastHeartbeat = 1;
          this.touch(session);
        }
        touch(session) { this.deeper(session); }
        deeper(session) { session.lastUsedAt = 2; }
        rollback(session) {
          const previous = { lastUsedAt: session.lastUsedAt, lastHeartbeat: 0 };
          Object.assign(session, previous);
        }
        policy(session) { widen(session); }
        ack() { this.boundSessionUuidAt = 3; }
        retire() { this.boundSessionUuidAt = undefined; }
      }
    `;
    const seeded = parse("seeded.ts", SEEDED);
    const summary = (violations: Violation[]): string[] =>
      violations.map((violation) => `${violation.via}:${violation.clock}`);

    test("reports a write reached through same-file helpers", () => {
      expect(summary(livenessViolations(seeded, ["Manager.heartbeat"], new Set()))).toEqual([
        "Manager.deeper:lastUsedAt",
      ]);
    });

    test("reports an Object.assign that restores an activity clock and a replay-lease write", () => {
      expect(
        summary(livenessViolations(seeded, ["Manager.rollback", "Manager.ack"], new Set())),
      ).toEqual(["Manager.rollback:lastUsedAt", "Manager.ack:boundSessionUuidAt"]);
    });

    test("reports a liveness path calling a tool-activity method on another object", () => {
      const handler = parse(
        "handler.ts",
        "function onBeat(manager) { manager.recordHeartbeat(); manager.getSessionCache(); }",
      );
      expect(crossFileCalls(handler, ["onBeat"], new Set(["getSessionCache"]))).toEqual([
        "handler.ts onBeat:1 calls getSessionCache",
      ]);
    });

    test("reports a keyed record stored with an activity clock", () => {
      const held = parse(
        "held.ts",
        [
          "class Proxy {",
          "  ack(id) { this.held.set(id, { claimSent: true, lastUsedAt: 4 }); }",
          "  claim(id) { const entry = { claimSent: true }; this.held.set(id, entry); }",
          "}",
        ].join("\n"),
      );
      expect(summary(livenessViolations(held, ["Proxy.ack", "Proxy.claim"], new Set()))).toEqual([
        "Proxy.ack:lastUsedAt",
      ]);
    });

    test("does not count retiring a clock as a write", () => {
      expect(livenessViolations(seeded, ["Manager.retire"], new Set())).toEqual([]);
    });

    test("allows a sanctioned re-derivation helper and rejects one that reads the clock", () => {
      expect(livenessViolations(seeded, ["Manager.policy"], new Set(["widen"]))).toEqual([]);
      expect(summary(livenessViolations(seeded, ["Manager.policy"], new Set()))).toEqual([
        "widen:expiresAt",
      ]);
      expect(rederivationProblems(seeded, "widen")).toEqual([]);
      expect(rederivationProblems(seeded, "bad")).toEqual(
        expect.arrayContaining([expect.stringContaining("reads the current time")]),
      );
    });

    test("reports a cache-only path that stamps an activity clock (#10703)", () => {
      const cache = parse(
        "cache.ts",
        [
          "class Manager {",
          "  updateCache(session, updates) {",
          "    session.cacheData = { ...session.cacheData, ...updates };",
          "    session.lastUsedAt = this.timer.now();",
          "  }",
          "}",
        ].join("\n"),
      );
      expect(summary(livenessViolations(cache, ["Manager.updateCache"], new Set()))).toEqual([
        "Manager.updateCache:lastUsedAt",
      ]);
    });

    test("counts an object literal that computes a clock, not one that copies it (#10703)", () => {
      const literal = parse(
        "literal.ts",
        [
          "class Manager {",
          "  create(id, now) { const session = { id, lastUsedAt: now }; this.sessions.set(id, session); }",
          "  info(session) { return { lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt }; }",
          "  lease(expiresAt) { return { expiresAt }; }",
          "}",
        ].join("\n"),
      );
      expect(Object.fromEntries(inventoryOf(literal))).toEqual({
        "literal.ts Manager.create": [2],
        "literal.ts Manager.lease": [4],
      });
      expect(summary(livenessViolations(literal, ["Manager.create"], new Set()))).toEqual([
        "Manager.create:lastUsedAt",
      ]);
    });

    test("reports an expiry judgement that reads a liveness clock, and a lease that reads activity (#10700, #10703)", () => {
      const judgements = parse(
        "judgements.ts",
        [
          "class Monitor {",
          "  isExpired(session, now) { return now > session.lastHeartbeat + this.window(session); }",
          "  window(session) { return effectiveLastHeartbeat(session) ? 1 : 2; }",
          "  isIdle(session, now) { return now > session.expiresAt; }",
          "  leaseLapsed(session, now) { return now - (session.lastHeartbeat ?? session.lastUsedAt) > 1; }",
          "}",
        ].join("\n"),
      );
      expect(forbiddenReads(judgements, "Monitor.isExpired", LIVENESS_READS)).toEqual([
        "judgements.ts Monitor.isExpired:2 reads lastHeartbeat",
        "judgements.ts Monitor.window:3 reads effectiveLastHeartbeat",
      ]);
      expect(forbiddenReads(judgements, "Monitor.isIdle", LIVENESS_READS)).toEqual([]);
      expect(forbiddenReads(judgements, "Monitor.leaseLapsed", ACTIVITY_CLOCKS)).toEqual([
        "judgements.ts Monitor.leaseLapsed:5 reads lastUsedAt",
      ]);
    });

    test("reports an admission credited without negating the read classification (#10964)", () => {
      const admissions = parse(
        "admissions.ts",
        [
          "async function resolve(readOnly, execution, tracker) {",
          "  if (execution && !readOnly) { tracker.markSessionAdmitted(execution.id); }",
          "  if (execution) { tracker.markSessionAdmitted(execution.id); }",
          "  if (!readOnly) {} else { tracker.markSessionAdmitted(execution.id); }",
          "}",
        ].join("\n"),
      );
      expect(unguardedAdmissions(admissions, ["readOnly"])).toEqual([
        "admissions.ts:3 credits a read",
        "admissions.ts:4 credits a read",
      ]);
    });

    test("inventories every write site by enclosing function", () => {
      expect(Object.fromEntries(inventoryOf(seeded))).toEqual({
        "seeded.ts widen": [2],
        "seeded.ts bad": [3],
        "seeded.ts Manager.deeper": [10],
        "seeded.ts Manager.rollback": [13],
        "seeded.ts Manager.ack": [16],
      });
    });
  });
});
