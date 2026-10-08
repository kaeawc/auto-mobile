import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
 * 1. No liveness-only function writes an activity clock, directly or through a
 *    same-file helper it calls (`this.m()` or a module function), transitively.
 *    A write is an assignment (`=`, compound, `++`/`--`), an `Object.assign`
 *    whose source object literal (inline or a local `const`) carries the clock,
 *    or a `map.set(key, value)` whose value object literal carries it.
 *    Retiring a clock (`= undefined`, `delete`) is not a write: it can only end
 *    a lease, never extend one.
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
 */

const ROOT = join(import.meta.dir, "..", "..");

/** The daemon session's idle clocks. */
const DAEMON_ACTIVITY_CLOCKS = ["lastUsedAt", "expiresAt"] as const;
/**
 * The stdio proxy's replay-lease clock. A held session's `lastUsedAt` (#10677) is covered by the
 * daemon clock name above: only a tool call naming the session may stamp it.
 */
const PROXY_ACTIVITY_CLOCKS = ["boundSessionUuidAt"] as const;
const ACTIVITY_CLOCKS: ReadonlySet<string> = new Set([
  ...DAEMON_ACTIVITY_CLOCKS,
  ...PROXY_ACTIVITY_CLOCKS,
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
    writes: 1,
    reason:
      "#10662: stall forgiveness compensates for time the daemon itself lost. It shifts " +
      "expiresAt by at most the lost interval (never to a full window from resume), so it grants " +
      "no hold time a non-stalled session would not have had.",
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
  "src/daemon/sessionManager.ts SessionManager.updateSessionCache": {
    writes: 1,
    reason: "Tool usage: a tool storing observation/session cache data stamps lastUsedAt.",
  },
  "src/daemon/sessionManager.ts SessionManager.getSessionCache": {
    writes: 1,
    reason: "Tool usage: a tool reading the session cache stamps lastUsedAt.",
  },
  "src/daemon/sessionManager.ts rollbackSessionActivityIfCurrent": {
    writes: 2,
    reason: "Rollback: restores the pre-write activity clocks after a failed cache activity write.",
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
    writes: 1,
    reason:
      "Stall compensation (shift by the lost interval), listed in KNOWN_LIVENESS_WRITES (#10662).",
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
  "src/daemon/daemonMcpProxy.ts DaemonMcpProxy.holdPreviousBinding": {
    writes: 1,
    reason:
      "Tool usage: a newer binding demotes the previous one to a held session whose lastUsedAt " +
      "carries that binding's replay lease (boundSessionUuidAt, itself only stamped by tool " +
      "calls), so held-session idle eviction keys off tool use, never heartbeat acks (#10677).",
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
  "src/daemon/devicePool.ts DevicePool.bindOrReuseDeviceSession": {
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

function literalClockKeys(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((property) => {
    const name =
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? propertyNameText(property.name)
        : undefined;
    return name !== undefined && ACTIVITY_CLOCKS.has(name) ? [name] : [];
  });
}

/** Activity-clock keys carried by an object literal, or by a `const x = { … }` in `scope` it names. */
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
    const readsClock =
      (ts.isPropertyAccessExpression(node) && node.name.text === "now") ||
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

/** The innermost named function enclosing `node`, or `<module>`. */
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
      ...Object.keys(LIVENESS_ONLY),
      ...Object.keys(DEADLINE_REDERIVATION_HELPERS),
    ]) {
      if (!models.has(path)) {
        models.set(path, parse(path, readFileSync(join(ROOT, path), "utf8")));
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("every liveness-only entry point and re-derivation helper still exists", () => {
    const missing = [
      ...Object.entries(LIVENESS_ONLY),
      ...Object.entries(DEADLINE_REDERIVATION_HELPERS),
    ].flatMap(([path, keys]) =>
      keys.filter((key) => !models.get(path)?.functions.has(key)).map((key) => `${path} ${key}`),
    );
    // A rename must move the entry here too, or the guard silently stops covering it.
    expect(missing).toEqual([]);
  });

  test("no liveness-only path writes lastUsedAt, expiresAt or boundSessionUuidAt", () => {
    const found = new Map<string, Violation[]>();
    for (const [path, roots] of Object.entries(LIVENESS_ONLY)) {
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
      expect.arrayContaining(["getOrCreateSession", "getSessionCache", "updateSessionCache"]),
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
