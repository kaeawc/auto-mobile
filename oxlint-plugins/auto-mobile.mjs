// AutoMobile custom lint rules, ported from eslint.config.mjs to oxlint's JS
// plugin API (https://oxc.rs/docs/guide/usage/linter/plugins). The authoring API
// mirrors ESLint: each rule is `{ meta, create(context) }`, the visitor keys are
// ESTree node types, and `context.report({ node, messageId })` emits a
// diagnostic keyed by `meta.messages`. The rule LOGIC below is copied verbatim
// from the ESLint versions so behavior is identical; only the plugin container
// (`meta.name` + `rules`) and the no-bare-expect selector (rewritten from an
// esquery string to a plain ExpressionStatement visitor for portability) differ.

function propertyName(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function memberChainIncludesLogger(node) {
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === "logger" || node.name === "log";
  }
  if (node.type === "ThisExpression") {
    return false;
  }
  if (node.type === "MemberExpression") {
    return propertyName(node.property) === "logger" || memberChainIncludesLogger(node.object);
  }
  return false;
}

function isLoggerMethodCall(node, methodName) {
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") {
    return false;
  }
  return (
    propertyName(node.callee.property) === methodName &&
    memberChainIncludesLogger(node.callee.object)
  );
}

function hasLoggerMethodCall(node, methodName, seen = new WeakSet()) {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isLoggerMethodCall(node, methodName)) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => hasLoggerMethodCall(child, methodName, seen))) {
        return true;
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string" &&
      hasLoggerMethodCall(value, methodName, seen)
    ) {
      return true;
    }
  }
  return false;
}

function hasAnyLoggerCall(node) {
  return (
    hasLoggerMethodCall(node, "debug") ||
    hasLoggerMethodCall(node, "warn") ||
    hasLoggerMethodCall(node, "error")
  );
}

function isUndefinedReturn(argument) {
  return argument?.type === "Identifier" && argument.name === "undefined";
}

function isBooleanReturn(argument) {
  return argument?.type === "Literal" && typeof argument.value === "boolean";
}

function isStatusObjectReturn(argument) {
  return (
    argument?.type === "ObjectExpression" &&
    argument.properties.some(
      (property) =>
        property.type === "Property" &&
        (propertyName(property.key) === "status" ||
          (propertyName(property.key) === "success" &&
            isBooleanReturn(property.value) &&
            property.value.value === false)),
    )
  );
}

function isFallbackReturn(argument) {
  return (
    !argument ||
    (argument.type === "Literal" && argument.value === null) ||
    isUndefinedReturn(argument) ||
    isBooleanReturn(argument)
  );
}

function hasThrowStatement(node, seen = new WeakSet()) {
  if (!node || typeof node.type !== "string" || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node.type === "ThrowStatement") {
    return true;
  }
  // Do not descend into nested function bodies: a throw inside a callback
  // defined in the catch does not satisfy the catch's own error contract.
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => hasThrowStatement(child, seen))) {
        return true;
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string" &&
      hasThrowStatement(value, seen)
    ) {
      return true;
    }
  }
  return false;
}

function identifierIsReferenced(node, name, seen = new WeakSet()) {
  if (!node || typeof node.type !== "string" || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node.type === "Identifier" && node.name === name) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "parent" ||
      (node.type === "Property" && key === "key" && !node.computed) ||
      (node.type === "MemberExpression" && key === "property" && !node.computed)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => identifierIsReferenced(child, name, seen))) {
        return true;
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string" &&
      identifierIsReferenced(value, name, seen)
    ) {
      return true;
    }
  }
  return false;
}

// True if the catch body uses its caught error binding anywhere (forwarding it
// to a helper, rejector, etc.). A catch with no binding (`catch { }`) or an
// unused binding counts as NOT referencing it.
function referencesCaughtError(catchNode) {
  if (!catchNode.param || catchNode.param.type !== "Identifier") {
    return false;
  }
  return identifierIsReferenced(catchNode.body, catchNode.param.name);
}

