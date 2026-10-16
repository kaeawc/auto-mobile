import {
  parseSync,
  Visitor,
  type Expression,
  type ObjectExpression,
  type Property,
} from "oxc-parser";

export interface ReleaseReasonSerialisation {
  file: string;
  line: number;
  owner: string;
  key: "reason" | "releaseReason" | "idleReleaseField";
  guarded: boolean;
}

export const RELEASE_REASON_WIRE_BUILDERS: readonly string[] = [
  "src/server/proxyServer.ts#noActiveDeviceSessionPayload",
  "src/server/proxyServer.ts#brokerSessionEndedPayload",
  "src/server/proxyServer.ts#managedSlotsResourceView",
  "src/server/planExecutionOrchestrator.ts#planBaseEndFields",
  "src/server/deviceSessionResult.ts#managedExecutionEndedPayload",
  "src/server/deviceSessionResult.ts#sessionOwnershipLostPayload",
  "src/server/deviceSessionResult.ts#recoveryIdentityLossDetails",
  "src/daemon/types.ts#releasedSessionNotFoundFields",
  "src/daemon/types.ts#sanitizeBoundSessionLoss",
  "src/daemon/socketServer.ts#sessionAdmissionRefusalFields",
  "src/daemon/socketServer.ts#UnixSocketServer.broadcastSessionReleased",
  "src/daemon/socketServer.ts#UnixSocketServer.admitReleasedBoundSession",
  "src/daemon/sessionReleasedDuringCall.ts#SessionReleasedDuringCallError.constructor",
  "src/daemon/daemonRequestHandlers.ts#terminalSessionRegistrationRefusal",
];
export const EXEMPT_RELEASE_REASON_HOLDERS: ReadonlyArray<readonly [string, string]> = [
  [
    "src/server/proxyServer.ts#managedEndedPayload",
    "Passes sessionUuid and reason into managedExecutionEndedPayload, which builds the wire envelope.",
  ],
  [
    "src/server/proxyServer.ts#boundSessionOwnershipLostPayload",
    "Passes the bound-session error reason into sessionOwnershipLostPayload, which builds the wire envelope.",
  ],
  [
    "src/server/deviceSessionResult.ts#recoveryIdentityLoss",
    "Parses a typed upstream recovery-identity error into in-memory evidence consumed by the guarded loss builders.",
  ],
  [
    "src/server/deviceSessionResult.ts#recoveryIdentityLossPayload",
    "Passes recovery loss evidence into sessionOwnershipLostPayload and recoveryIdentityLossDetails, which build the wire fields.",
  ],
  [
    "src/daemon/socketServer.ts#UnixSocketServer.rejectOnHandshakeMismatch",
    "Serializes a client version/build handshake mismatch reason, not a session release reason.",
  ],
  [
    "src/server/index.ts#executeToolCallBody",
    "Passes the release reason into sessionOwnershipLostPayload, which builds the wire envelope.",
  ],
  [
    "src/server/deviceSessionResult.ts#sessionReleasedDuringCallPayload",
    "Passes the typed call-release reason into sessionOwnershipLostPayload, which builds the wire envelope.",
  ],
  [
    "src/daemon/types.ts#sanitizeSessionReleaseSnapshot",
    "Parses the nested incoming release snapshot; its idle flag belongs to the containing refusal.",
  ],
  [
    "src/daemon/daemonRequestHandlers.ts#persistedTerminalRelease",
    "Returns an in-memory persisted-release lookup for registration admission, not a wire answer.",
  ],
  [
    "src/daemon/proxy/notFoundDecision.ts#decideNotFoundAnswer",
    "Returns an in-memory heartbeat not-found decision used to update proxy binding state.",
  ],
  [
    "src/daemon/daemonMcpProxy.ts#DaemonMcpProxy.classifyRecoveryAttemptError",
    "Classifies a typed upstream refusal for the in-memory liveness recovery state machine.",
  ],
  [
    "src/daemon/daemonMcpProxy.ts#DaemonMcpProxy.noteNotFoundAnswer",
    "Records an in-memory not-found outcome and recovery window for the proxy binding.",
  ],
  [
    "src/daemon/cli/runDaemonCommand.ts#daemonQueryFailureJson",
    "Relays typed error fields built by the daemon client with releasedSessionNotFoundFields, including idle.",
  ],
  [
    "src/daemon/cli/sessionBrokerCommands.ts#redactError",
    "Redacts the owner token from a typed upstream error while preserving its existing releaseReason and idle fields for the CLI serializer.",
  ],
  [
    "src/daemon/sessionManager.ts",
    "In-memory session state and persistence rows; wire builders serialize its release snapshots.",
  ],
];

function unwrap(expression: Expression): Expression {
  switch (expression.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return unwrap(expression.expression);
    default:
      return expression;
  }
}

function keyName(property: Property): string | undefined {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : undefined;
}

function idleCall(expression: Expression): boolean {
  expression = unwrap(expression);
  return (
    expression.type === "CallExpression" &&
    expression.callee.type === "Identifier" &&
    expression.callee.name === "idleReleaseField"
  );
}

function zodValue(expression: Expression): boolean {
  expression = unwrap(expression);
  if (expression.type === "Identifier") {
    return expression.name === "z";
  }
  if (expression.type === "MemberExpression") {
    return zodValue(expression.object);
  }
  return expression.type === "CallExpression" && zodValue(expression.callee);
}

