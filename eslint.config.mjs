import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import stylistic from "@stylistic/eslint-plugin";
import importRules from "eslint-plugin-import";

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

function catchConventionRule() {
	return {
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
						// — is the root cause of the #3594-class bugs (comment-only iOS
						// SDK-event catches that core no-empty ignores; the Idle
						// rotation-check whose `err` was unused and returned a non-fallback
						// object). Catches that forward the error (reject(e), handleError(e))
						// reference the binding and are intentionally left alone.
						context.report({ node, messageId: "tracelessCatch" });
					}
					reportStatusReturnsWithoutWarn(statements, false);
				},
			};
		},
	};
}

function noUnknownCastRule() {
	return {
		meta: {
			type: "problem",
			messages: {
				unknownCast: "Avoid `as unknown as T`: it silences the type checker and can mask a real shape mismatch (e.g. a dropped required field). Use a proper type, a type guard, or a narrow assertion. If a library genuinely forces it, add an eslint-disable-next-line with a one-line justification.",
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
}

// Building a collection by mutating it inside a callback. These are the forms
// that have a direct declarative replacement (map/filter/flatMap), as opposed to
// a callback that logs or recurses, where the only rewrite is a loop — which is
// *more* imperative and defeats the point of the rule.
//
// Note the deliberately narrow blast radius: every explicit loop form (`for`,
// `for-of`, `for-in`, `while`) is allowed. The goal is to gently direct toward
// declarative style where a clean declarative form exists, not to outlaw
// iteration. Loops remain the clearest tool for device I/O, retries, byte and
// image processing, and ordered async batches.
const ACCUMULATOR_METHODS = new Set(["push", "unshift", "add", "set"]);

function isAccumulatorCall(node) {
	return node?.type === "CallExpression" &&
		node.callee?.type === "MemberExpression" &&
		ACCUMULATOR_METHODS.has(propertyName(node.callee.property));
}

// True only when EVERY statement in the callback is a bare accumulator call.
// A callback that also logs, branches, awaits, or recurses is left alone: it is
// doing real work, not just building a collection.
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

function noAccumulatorForEachRule() {
	return {
		meta: {
			type: "suggestion",
			messages: {
				accumulation: "This .forEach() only builds a collection by mutation. Prefer the declarative form (.map()/.filter()/.flatMap(), or new Map()/new Set() over a mapped array) so the result is a value rather than an accumulated side effect. If the mutation is genuinely the clearest expression, add an eslint-disable-next-line with a one-line justification.",
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
}

const catchConventionPlugin = {
	rules: {
		"catch-convention": catchConventionRule(),
		"no-unknown-cast": noUnknownCastRule(),
		"no-accumulator-foreach": noAccumulatorForEachRule(),
	},
};

const plugins = {
	"@stylistic": stylistic,
	"@typescript-eslint": typescriptEslint,
	"auto-mobile": catchConventionPlugin,
	import: importRules,
};

export const baseRules = {
	"@typescript-eslint/no-unused-vars": [
		2,
		{args: "none", caughtErrors: "none"},
	],

	"@typescript-eslint/naming-convention": [
		2,
		// Interfaces: PascalCase, no "I" prefix, no "Interface" suffix
		{
			selector: "interface",
			format: ["PascalCase"],
			custom: {
				regex: "^I[A-Z]|Interface$",
				match: false,
			},
		},
		// Classes: PascalCase, no "Impl" suffix
		{
			selector: "class",
			format: ["PascalCase"],
			custom: {
				regex: "Impl$",
				match: false,
			},
		},
	],

	/**
	 * Enforced rules
	 */
	// syntax preferences
	"object-curly-spacing": ["error", "always"],
	quotes: [
		2,
		"double",
		{
			avoidEscape: true,
			allowTemplateLiterals: true,
		},
	],
	"jsx-quotes": [2, "prefer-single"],
	"no-extra-semi": 2,
	"@stylistic/semi": [2],
	"comma-style": [2, "last"],
	"wrap-iife": [2, "inside"],
	"spaced-comment": [
		2,
		"always",
		{
			markers: ["*"],
		},
	],
	eqeqeq: [2],
	"accessor-pairs": [
		2,
		{
			getWithoutSet: false,
			setWithoutGet: false,
		},
	],
	"brace-style": [2, "1tbs", {allowSingleLine: true}],
	curly: [2, "all"],
	"new-parens": 2,
	"arrow-parens": [2, "as-needed"],
	"prefer-const": 2,
	"quote-props": [2, "consistent"],
	"nonblock-statement-body-position": [2, "below"],

	// anti-patterns
	"no-var": 2,
	"no-with": 2,
	"no-multi-str": 2,
	"no-caller": 2,
	"no-implied-eval": 2,
	"no-labels": 2,
	"no-new-object": 2,
	"no-octal-escape": 2,
	"no-self-compare": 2,
	"no-shadow-restricted-names": 2,
	"no-cond-assign": 2,
	"no-debugger": 2,
	"no-dupe-keys": 2,
	"no-duplicate-case": 2,
	"no-empty-character-class": 2,
	"no-unreachable": 2,
	"no-unsafe-negation": 2,
	radix: 2,
	"valid-typeof": 2,
	"no-implicit-globals": [2],
	"no-unused-expressions": [
		2,
		{allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true},
	],
	"no-empty": [2, {allowEmptyCatch: false}],
	"no-proto": 2,

	// es2015 features
	"require-yield": 2,
	"template-curly-spacing": [2, "never"],

	// spacing details
	"space-infix-ops": 2,
	"space-in-parens": [2, "never"],
	"array-bracket-spacing": [2, "never"],
	"comma-spacing": [2, {before: false, after: true}],
	"keyword-spacing": [
		2,
		{
			overrides: {
				if: {after: true},
				else: {after: true},
				for: {after: true},
				while: {after: true},
				do: {after: true},
				switch: {after: true},
				return: {after: true},
			},
		},
	],
  "space-before-function-paren": [
    2,
    {
      anonymous: "never",
      named: "never",
      asyncArrow: "always",
    },
  ],
  "no-whitespace-before-property": 2,
	"arrow-spacing": [
		2,
		{
			after: true,
			before: true,
		},
	],
	"@stylistic/function-call-spacing": 2,
	"@stylistic/type-annotation-spacing": 2,

	// import rules
	// Prevent .js/.ts extensions in relative imports (which cause test failures with esbuild-register)
	// This uses no-restricted-syntax since import/extensions doesn't cleanly support this use case
	"no-restricted-syntax": [
		2,
		{
			selector: "ImportDeclaration[source.value=/^\\..*\\.js$/]",
			message: "Do not use .js extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.js'). This causes MODULE_NOT_FOUND errors in tests.",
		},
		{
			selector: "ImportDeclaration[source.value=/^\\..*\\.ts$/]",
			message: "Do not use .ts extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.ts').",
		},
		{
			selector: "CallExpression[callee.name='setTimeout']",
			message: "Use Timer.setTimeout() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
		},
		{
			selector: "CallExpression[callee.name='setInterval']",
			message: "Use Timer.setInterval() instead. Import { Timer, defaultTimer } from 'utils/SystemTimer'.",
		},
		{
			// Reading a payload field off an MCP envelope's `structuredContent`
			// (e.g. `response.structuredContent.found`) is the #2907 dead-read
			// foot-gun: only `success`/`error` are hoisted, and a field name that
			// isn't there is a silent `undefined`. Route reads through the typed
			// seam so the intent is explicit and the miss surfaces.
			selector: "MemberExpression[object.property.name='structuredContent']",
			message: "Do not read a field off `structuredContent` directly. Use getStructuredField(response, key) for one field or getStructuredPayload(response) for the whole payload. Import from 'utils/toolUtils' (issue #2907).",
		},
	],

	// file whitespace
	"no-multiple-empty-lines": [2, {max: 2, maxEOF: 0}],
	"no-mixed-spaces-and-tabs": 2,
	"no-trailing-spaces": 2,
	"linebreak-style": [process.platform === "win32" ? 0 : 2, "unix"],
	indent: [
		2,
		2,
		{SwitchCase: 1, CallExpression: {arguments: "first"}, MemberExpression: 1},
	],
	"key-spacing": [
		2,
		{
			beforeColon: false,
		},
	],
	"eol-last": 2,
};

const languageOptions = {
	parser: tsParser,
	ecmaVersion: 9,
	sourceType: "module",
};

export default [
	{
    ignores: ["ios/**/*", "android/**/*", "scratch/**/*"],
  },
  {
		files: ["**/*.ts"],
		plugins,
		languageOptions,
		rules: baseRules,
	},
	{
		files: ["src/**/*.ts"],
		plugins,
		languageOptions,
		rules: {
			"auto-mobile/catch-convention": 2,
			"auto-mobile/no-unknown-cast": 2,
			"no-restricted-properties": [
				"error",
				{
					object: "Math",
					property: "random",
					message: "Use an injected Random or IdGenerator. Math.random() makes production behavior non-deterministic and bypasses the project's test seams.",
				},
			],
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["lodash", "lodash/*"],
							message: "Prefer the JavaScript/Node standard library or an existing AutoMobile helper. Do not add a direct lodash dependency.",
						},
					],
				},
			],
		},
	},
	{
		// Stage 1 of the move toward declarative style (PR #3957). Enforced as
		// errors on src/ only; pre-existing violations are captured in
		// eslint-suppressions.json so this gates NEW code without a big-bang
		// rewrite. Thresholds start loose and ratchet down as the baseline is
		// burned down — see the "Lint suppressions baseline" section in CLAUDE.md.
		//
		// The forEach ban lives in its own `auto-mobile/no-accumulator-foreach`
		// rule rather than in `no-restricted-syntax` on purpose. Bulk suppressions
		// are keyed per file + per RULE and are only a count, so folding these into
		// no-restricted-syntax would let a baselined forEach be traded for a banned
		// setTimeout/structuredContent read with no CI failure — silently weakening
		// guards that main enforces absolutely (main has zero no-restricted-syntax
		// suppressions). A separate rule keeps those budgets from mixing, and also
		// survives the `...baseRules` spreads in the overrides below, which replace
		// the whole no-restricted-syntax entry.
		files: ["src/**/*.ts"],
		plugins,
		languageOptions,
		rules: {
			"max-depth": ["error", 4],
			"complexity": ["error", 15],
			// The deepest callback nest in src/ is currently 3, so 3 is the tightest
			// cap that still baselines clean; 4 would have no bite.
			"max-nested-callbacks": ["error", 3],
			"auto-mobile/no-accumulator-foreach": 2,
		},
	},
	{
		// Type-aware rules for src only (tsconfig.json includes `src`). These
		// catch the fire-and-forget promise class (#3588 ffmpeg pipe, #3593
		// eviction) at the source — an un-awaited/un-caught promise — which no
		// syntactic rule and no bun-test unhandledRejection trap can reliably do.
		files: ["src/**/*.ts"],
		plugins,
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 9,
			sourceType: "module",
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Only non-auto-fixable rules here: the repo lint command is
			// `eslint . --fix`, and an auto-fixable type-aware rule (e.g.
			// no-unnecessary-type-assertion) would MUTATE src on every CI run —
			// suppressions gate reporting, not fixing — orphaning imports. The
			// #3595 unnecessary-cast class is already covered syntactically by
			// auto-mobile/no-unknown-cast.
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},
	{
		// Navigation hierarchy logic is correctness-sensitive: screen
		// fingerprinting drives navigation-graph dedup and element extraction
		// drives Explore, so a wrong field name silently produces a wrong
		// fingerprint/hash. Ban the `any` escape hatch in these files so the
		// typed ViewHierarchyResult / AccessibilityNode model is always used and
		// the #1122-style carry-over regression cannot recur. Genuine boundaries
		// must opt out with an inline
		// `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.
		// (Other navigation files still carry pre-existing `any`; broadening the
		// scope to the full directory is a follow-up once those are migrated.)
		files: [
			"src/features/navigation/ScreenFingerprint.ts",
			"src/features/navigation/ExploreElementExtraction.ts",
		],
		plugins,
		languageOptions,
		rules: {
			...baseRules,
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
        files: ["test/**/*.ts", "**/scratch/**/*.ts"],
		plugins,
		languageOptions,
		rules: {
			...baseRules,
			"no-unused-expressions": "off",
		},
	},
	{
		files: ["**/*.generated.ts", "**/generated/**/*.ts", "**/*.d.ts"],
		plugins,
		languageOptions,
		rules: {
			...baseRules,
			"no-mixed-spaces-and-tabs": "off",
		},
	},
	{
		// SystemTimer.ts is the implementation that wraps raw setTimeout/setInterval
		files: ["**/SystemTimer.ts"],
		plugins,
		languageOptions,
		rules: {
			...baseRules,
			"no-restricted-syntax": [
				2,
				{
					selector: "ImportDeclaration[source.value=/^\\..*\\.js$/]",
					message: "Do not use .js extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.js'). This causes MODULE_NOT_FOUND errors in tests.",
				},
				{
					selector: "ImportDeclaration[source.value=/^\\..*\\.ts$/]",
					message: "Do not use .ts extension in relative imports. Use extensionless imports instead (e.g., './foo' not './foo.ts').",
				},
				// setTimeout/setInterval rules intentionally omitted - this file wraps them
			],
		},
	},
];