const catchConventionRule = {
  meta: {
    type: "problem",
    messages: {
      fallbackReturn:
        "Catch blocks that return a fallback must log the caught error before returning.",
      statusReturn:
        "Catch blocks that return a typed failure/status object must log at warn, not debug.",
      tracelessCatch:
        "Catch block swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).",
      tracelessPromiseCatch:
        "Promise .catch() handler swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).",
    },
  },
  create(context) {
    function reportStatusReturnsWithoutWarn(statements, hasPriorWarn) {
      for (const statement of statements) {
        if (
          statement.type === "ExpressionStatement" &&
          isLoggerMethodCall(statement.expression, "warn")
        ) {
          hasPriorWarn = true;
        }
        if (
          statement.type === "ReturnStatement" &&
          isStatusObjectReturn(statement.argument) &&
          !hasPriorWarn
        ) {
          context.report({ node: statement, messageId: "statusReturn" });
        }
        if (statement.type === "IfStatement") {
          reportStatusReturnsWithoutWarn(
            statement.consequent.type === "BlockStatement"
              ? statement.consequent.body
              : [statement.consequent],
            hasPriorWarn,
          );
          if (statement.alternate) {
            reportStatusReturnsWithoutWarn(
              statement.alternate.type === "BlockStatement"
                ? statement.alternate.body
                : [statement.alternate],
              hasPriorWarn,
            );
          }
        }
      }
    }

    function hasStatusObjectReturn(statements) {
      return statements.some((statement) => {
        if (statement.type === "ReturnStatement" && isStatusObjectReturn(statement.argument)) {
          return true;
        }
        if (statement.type !== "IfStatement") {
          return false;
        }
        return (
          hasStatusObjectReturn(
            statement.consequent.type === "BlockStatement"
              ? statement.consequent.body
              : [statement.consequent],
          ) ||
          (statement.alternate !== null &&
            hasStatusObjectReturn(
              statement.alternate.type === "BlockStatement"
                ? statement.alternate.body
                : [statement.alternate],
            ))
        );
      });
    }

    return {
      CallExpression(node) {
        if (
          node.callee?.type !== "MemberExpression" ||
          propertyName(node.callee.property) !== "catch"
        ) {
          return;
        }
        const handler = node.arguments[0];
        if (
          !handler ||
          (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") ||
          handler.body.type !== "BlockStatement" ||
          handler.body.body.length !== 0 ||
          hasAnyLoggerCall(handler.body) ||
          hasThrowStatement(handler.body) ||
          (handler.params[0]?.type === "Identifier" &&
            identifierIsReferenced(handler.body, handler.params[0].name))
        ) {
          return;
        }
        context.report({ node, messageId: "tracelessPromiseCatch" });
      },
      CatchClause(node) {
        const statements = node.body.body;
        if (
          statements.length === 1 &&
          statements[0].type === "ReturnStatement" &&
          isFallbackReturn(statements[0].argument) &&
          !hasAnyLoggerCall(node.body)
        ) {
          // A single fallback return without logging keeps its specific
          // message — checked precedence-first so it is not reclassified.
          context.report({ node: statements[0], messageId: "fallbackReturn" });
        } else if (
          !hasStatusObjectReturn(statements) &&
          !hasAnyLoggerCall(node.body) &&
          !hasThrowStatement(node.body) &&
          !referencesCaughtError(node)
        ) {
          // Otherwise, a catch that swallows the error with no trace at all
          // — no log, no throw, and never even references the caught binding
          // — is the root cause of the #3594-class bugs. Catches that forward
          // the error (reject(e), handleError(e)) reference the binding and
          // are intentionally left alone.
          context.report({ node, messageId: "tracelessCatch" });
        }
        reportStatusReturnsWithoutWarn(statements, false);
      },
    };
  },
};

const noUnknownCastRule = {
  meta: {
    type: "problem",
    messages: {
      unknownCast:
        "Avoid `as unknown as T`: it silences the type checker and can mask a real shape mismatch (e.g. a dropped required field). Use a proper type, a type guard, or a narrow assertion. If a library genuinely forces it, add an oxlint-disable-next-line with a one-line justification.",
    },
  },
  create(context) {
    return {
      // Match the double assertion `X as unknown as T`: an outer `as T`
      // whose operand is itself `X as unknown`.
      TSAsExpression(node) {
        if (
          node.expression?.type === "TSAsExpression" &&
          node.expression.typeAnnotation?.type === "TSUnknownKeyword"
        ) {
          context.report({ node, messageId: "unknownCast" });
        }
      },
    };
  },
};

// Building a collection by mutating it inside a callback. These are the forms
// that have a direct declarative replacement (map/filter/flatMap), as opposed to
// a callback that logs or recurses, where the only rewrite is a loop.
const ACCUMULATOR_METHODS = new Set(["push", "unshift", "add", "set"]);

function isAccumulatorCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    ACCUMULATOR_METHODS.has(propertyName(node.callee.property))
  );
}

// True only when EVERY statement in the callback is a bare accumulator call.
function callbackIsPureAccumulation(callback) {
  if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression") {
    return false;
  }
  // Concise arrow body: `xs.forEach(x => out.push(x))`
  if (callback.body.type !== "BlockStatement") {
    return isAccumulatorCall(callback.body);
  }
  return (
    callback.body.body.length > 0 &&
    callback.body.body.every(
      (statement) =>
        statement.type === "ExpressionStatement" && isAccumulatorCall(statement.expression),
    )
  );
}

const noAccumulatorForEachRule = {
  meta: {
    type: "suggestion",
    messages: {
      accumulation:
        "This .forEach() only builds a collection by mutation. Prefer the declarative form (.map()/.filter()/.flatMap(), or new Map()/new Set() over a mapped array) so the result is a value rather than an accumulated side effect. If the mutation is genuinely the clearest expression, add an oxlint-disable-next-line with a one-line justification.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee?.type === "MemberExpression" &&
          propertyName(node.callee.property) === "forEach" &&
          callbackIsPureAccumulation(node.arguments[0])
        ) {
          context.report({ node, messageId: "accumulation" });
        }
      },
    };
  },
};

// A bare `expect(...)` used as a statement asserts nothing: no matcher is
// chained, so nothing runs and it can never fail (issue #4198). The ESLint
// version used the esquery selector
// `ExpressionStatement > CallExpression[callee.name='expect']`; here it is a
// plain ExpressionStatement visitor with the same predicate so it does not
// depend on oxlint's esquery-selector support.
const noBareExpectRule = {
  meta: {
    type: "problem",
    messages: {
      bareExpect:
        '`expect(...)` with no matcher chained asserts nothing and can never fail. Chain a matcher (e.g. .toBe/.toEqual). Note: `expect(x, "label")` is a valid labeled assertion only when a matcher follows.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const expr = node.expression;
        if (
          expr?.type === "CallExpression" &&
          expr.callee?.type === "Identifier" &&
          expr.callee.name === "expect"
        ) {
          context.report({ node: expr, messageId: "bareExpect" });
        }
      },
    };
  },
};

// A stress test runs an inherently unbounded loop (issue #4342). Require every
// stress test that RUNS a body in test/stress to pass a numeric-literal timeout
// of at least MIN_STRESS_TIMEOUT_MS.
const MIN_STRESS_TIMEOUT_MS = 10_000;

