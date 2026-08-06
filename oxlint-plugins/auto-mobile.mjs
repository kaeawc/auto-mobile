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
	return propertyName(node.callee.property) === methodName && memberChainIncludesLogger(node.callee.object);
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
			if (value.some(child => hasLoggerMethodCall(child, methodName, seen))) {
				return true;
			}
		} else if (value && typeof value === "object" && typeof value.type === "string" && hasLoggerMethodCall(value, methodName, seen)) {
			return true;
		}
	}
	return false;
}

function hasAnyLoggerCall(node) {
	return hasLoggerMethodCall(node, "debug") || hasLoggerMethodCall(node, "warn") || hasLoggerMethodCall(node, "error");
}

function isUndefinedReturn(argument) {
	return argument?.type === "Identifier" && argument.name === "undefined";
}

function isBooleanReturn(argument) {
	return argument?.type === "Literal" && typeof argument.value === "boolean";
}

function isStatusObjectReturn(argument) {
	return argument?.type === "ObjectExpression" &&
		argument.properties.some(property =>
			property.type === "Property" && propertyName(property.key) === "status"
		);
}

function isFallbackReturn(argument) {
	return !argument || argument.type === "Literal" && argument.value === null || isUndefinedReturn(argument) || isBooleanReturn(argument) || isStatusObjectReturn(argument);
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
	if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
		return false;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") {
			continue;
		}
		if (Array.isArray(value)) {
			if (value.some(child => hasThrowStatement(child, seen))) {
				return true;
			}
		} else if (value && typeof value === "object" && typeof value.type === "string" && hasThrowStatement(value, seen)) {
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
		if (key === "parent") {
			continue;
		}
		if (Array.isArray(value)) {
			if (value.some(child => identifierIsReferenced(child, name, seen))) {
				return true;
			}
		} else if (value && typeof value === "object" && typeof value.type === "string" && identifierIsReferenced(value, name, seen)) {
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
			fallbackReturn: "Catch blocks that return a fallback must log the caught error before returning.",
			statusReturn: "Catch blocks that return a typed failure/status object must log at warn, not debug.",
			tracelessCatch: "Catch block swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).",
		},
	},
	create(context) {
		function reportStatusReturnsWithoutWarn(statements, hasPriorWarn) {
			for (const statement of statements) {
				if (statement.type === "ExpressionStatement" && isLoggerMethodCall(statement.expression, "warn")) {
					hasPriorWarn = true;
				}
				if (statement.type === "ReturnStatement" && isStatusObjectReturn(statement.argument) && !hasPriorWarn) {
					context.report({ node: statement, messageId: "statusReturn" });
				}
				if (statement.type === "IfStatement") {
					reportStatusReturnsWithoutWarn(
						statement.consequent.type === "BlockStatement" ? statement.consequent.body : [statement.consequent],
						hasPriorWarn
					);
					if (statement.alternate) {
						reportStatusReturnsWithoutWarn(
							statement.alternate.type === "BlockStatement" ? statement.alternate.body : [statement.alternate],
							hasPriorWarn
						);
					}
				}
			}
		}

		return {
			CatchClause(node) {
				const statements = node.body.body;
				if (statements.length === 1 && statements[0].type === "ReturnStatement" && isFallbackReturn(statements[0].argument) && !hasAnyLoggerCall(node.body)) {
					// A single fallback return without logging keeps its specific
					// message — checked precedence-first so it is not reclassified.
					context.report({ node: statements[0], messageId: "fallbackReturn" });
				} else if (!hasAnyLoggerCall(node.body) && !hasThrowStatement(node.body) && !referencesCaughtError(node)) {
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
			unknownCast: "Avoid `as unknown as T`: it silences the type checker and can mask a real shape mismatch (e.g. a dropped required field). Use a proper type, a type guard, or a narrow assertion. If a library genuinely forces it, add an oxlint-disable-next-line with a one-line justification.",
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
	return node?.type === "CallExpression" &&
		node.callee?.type === "MemberExpression" &&
		ACCUMULATOR_METHODS.has(propertyName(node.callee.property));
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
	return callback.body.body.length > 0 && callback.body.body.every(
		statement => statement.type === "ExpressionStatement" && isAccumulatorCall(statement.expression)
	);
}

const noAccumulatorForEachRule = {
	meta: {
		type: "suggestion",
		messages: {
			accumulation: "This .forEach() only builds a collection by mutation. Prefer the declarative form (.map()/.filter()/.flatMap(), or new Map()/new Set() over a mapped array) so the result is a value rather than an accumulated side effect. If the mutation is genuinely the clearest expression, add an oxlint-disable-next-line with a one-line justification.",
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
			bareExpect: "`expect(...)` with no matcher chained asserts nothing and can never fail. Chain a matcher (e.g. .toBe/.toEqual). Note: `expect(x, \"label\")` is a valid labeled assertion only when a matcher follows.",
		},
	},
	create(context) {
		return {
			ExpressionStatement(node) {
				const expr = node.expression;
				if (expr?.type === "CallExpression" && expr.callee?.type === "Identifier" && expr.callee.name === "expect") {
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
		const isFunction = node =>
			node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
		// Unwind an arbitrarily-chained test callee to its root identifier and the
		// set of member names in the chain: `test.concurrent.each(t)` → { root:
		// "test", props: {"concurrent","each"} }.
		const unwind = node => {
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
			jsExt: "Do not use .js extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.js'). This causes MODULE_NOT_FOUND errors in tests.",
			tsExt: "Do not use .ts extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.ts').",
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
			setTimeout: "Use Timer.setTimeout() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
			setInterval: "Use Timer.setInterval() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
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
			deadRead: "Do not read a field off `structuredContent` directly. Use getStructuredField(response, key) for one field or getStructuredPayload(response) for the whole payload. Import from 'utils/toolUtils' (issue #2907).",
		},
	},
	create(context) {
		return {
			MemberExpression(node) {
				if (node.object?.type === "MemberExpression" && propertyName(node.object.property) === "structuredContent") {
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
			interfaceName: "Interface names must be PascalCase without an 'I' prefix or 'Interface' suffix.",
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

const plugin = {
	meta: {
		name: "auto-mobile",
	},
	rules: {
		"catch-convention": catchConventionRule,
		"no-unknown-cast": noUnknownCastRule,
		"no-accumulator-foreach": noAccumulatorForEachRule,
		"no-bare-expect": noBareExpectRule,
		"stress-explicit-timeout": stressExplicitTimeoutRule,
		"no-extension-import": noExtensionImportRule,
		"no-raw-timer": noRawTimerRule,
		"no-structured-content-read": noStructuredContentReadRule,
		"naming-convention": namingConventionRule,
	},
};

export default plugin;
