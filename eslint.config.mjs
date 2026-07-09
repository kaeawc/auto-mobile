import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import stylistic from "@stylistic/eslint-plugin";
import importRules from "eslint-plugin-import";
import path from "node:path";

const catchConventionAllowlist = new Set([
	"src/daemon/client.ts:150:fallback",
	"src/daemon/daemonFiles.ts:144:fallback",
	"src/daemon/daemonFiles.ts:153:fallback",
	"src/daemon/manager.ts:71:fallback",
	"src/daemon/manager.ts:1173:fallback",
	"src/daemon/socketServer.ts:1658:fallback",
	"src/daemon/socketServer/BaseSocketServer.ts:107:fallback",
	"src/daemon/socketServer/BaseSocketServer.ts:231:fallback",
	"src/features/action/InstallApp.ts:137:fallback",
	"src/features/action/TapAnyElement.ts:138:fallback",
	"src/features/action/TerminateApp.ts:111:fallback",
	"src/features/observe/android/AndroidSdkEventIngestor.ts:347:fallback",
	"src/features/preferences/AppPreferences.ts:245:fallback",
	"src/features/utility/system-configuration/IosLockdownLocaleClient.ts:95:fallback",
	"src/features/utility/system-configuration/IosSystemConfigurationAdapter.ts:293:fallback",
	"src/features/video/FfmpegVideoProcessingBackend.ts:105:fallback",
	"src/server/appFileService.ts:778:fallback",
	"src/server/systemTrayHelpers.ts:280:fallback",
	"src/utils/AppLifecycleMonitor.ts:135:fallback",
	"src/utils/ChildProcessTracker.ts:159:fallback",
	"src/utils/DeviceSnapshotStore.ts:66:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:208:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:267:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:567:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:617:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:635:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:653:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:765:fallback",
	"src/utils/IOSCtrlProxyBuilder.ts:851:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1382:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1410:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1483:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1555:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1828:fallback",
	"src/utils/IOSCtrlProxyManager.ts:1841:fallback",
	"src/utils/IOSCtrlProxyManager.ts:2067:fallback",
	"src/utils/IOSCtrlProxyManager.ts:2085:fallback",
	"src/utils/IOSCtrlProxyManager.ts:2522:fallback",
	"src/utils/IOSCtrlProxyManager.ts:2538:fallback",
	"src/utils/android-cmdline-tools/detection.ts:206:fallback",
	"src/utils/android-cmdline-tools/detection.ts:220:fallback",
	"src/utils/android-cmdline-tools/readAndroidDeviceApiLevel.ts:21:fallback",
	"src/utils/deviceUtils.ts:114:fallback",
	"src/utils/dockerEnv.ts:12:fallback",
	"src/utils/envBootstrap.ts:130:fallback",
	"src/utils/fileLock.ts:129:fallback",
	"src/utils/fileLock.ts:182:fallback",
	"src/utils/fileLock.ts:216:fallback",
	"src/utils/fileLock.ts:255:fallback",
	"src/utils/filesystem/DefaultFileSystem.ts:10:fallback",
	"src/utils/hostAppearance.ts:21:fallback",
	"src/utils/image/webp/WebpBinaryResolver.ts:258:fallback",
	"src/utils/ios-cmdline-tools/DeviceAppManager.ts:419:fallback",
	"src/utils/ios-cmdline-tools/SimCtlClient.ts:492:fallback",
	"src/utils/ios-cmdline-tools/XcodebuildClient.ts:95:fallback",
	"src/utils/ios/IOSCtrlProxyHealthClient.ts:68:fallback",
	"src/utils/ios/IOSCtrlProxyHealthClient.ts:92:fallback",
	"src/utils/ios/IOSCtrlProxyHealthClient.ts:126:fallback",
	"src/utils/logPruner.ts:72:fallback",
	"src/utils/mcpVersion.ts:59:fallback",
	"src/utils/mcpVersion.ts:74:fallback",
	"src/utils/mcpVersion.ts:90:fallback",
	"src/utils/plan/PlanExecutor.ts:150:fallback",
	"src/utils/plan/PlanExecutor.ts:487:status",
	"src/utils/plan/PlanExecutor.ts:507:status",
]);

function relativeLintPath(filename) {
	return path.relative(process.cwd(), filename).replace(/\\/g, "/");
}

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

function isAllowed(context, node, kind) {
	const key = `${relativeLintPath(context.filename)}:${node.loc.start.line}:${kind}`;
	return catchConventionAllowlist.has(key);
}

function catchConventionRule() {
	return {
		meta: {
			type: "problem",
			messages: {
				fallbackReturn: "Catch blocks that return a fallback must log the caught error before returning.",
				statusReturn: "Catch blocks that return a typed failure/status object must log at warn, not debug.",
			},
		},
		create(context) {
			function reportStatusReturnsWithoutWarn(statements, hasPriorWarn) {
				for (const statement of statements) {
					if (hasLoggerMethodCall(statement, "warn")) {
						hasPriorWarn = true;
					}
					if (statement.type === "ReturnStatement" && isStatusObjectReturn(statement.argument) && !hasPriorWarn && !isAllowed(context, statement, "status")) {
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
					if (statements.length === 1 && statements[0].type === "ReturnStatement" && isFallbackReturn(statements[0].argument) && !hasAnyLoggerCall(node.body) && !isAllowed(context, statements[0], "fallback")) {
						context.report({ node: statements[0], messageId: "fallbackReturn" });
					}
					reportStatusReturnsWithoutWarn(statements, false);
				},
			};
		},
	};
}

const catchConventionPlugin = {
	rules: {
		"catch-convention": catchConventionRule(),
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