const stressExplicitTimeoutRule = {
  meta: {
    type: "problem",
    messages: {
      missingTimeout: `A stress test declares no explicit timeout, so it silently inherits bun's 5000ms default (issue #4342). Pass a numeric-literal timeout of at least ${MIN_STRESS_TIMEOUT_MS}ms as the third argument, e.g. \`test(name, fn, 30_000)\`.`,
      timeoutTooSmall: `A stress test's ${MIN_STRESS_TIMEOUT_MS}ms floor is not enough headroom (issue #4342: the loop was observed at 5015ms). Raise the third-argument timeout to at least ${MIN_STRESS_TIMEOUT_MS}ms.`,
    },
  },
  create(context) {
    const isFunction = (node) =>
      node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
    // Unwind an arbitrarily-chained test callee to its root identifier and the
    // set of member names in the chain: `test.concurrent.each(t)` → { root:
    // "test", props: {"concurrent","each"} }.
    const unwind = (node) => {
      if (node.type === "Identifier") {
        return { root: node.name, props: new Set() };
      }
      if (node.type === "MemberExpression" && node.property.type === "Identifier") {
        const inner = unwind(node.object);
        if (inner) {
          inner.props.add(node.property.name);
        }
        return inner;
      }
      if (node.type === "CallExpression") {
        return unwind(node.callee);
      }
      return null;
    };
    return {
      CallExpression(node) {
        const callee = unwind(node.callee);
        if (!callee || (callee.root !== "test" && callee.root !== "it")) {
          return;
        }
        // `.skip`/`.todo` never execute a body, so they carry no deadline.
        if (callee.props.has("skip") || callee.props.has("todo")) {
          return;
        }
        const [, body, timeout] = node.arguments;
        // Only name+body test declarations carry a per-test deadline.
        if (!isFunction(body)) {
          return;
        }
        if (timeout === undefined) {
          context.report({ node, messageId: "missingTimeout" });
          return;
        }
        // A non-literal (identifier, expression) can't be checked statically
        // and hides the deadline from the call site — treat as unstated.
        if (timeout.type !== "Literal" || typeof timeout.value !== "number") {
          context.report({ node, messageId: "missingTimeout" });
          return;
        }
        if (timeout.value < MIN_STRESS_TIMEOUT_MS) {
          context.report({ node, messageId: "timeoutTooSmall" });
        }
      },
    };
  },
};

// The following three rules replace the `no-restricted-syntax` selectors from
// eslint.config.mjs, which oxlint does not support. Each is a plain-visitor
// re-expression of one selector; splitting them into separate rules (rather than
// one combined rule) mirrors how the ESLint config re-listed a SUBSET for
// SystemTimer.ts — here that file simply disables `auto-mobile/no-raw-timer`
// while keeping the import-extension ban.

// Bans `.js`/`.ts` extensions in RELATIVE imports (extensionless only), which
// otherwise cause MODULE_NOT_FOUND under the test runner.
const noExtensionImportRule = {
  meta: {
    type: "problem",
    messages: {
      jsExt:
        "Do not use .js extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.js'). This causes MODULE_NOT_FOUND errors in tests.",
      tsExt:
        "Do not use .ts extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.ts').",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        if (typeof value !== "string" || !value.startsWith(".")) {
          return;
        }
        if (value.endsWith(".js")) {
          context.report({ node: node.source, messageId: "jsExt" });
        } else if (value.endsWith(".ts")) {
          context.report({ node: node.source, messageId: "tsExt" });
        }
      },
    };
  },
};

// Bans raw setTimeout/setInterval so the injectable Timer seam is always used.
const noRawTimerRule = {
  meta: {
    type: "problem",
    messages: {
      setTimeout:
        "Use Timer.setTimeout() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
      setInterval:
        "Use Timer.setInterval() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee?.type !== "Identifier") {
          return;
        }
        if (node.callee.name === "setTimeout") {
          context.report({ node, messageId: "setTimeout" });
        } else if (node.callee.name === "setInterval") {
          context.report({ node, messageId: "setInterval" });
        }
      },
    };
  },
};

// Bans reading a field off an MCP envelope's `structuredContent` directly (the
// #2907 dead-read foot-gun: only success/error are hoisted, so a missing field
// is a silent undefined). Matches any MemberExpression whose object is itself a
// `.structuredContent` member access.
const noStructuredContentReadRule = {
  meta: {
    type: "problem",
    messages: {
      deadRead:
        "Do not read a field off `structuredContent` directly. Use getStructuredField(response, key) for one field or getStructuredPayload(response) for the whole payload. Import from 'utils/toolUtils' (issue #2907).",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object?.type === "MemberExpression" &&
          propertyName(node.object.property) === "structuredContent"
        ) {
          context.report({ node, messageId: "deadRead" });
        }
      },
    };
  },
};

// Replaces @typescript-eslint/naming-convention (unsupported by oxlint) for the
// two selectors the repo enforces: interface names (PascalCase, no "I" prefix,
// no "Interface" suffix) and class names (PascalCase, no "Impl" suffix).
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const namingConventionRule = {
  meta: {
    type: "problem",
    messages: {
      interfaceName:
        "Interface names must be PascalCase without an 'I' prefix or 'Interface' suffix.",
      className: "Class names must be PascalCase without an 'Impl' suffix.",
    },
  },
  create(context) {
    // Class names appear on both ClassDeclaration (`class Foo {}`) and named
    // ClassExpression (`const X = class FooImpl {}`); the old
    // @typescript-eslint `class` selector covered both, so check both here. A
    // class expression may be anonymous (`node.id === null`), in which case
    // there is no name to check.
    function checkClassName(node) {
      const name = node.id?.name;
      if (typeof name !== "string") {
        return;
      }
      if (!PASCAL_CASE.test(name) || name.endsWith("Impl")) {
        context.report({ node: node.id, messageId: "className" });
      }
    }
    return {
      TSInterfaceDeclaration(node) {
        const name = node.id?.name;
        if (typeof name !== "string") {
          return;
        }
        if (!PASCAL_CASE.test(name) || /^I[A-Z]/.test(name) || name.endsWith("Interface")) {
          context.report({ node: node.id, messageId: "interfaceName" });
        }
      },
      ClassDeclaration: checkClassName,
      ClassExpression: checkClassName,
    };
  },
};