function releaseValue(expression: Expression, imports: ReadonlySet<string>): boolean {
  expression = unwrap(expression);
  const names = ["releaseReason", "release_reason", "terminalReleaseReason"];
  switch (expression.type) {
    case "Identifier":
      return names.includes(expression.name) || imports.has(expression.name);
    case "MemberExpression":
      return (
        !expression.computed &&
        expression.property.type === "Identifier" &&
        names.includes(expression.property.name)
      );
    case "CallExpression":
      return (
        expression.callee.type === "Identifier" &&
        expression.callee.name === "releaseReasonFromError"
      );
    case "LogicalExpression":
      return (
        (expression.operator === "??" || expression.operator === "||") &&
        (releaseValue(expression.left, imports) || releaseValue(expression.right, imports))
      );
    case "ConditionalExpression":
      return (
        releaseValue(expression.consequent, imports) || releaseValue(expression.alternate, imports)
      );
    default:
      return false;
  }
}

/** Parse each file once; named scope ranges preserve the owner through anonymous callbacks. */
export function scanReleaseReasonSerialisations(
  file: string,
  source: string,
  options: { hostsWireBuilder: boolean } = { hostsWireBuilder: false },
): ReleaseReasonSerialisation[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0].message}`);
  }
  const imports = new Set<string>();
  const classes: { start: number; end: number; name: string }[] = [];
  const scopes: { start: number; end: number; name: string; method?: boolean }[] = [];
  const objects: ObjectExpression[] = [];
  const calls: number[] = [];
  new Visitor({
    ImportDeclaration(node) {
      if (
        typeof node.source.value === "string" &&
        ["releaseReasons", "releaseReasons.ts"].includes(node.source.value.split("/").at(-1) ?? "")
      ) {
        for (const specifier of node.specifiers) {
          imports.add(specifier.local.name);
        }
      }
    },
    ClassDeclaration(node) {
      if (node.id) {
        classes.push({ start: node.start, end: node.end, name: node.id.name });
      }
    },
    ClassExpression(node) {
      if (node.id) {
        classes.push({ start: node.start, end: node.end, name: node.id.name });
      }
    },
    FunctionDeclaration(node) {
      if (node.id) {
        scopes.push({ start: node.start, end: node.end, name: node.id.name });
      }
    },
    FunctionExpression(node) {
      if (node.id) {
        scopes.push({ start: node.start, end: node.end, name: node.id.name });
      }
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" &&
        node.init &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init.type)
      ) {
        scopes.push({ start: node.init.start, end: node.init.end, name: node.id.name });
      }
    },
    MethodDefinition(node) {
      if (!node.computed && node.key.type === "Identifier") {
        scopes.push({ start: node.start, end: node.end, name: node.key.name, method: true });
      }
    },
    Property(node) {
      const name = keyName(node);
      if (node.method && name) {
        scopes.push({ start: node.start, end: node.end, name });
      }
    },
    ObjectExpression(node) {
      objects.push(node);
    },
    CallExpression(node) {
      if (idleCall(node)) {
        calls.push(node.start);
      }
    },
  }).visit(program);

  const ownerAt = (offset: number): string => {
    const scope = scopes
      .filter((entry) => entry.start <= offset && offset < entry.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!scope) {
      return "<module>";
    }
    const enclosingClass =
      scope.method &&
      classes
        .filter((entry) => entry.start <= scope.start && scope.end <= entry.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    return enclosingClass ? `${enclosingClass.name}.${scope.name}` : scope.name;
  };
  const lineStarts = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source.charCodeAt(offset) === 10) {
      lineStarts.push(offset + 1);
    }
  }
  const finding = (
    offset: number,
    key: ReleaseReasonSerialisation["key"],
    guarded: boolean,
  ): ReleaseReasonSerialisation => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return { file, line: low + 1, owner: ownerAt(offset), key, guarded };
  };
  const reasons = new Map<number, ReleaseReasonSerialisation>();
  for (const object of objects) {
    const hasIdle = object.properties.some((element) =>
      element.type === "Property" ? keyName(element) === "idle" : idleCall(element.argument),
    );
    for (const [index, element] of object.properties.entries()) {
      const next = object.properties[index + 1];
      const adjacentIdle = next?.type === "SpreadElement" && idleCall(next.argument);
      const branchObjects: ObjectExpression[] = [];
      if (element.type === "SpreadElement") {
        const argument = unwrap(element.argument);
        if (argument.type === "ConditionalExpression") {
          for (const branch of [argument.consequent, argument.alternate]) {
            const unwrapped = unwrap(branch);
            if (unwrapped.type === "ObjectExpression") {
              branchObjects.push(unwrapped);
            }
          }
        }
      }
      const properties =
        element.type === "Property"
          ? [element]
          : branchObjects.flatMap((branch) =>
              branch.properties.filter(
                (property): property is Property => property.type === "Property",
              ),
            );
      for (const property of properties) {
        const key = keyName(property);
        if ((key !== "reason" && key !== "releaseReason") || zodValue(property.value)) {
          continue;
        }
        const value = unwrap(property.value);
        const literal =
          branchObjects.find((branch) => branch.properties.includes(property)) ?? object;
        const structuralReason =
          options.hostsWireBuilder &&
          !(value.type === "Literal" && typeof value.value === "string") &&
          value.type !== "TemplateLiteral" &&
          literal.properties.some(
            (sibling) =>
              sibling.type === "Property" &&
              ["code", "sessionUuid", "sessionId", "nextAction"].includes(keyName(sibling) ?? ""),
          );
        if (
          key !== "releaseReason" &&
          !hasIdle &&
          !releaseValue(property.value, imports) &&
          !structuralReason
        ) {
          continue;
        }
        const guarded = adjacentIdle || reasons.get(property.start)?.guarded === true;
        reasons.set(property.start, finding(property.start, key, guarded));
      }
    }
  }
  return [
    ...reasons.values(),
    ...calls.map((offset) => finding(offset, "idleReleaseField", true)),
  ].sort((a, b) => a.line - b.line);
}