// Bans the inline message-only idiom `X instanceof Error ? X.message :
// String(X)` (issue #5457). There is one canonical helper, errorMessage(X) from
// utils/describeUnknownError, so the ternary should never be written by hand.
// Matches only the EXACT message-only shape where all three occurrences are the
// same identifier; richer variants (`.stack`, `: new Error(String(x))`, `.name`)
// are deliberately left alone.
function identifierName(node) {
  return node?.type === "Identifier" ? node.name : null;
}

// Strip transparent TS/chain wrappers that are erased or irrelevant to the
// reference's runtime identity: a non-null assertion (`error!`) is a compile-time
// TS construct, and a `ChainExpression` is just the optional-chaining envelope
// (`error?.message`) whose `.message` read is identical to `error.message` on a
// non-nullish error. Unwrapping here lets those spellings match the same subject
// so the rule flags `error!.message` / `error?.message` instead of silently
// treating them as different references (issue #5505, deferred edge case 3).
function unwrapRef(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSNonNullExpression" || current.type === "ChainExpression")
  ) {
    current = current.expression;
  }
  return current;
}

// Structural token list for a side-effect-free reference expression: an identifier,
// `this`, a non-computed member chain (`a.b.c`), or computed access by a literal or
// identifier index (`a[0]`, `a["0"]`, `a[i]`). Returns null for anything whose repeated
// evaluation may not be stable (calls, computed access by an expression). Each segment
// is canonicalized to how JavaScript resolves the property key, so the *same* property
// compares equal regardless of spelling (`.error`/`["error"]`, `[0]`/`["0"]`), while a
// computed identifier key stays distinct (its value can differ from a same-text literal).
function refTokens(rawNode) {
  const node = unwrapRef(rawNode);
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return [["root", node.name]];
  }
  if (node.type === "ThisExpression") {
    return [["this"]];
  }
  if (node.type === "MemberExpression") {
    const base = refTokens(node.object);
    if (base === null) {
      return null;
    }
    let segment = null;
    if (node.computed) {
      const property = node.property;
      if (
        property?.type === "Literal" &&
        (typeof property.value === "string" || typeof property.value === "number")
      ) {
        segment = ["prop", String(property.value)];
      } else if (property?.type === "Identifier") {
        segment = ["dyn", property.name];
      }
    } else {
      const prop = propertyName(node.property);
      segment = prop === null ? null : ["prop", prop];
    }
    return segment === null ? null : [...base, segment];
  }
  return null;
}

// Canonical, collision-proof key: JSON.stringify of the structural token list, so a
// literal property value can never be confused with the serializer's own delimiters
// (`a["b.prop:c"]` and `a.b.c` produce different token arrays, hence different keys).
function stableRefKey(node) {
  const tokens = refTokens(node);
  return tokens === null ? null : JSON.stringify(tokens);
}

const noInlineErrorNormalizeRule = {
  meta: {
    type: "suggestion",
    messages: {
      inlineNormalize:
        "Do not inline `X instanceof Error ? X.message : String(X)`. Use the canonical errorMessage(X) helper (import { errorMessage } from 'utils/describeUnknownError'), issue #5457.",
    },
  },
  create(context) {
    return {
      ConditionalExpression(node) {
        const test = node.test;
        if (test?.type !== "BinaryExpression" || test.operator !== "instanceof") {
          return;
        }
        const subjectKey = stableRefKey(test.left);
        if (subjectKey === null || identifierName(test.right) !== "Error") {
          return;
        }
        // consequent must be `<subject>.message` or `<subject>["message"]` (a
        // computed access is only `.message` when its key is the string literal
        // "message" — a computed identifier key like `[message]` is a different var).
        const consequent = unwrapRef(node.consequent);
        const consequentIsMessage =
          consequent?.type === "MemberExpression" &&
          stableRefKey(consequent.object) === subjectKey &&
          (consequent.computed
            ? consequent.property?.type === "Literal" && consequent.property.value === "message"
            : propertyName(consequent.property) === "message");
        if (!consequentIsMessage) {
          return;
        }
        // alternate must be `String(<subject>)`.
        const alternate = node.alternate;
        if (
          alternate?.type !== "CallExpression" ||
          identifierName(alternate.callee) !== "String" ||
          alternate.arguments.length !== 1 ||
          stableRefKey(alternate.arguments[0]) !== subjectKey
        ) {
          return;
        }
        context.report({ node, messageId: "inlineNormalize" });
      },
    };
  },
};

const noCaughtErrorInterpolationRule = {
  meta: {
    type: "problem",
    messages: {
      caughtErrorInterpolation:
        "Pass caught errors to toActionableError(error, context) instead of interpolating them into ActionableError messages.",
    },
  },
  create(context) {
    const patternNames = (pattern, names = new Set()) => {
      if (!pattern) return names;
      if (pattern.type === "Identifier") names.add(pattern.name);
      else if (pattern.type === "RestElement") patternNames(pattern.argument, names);
      else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, names);
      else if (pattern.type === "ArrayPattern")
        pattern.elements.forEach((item) => patternNames(item, names));
      else if (pattern.type === "ObjectPattern")
        pattern.properties.forEach((item) =>
          patternNames(item.type === "RestElement" ? item.argument : item.value, names),
        );
      return names;
    };
    const inspect = (node, names) => {
      if (!node || typeof node.type !== "string" || node.type === "CatchClause") return;
      if (
        node.type === "NewExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "ActionableError" &&
        node.arguments?.[0]?.type === "TemplateLiteral" &&
        node.arguments[0].expressions.some(
          (expression) => expression.type === "Identifier" && names.has(expression.name),
        )
      )
        context.report({ node, messageId: "caughtErrorInterpolation" });
      for (const [key, value] of Object.entries(node)) {
        if (key === "parent") continue;
        if (Array.isArray(value)) value.forEach((child) => inspect(child, names));
        else if (value && typeof value === "object") inspect(value, names);
      }
    };
    return {
      CatchClause(node) {
        if (node.param) inspect(node.body, patternNames(node.param));
      },
    };
  },
};

// Scope-aware syntactic backstop for raw capture nodes. Typed Element results and
// request DTOs are intentionally distinct from raw any/unknown/Record boundaries.
const noRawSelectorFieldReadRule = {
  meta: {
    type: "problem",
    messages: {
      rawSelector:
        "Resolve selectors through ElementResolver/SearchableNode instead of reading raw capture text, content-desc, or resource-id fields.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      !/(?:^|\/)src\/(?:features\/(?:action|debug)|server)\//.test(filename) &&
      !/(?:^|\/)src\/features\/(?:accessibility\/SetAccessibilityFocus|observe\/ConditionPredicates)\.ts$/.test(
        filename,
      )
    )
      return {};
    return {
      Program(program) {
        const fields = new Set(["text", "content-desc", "resource-id"]);
        const rawType = (annotation, env, seen = new Set()) => {
          const type = annotation?.typeAnnotation ?? annotation;
          if (!type) return false;
          if (["TSAnyKeyword", "TSUnknownKeyword"].includes(type.type)) return true;
          if (["TSUnionType", "TSIntersectionType"].includes(type.type))
            return type.types.some((item) => rawType(item, env, seen));
          if (type.type === "TSTypeOperator") return rawType(type.typeAnnotation, env, seen);
          if (type.type === "TSArrayType") return rawType(type.elementType, env, seen);
          if (["TSTypeLiteral", "TSInterfaceBody"].includes(type.type))
            return (type.members ?? type.body).some(
              (member) =>
                member.type === "TSIndexSignature" && rawType(member.typeAnnotation, env, seen),
            );
          if (type.type === "TSTupleType")
            return type.elementTypes.some((item) => rawType(item, env, seen));
          if (type.type !== "TSTypeReference") return false;
          const name = type.typeName?.name;
          if (["ViewHierarchyNode", "ViewHierarchyResult", "Record"].includes(name)) return true;
          const alias = env?.get(`type:${name}`);
          if (!alias)
            return (type.typeArguments?.params ?? type.typeParameters?.params ?? []).some((item) =>
              rawType(item, env, seen),
            );
          if (seen.has(name)) return false;
          const nextSeen = new Set([...seen, name]);
          return (
            rawType(alias, env, nextSeen) ||
            (env.get(`typeHeritage:${name}`) ?? []).some((heritage) =>
              rawType(
                {
                  type: "TSTypeReference",
                  typeName: heritage.expression,
                  typeArguments: heritage.typeArguments,
                },
                env,
                nextSeen,
              ),
            )
          );
        };
        const lookup = (env, name) => env.get(name);
        const containsTypeParameter = (annotation, parameters) => {
          const type = annotation?.typeAnnotation ?? annotation;
          if (!type || parameters.size === 0) return false;
          if (type.type === "TSTypeReference")
            return (
              parameters.has(type.typeName?.name) ||
              (type.typeArguments?.params ?? []).some((item) =>
                containsTypeParameter(item, parameters),
              )
            );
          if (["TSArrayType", "TSTypeOperator"].includes(type.type))
            return containsTypeParameter(type.elementType ?? type.typeAnnotation, parameters);
          if (["TSUnionType", "TSIntersectionType"].includes(type.type))
            return type.types.some((item) => containsTypeParameter(item, parameters));
          return false;
        };
        const propertyTypes = (annotation, env, seen = new Set(), rawParams = new Set()) => {
          const type = annotation?.typeAnnotation ?? annotation;
          if (type?.type === "TSTypeReference") {
            const name = type.typeName?.name;
            if (seen.has(name)) return new Set();
            const alias = env.get(`type:${name}`);
            const params = env.get(`typeParams:${name}`) ?? [];
            const args = type.typeArguments?.params ?? type.typeParameters?.params ?? [];
            const rawParams = new Set(params.filter((_, index) => rawType(args[index], env)));
            return propertyTypes(alias, env, new Set([...seen, name]), rawParams);
          }
          if (!["TSTypeLiteral", "TSInterfaceBody"].includes(type?.type)) return new Set();
          return new Set(
            (type.members ?? type.body)
              .filter(
                (member) =>
                  (rawType(member.typeAnnotation, env) ||
                    containsTypeParameter(member.typeAnnotation, rawParams)) &&
                  propertyName(member.key) !== null,
              )
              .map((member) => propertyName(member.key)),
          );
        };
        const key = (node, env) => {
          if (node?.type === "Literal") return node.value;
          if (node?.type === "Identifier") return lookup(env, node.name)?.literal;
          if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
            return node.quasis[0].value.cooked;
          return undefined;
        };
        const blockReturnsRaw = (block, env) => {
          let found = false;
          const inspect = (node, local, inherited) => {
            if (!node || typeof node.type !== "string") return false;
            if (
              ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
                node.type,
              )
            )
              return false;
            if (node.type === "BlockStatement") {
              const scope = new Map(local);
              const outerBindings = new Map(local);
              let hasRaw = false;
              for (const statement of node.body)
                if (inspect(statement, scope, outerBindings)) hasRaw = true;
              return hasRaw;
            }
            if (node.type === "VariableDeclaration") {
              for (const declarator of node.declarations)
                bind(declarator.id, declarator.init, local, raw(declarator.init, local));
              return false;
            }
            if (node.type === "AssignmentExpression")
              bind(
                node.left,
                node.right,
                local,
                raw(node.right, local),
                true,
                node.operator !== "=",
                inherited,
              );
            if (node.type === "ReturnStatement") {
              found = true;
              return raw(node.argument, local);
            }
            let hasRaw = false;
            for (const [name, value] of Object.entries(node)) {
              if (name === "parent" || name === "typeAnnotation") continue;
              if (Array.isArray(value)) {
                for (const child of value) if (inspect(child, local, inherited)) hasRaw = true;
              } else if (value && typeof value === "object" && inspect(value, local, inherited))
                hasRaw = true;
            }
            return hasRaw;
          };
          const hasRawReturn = inspect(block, env);
          return found && hasRawReturn;
        };
        const objectFieldRaw = (object, name, env) => {
          let isRaw = false;
          for (const property of object.properties) {
            if (property.type === "SpreadElement") {
              if (fields.has(name) && raw(property.argument, env)) isRaw = true;
              continue;
            }
            const propertyKey = property.computed
              ? key(property.key, env)
              : propertyName(property.key);
            if (propertyKey === name) isRaw = raw(property.value, env);
          }
          return isRaw;
        };
        const raw = (node, env) => {
          if (!node) return false;
          if (
            [
              "ChainExpression",
              "TSNonNullExpression",
              "ParenthesizedExpression",
              "AwaitExpression",
              "TSSatisfiesExpression",
            ].includes(node.type)
          )
            return raw(node.expression ?? node.argument, env);
          if (["TSAsExpression", "TSTypeAssertion"].includes(node.type)) {
            // Protocol DTO assertions mark a checked bridge boundary; merely
            // casting a capture node to Element must not hide its provenance.
            if (rawType(node.typeAnnotation, env)) return true;
            return node.typeAnnotation?.typeName?.name === "Element" && raw(node.expression, env);
          }
          if (node.type === "Identifier") return lookup(env, node.name)?.raw === true;
          if (node.type === "ArrayExpression")
            return node.elements.some((element) =>
              element?.type === "SpreadElement" ? raw(element.argument, env) : raw(element, env),
            );
          if (node.type === "ObjectExpression")
            return node.properties.some(
              (property) => property.type === "SpreadElement" && raw(property.argument, env),
            );
          if (node.type === "MemberExpression") {
            const name = node.computed ? key(node.property, env) : propertyName(node.property);
            if (node.object?.type === "ObjectExpression")
              return objectFieldRaw(node.object, name, env);
            const objectFields =
              node.object?.type === "Identifier"
                ? lookup(env, node.object.name)?.objectFields
                : undefined;
            if (objectFields?.has(name)) return objectFields.get(name);
            const arrayElements =
              node.object?.type === "Identifier"
                ? lookup(env, node.object.name)?.arrayElements
                : undefined;
            if (arrayElements && Number.isInteger(name) && name >= 0 && name < arrayElements.length)
              return arrayElements[name];
            return (
              raw(node.object, env) ||
              (node.object?.type === "Identifier" &&
                lookup(env, node.object.name)?.properties?.has(name))
            );
          }
          if (node.type === "LogicalExpression" || node.type === "ConditionalExpression")
            return raw(node.left ?? node.consequent, env) || raw(node.right ?? node.alternate, env);
          if (node.type === "CallExpression") {
            const method = node.callee?.property?.name;
            const receiverRaw =
              node.callee?.type === "MemberExpression" && raw(node.callee.object, env);
            const transformed = ["map", "flatMap"].includes(method);
            const callback = node.arguments[0];
            const callbackEnv = new Map(env);
            const elementParameter = ["reduce", "reduceRight"].includes(method) ? 1 : 0;
            if (callback?.params?.[elementParameter] && receiverRaw)
              bind(callback.params[elementParameter], undefined, callbackEnv, true);
            if (
              ["reduce", "reduceRight"].includes(method) &&
              node.arguments.length < 2 &&
              receiverRaw
            )
              bind(callback?.params?.[0], undefined, callbackEnv, true);
            const transformedRaw = callback?.returnType
              ? rawType(callback.returnType, env)
              : callback?.body?.type === "BlockStatement"
                ? blockReturnsRaw(callback.body, callbackEnv)
                : raw(callback?.body, callbackEnv);
            return (
              lookup(env, node.callee?.name)?.rawReturn === true ||
              (node.callee?.object?.type === "ThisExpression" &&
                lookup(env, `method:${method}`)?.rawReturn === true) ||
              (receiverRaw &&
                ["reduce", "reduceRight"].includes(method) &&
                (node.arguments.length < 2 || raw(node.arguments[1], env) || transformedRaw)) ||
              (receiverRaw &&
                [
                  "find",
                  "findLast",
                  "at",
                  "pop",
                  "shift",
                  "map",
                  "filter",
                  "flatMap",
                  "sort",
                  "toSorted",
                  "slice",
                  "concat",
                  "toReversed",
                  "toSpliced",
                ].includes(method) &&
                (!transformed || transformedRaw)) ||
              (method === "concat" &&
                node.arguments.some((argument) =>
                  raw(argument.type === "SpreadElement" ? argument.argument : argument, env),
                )) ||
              ["extractNodeProperties", "getNodeProperties"].includes(method ?? node.callee?.name)
            );
          }
          return false;
        };
        const bind = (
          pattern,
          value,
          env,
          isRaw,
          assignment = false,
          conditional = false,
          inherited,
        ) => {
          if (!pattern) return;
          if (pattern.type === "Identifier") {
            let binding = assignment ? env.get(pattern.name) : undefined;
            if (binding) {
              // An assignment in a nested block must not mutate the enclosing
              // binding record: execution may skip this block entirely.
              if (inherited?.get(pattern.name) === binding) {
                binding = { ...binding };
                env.set(pattern.name, binding);
              }
              const nextRaw = isRaw || rawType(pattern.typeAnnotation, env);
              binding.raw = conditional ? binding.raw || nextRaw : nextRaw;
              const next = key(value, env);
              binding.literal = next;
              binding.literals = new Set(
                (conditional ? [...(binding.literals ?? []), next] : [next]).filter(Boolean),
              );
              const nextElements =
                value?.type === "ArrayExpression" &&
                !value.elements.some((element) => element?.type === "SpreadElement")
                  ? value.elements.map((element) => raw(element, env))
                  : undefined;
              binding.arrayElements =
                conditional &&
                binding.arrayElements &&
                nextElements &&
                binding.arrayElements.length === nextElements.length
                  ? binding.arrayElements.map(
                      (elementRaw, index) => elementRaw || nextElements[index],
                    )
                  : conditional
                    ? undefined
                    : nextElements;
            } else {
              const properties = new Map();
              const objectFields = new Map();
              if (value?.type === "ObjectExpression")
                for (const property of value.properties) {
                  if (property.type === "SpreadElement") {
                    if (raw(property.argument, env))
                      for (const field of fields) {
                        properties.set(field, true);
                        objectFields.set(field, true);
                      }
                  } else {
                    const propertyKey = property.computed
                      ? key(property.key, env)
                      : propertyName(property.key);
                    if (propertyKey !== undefined) {
                      const propertyRaw = raw(property.value, env);
                      properties.set(propertyKey, propertyRaw);
                      if (fields.has(propertyKey)) objectFields.set(propertyKey, propertyRaw);
                    }
                  }
                }
              env.set(pattern.name, {
                raw: isRaw || rawType(pattern.typeAnnotation, env),
                literal: key(value, env),
                literals: new Set([key(value, env)].filter(Boolean)),
                arrayElements:
                  value?.type === "ArrayExpression" &&
                  !value.elements.some((element) => element?.type === "SpreadElement")
                    ? value.elements.map((element) => raw(element, env))
                    : undefined,
                properties:
                  value?.type === "ObjectExpression"
                    ? new Set(
                        [...properties]
                          .filter(([, propertyRaw]) => propertyRaw)
                          .map(([field]) => field),
                      )
                    : propertyTypes(pattern.typeAnnotation, env),
                objectFields: value?.type === "ObjectExpression" ? objectFields : undefined,
                rawReturn: rawType(
                  value?.returnType ?? pattern.typeAnnotation?.typeAnnotation?.returnType,
                  env,
                ),
              });
            }
          } else if (pattern.type === "ObjectPattern") {
            const sourceProperties =
              value?.type === "Identifier" ? lookup(env, value.name)?.properties : undefined;
            for (const property of pattern.properties) {
              if (property.type === "RestElement") {
                bind(property.argument, undefined, env, isRaw, assignment, conditional, inherited);
                continue;
              }
              const name = property.computed ? key(property.key, env) : propertyName(property.key);
              if (isRaw && fields.has(name))
                context.report({ node: property, messageId: "rawSelector" });
              bind(
                property.value,
                undefined,
                env,
                (isRaw && !fields.has(name)) || sourceProperties?.has(name) === true,
                assignment,
                conditional,
                inherited,
              );
            }
          } else if (pattern.type === "ArrayPattern") {
            for (const element of pattern.elements)
              bind(element, undefined, env, isRaw, assignment, conditional, inherited);
          } else if (pattern.type === "RestElement") {
            bind(pattern.argument, undefined, env, isRaw, assignment, conditional, inherited);
          } else if (pattern.type === "AssignmentPattern")
            bind(pattern.left, pattern.right, env, isRaw, assignment, conditional, inherited);
        };
        const visit = (node, env, parent, role, conditional = false) => {
          if (!node || typeof node.type !== "string") return;
          if (
            ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
              node.type,
            )
          ) {
            const local = new Map(
              [...env].map(([name, binding]) => [
                name,
                Array.isArray(binding)
                  ? [...binding]
                  : binding && typeof binding === "object"
                    ? {
                        ...binding,
                        literals: binding.literals && new Set(binding.literals),
                        properties: binding.properties && new Set(binding.properties),
                      }
                    : binding,
              ]),
            );
            for (const parameter of node.params)
              bind(parameter, undefined, local, rawType(parameter.typeAnnotation, local));
            // Traversal callbacks receive raw hierarchy nodes even without annotations.
            if (
              parent?.type === "CallExpression" &&
              (parent.callee?.property?.name === "traverseNode" ||
                ([
                  "find",
                  "findIndex",
                  "findLast",
                  "findLastIndex",
                  "map",
                  "filter",
                  "flatMap",
                  "some",
                  "every",
                  "forEach",
                  "sort",
                  "toSorted",
                  "reduce",
                  "reduceRight",
                ].includes(parent.callee?.property?.name) &&
                  raw(parent.callee.object, env)))
            )
              bind(
                node.params[
                  ["reduce", "reduceRight"].includes(parent.callee?.property?.name) ? 1 : 0
                ],
                undefined,
                local,
                true,
              );
            if (
              parent?.type === "CallExpression" &&
              ["reduce", "reduceRight"].includes(parent.callee?.property?.name) &&
              parent.arguments.length < 2 &&
              raw(parent.callee.object, env)
            )
              bind(node.params[0], undefined, local, true);
            if (
              parent?.type === "CallExpression" &&
              ["sort", "toSorted"].includes(parent.callee?.property?.name) &&
              raw(parent.callee.object, env)
            )
              bind(node.params[1], undefined, local, true);
            visit(node.body, local, node, "body", conditional);
            return;
          }
          if (node.type === "BlockStatement") env = new Map(env);
          if (node.type === "Program" || node.type === "BlockStatement") {
            // Predeclare explicit type aliases and function signatures in their lexical scope.
            for (const statement of node.body) {
              const declaration = statement.declaration ?? statement;
              if (declaration.type === "TSTypeAliasDeclaration") {
                env.set(`type:${declaration.id.name}`, declaration.typeAnnotation);
                env.set(`typeHeritage:${declaration.id.name}`, []);
                env.set(
                  `typeParams:${declaration.id.name}`,
                  (declaration.typeParameters?.params ?? []).map((param) => param.name?.name),
                );
              }
              if (declaration.type === "TSInterfaceDeclaration") {
                env.set(`type:${declaration.id.name}`, declaration.body);
                env.set(`typeHeritage:${declaration.id.name}`, declaration.extends ?? []);
                env.set(
                  `typeParams:${declaration.id.name}`,
                  (declaration.typeParameters?.params ?? []).map((param) => param.name?.name),
                );
              }
              if (declaration.type === "ImportDeclaration")
                for (const specifier of declaration.specifiers)
                  if (specifier.type === "ImportSpecifier")
                    env.set(`type:${specifier.local.name}`, {
                      type: "TSTypeReference",
                      typeName: { name: specifier.imported.name },
                    });
            }
            for (const statement of node.body) {
              const declaration = statement.declaration ?? statement;
              if (declaration.type === "FunctionDeclaration" && declaration.id)
                env.set(declaration.id.name, {
                  raw: false,
                  rawReturn: rawType(declaration.returnType, env),
                });
            }
          }
          if (node.type === "ClassBody") {
            env = new Map(env);
            for (const method of node.body) {
              const name = propertyName(method.key);
              if (name)
                env.set(`method:${name}`, { rawReturn: rawType(method.value?.returnType, env) });
            }
          }
          if (node.type === "VariableDeclarator") {
            bind(node.id, node.init, env, raw(node.init, env));
            visit(node.init, env, node, "init", conditional);
            return;
          }
          if (node.type === "ForOfStatement") {
            visit(node.right, env, node, "right", conditional);
            const loop = new Map(env);
            const left =
              node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
            bind(left, undefined, loop, raw(node.right, env));
            visit(node.body, loop, node, "body", true);
            return;
          }
          if (
            node.type === "AssignmentExpression" &&
            ["Identifier", "ObjectPattern", "ArrayPattern"].includes(node.left.type)
          )
            bind(
              node.left,
              node.right,
              env,
              raw(node.right, env),
              true,
              conditional || node.operator !== "=",
            );
          if (
            node.type === "MemberExpression" &&
            !(parent?.type === "AssignmentExpression" && parent.operator === "=" && role === "left")
          ) {
            const name = node.computed ? key(node.property, env) : node.property.name;
            const possible =
              node.computed && node.property.type === "Identifier"
                ? lookup(env, node.property.name)?.literals
                : undefined;
            const objectRaw =
              node.object?.type === "ObjectExpression"
                ? objectFieldRaw(node.object, name, env)
                : node.object?.type === "Identifier" &&
                    lookup(env, node.object.name)?.objectFields?.has(name)
                  ? lookup(env, node.object.name).objectFields.get(name)
                  : raw(node.object, env);
            if (
              (fields.has(name) || [...(possible ?? [])].some((item) => fields.has(item))) &&
              objectRaw
            )
              context.report({ node, messageId: "rawSelector" });
          }
          for (const [name, value] of Object.entries(node)) {
            if (name === "parent" || name === "typeAnnotation") continue;
            const branch =
              conditional ||
              ((node.type === "IfStatement" || node.type === "ConditionalExpression") &&
                (name === "consequent" || name === "alternate")) ||
              (node.type === "SwitchCase" && name === "consequent") ||
              (node.type === "TryStatement" && name === "block") ||
              (node.type === "LogicalExpression" && name === "right") ||
              (["WhileStatement", "DoWhileStatement", "ForStatement"].includes(node.type) &&
                name === "body");
            if (Array.isArray(value))
              for (const child of value) visit(child, env, node, name, branch);
            else if (value && typeof value === "object") visit(value, env, node, name, branch);
          }
        };
        visit(program, new Map(), null, "");
      },
    };
  },
};

const plugin = {
  meta: {
    name: "auto-mobile",
  },
  rules: {
    "catch-convention": catchConventionRule,
    "no-inline-error-normalize": noInlineErrorNormalizeRule,
    "no-caught-error-interpolation": noCaughtErrorInterpolationRule,
    "no-unknown-cast": noUnknownCastRule,
    "no-accumulator-foreach": noAccumulatorForEachRule,
    "no-bare-expect": noBareExpectRule,
    "stress-explicit-timeout": stressExplicitTimeoutRule,
    "no-extension-import": noExtensionImportRule,
    "no-raw-timer": noRawTimerRule,
    "no-raw-selector-field-read": noRawSelectorFieldReadRule,
    "no-structured-content-read": noStructuredContentReadRule,
    "naming-convention": namingConventionRule,
  },
};

export default plugin;
