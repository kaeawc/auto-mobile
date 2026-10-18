/**
 * Suite configuration for the agent UI benchmark harness.
 *
 * A suite is a YAML file under `benchmark/agent/suites/` that points at a Markdown
 * prompt, names the app and device preflight, configures the Claude Code invocation,
 * and optionally records a comparison baseline. Unknown keys fail fast so a typo
 * cannot silently change what a run measures.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../src/utils/androidPackageName";

/** MCP server name the harness registers; tool names arrive as `mcp__auto-mobile__<tool>`. */
export const MCP_SERVER_NAME = "auto-mobile";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * Android stores <float> preferences as Float32. Non-integers are all below 2^53, so the
 * only loss to reject is underflow: a tiny nonzero value that would be stored as 0.
 */
function fitsFloat32(value: number): boolean {
  const stored = Math.fround(value);
  return Number.isFinite(stored) && (stored !== 0 || value === 0);
}

/** XML 1.0 forbids most C0 controls, U+FFFE/U+FFFF, and unpaired surrogates. */
const XML_ILLEGAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const xmlText = z.string().refine((text) => !XML_ILLEGAL.test(text), {
  message: "preference keys and strings must be valid XML text (no control characters)",
});

/** Longest delay setTimeout honors (2^31-1 ms); a larger one fires almost immediately. */
const MAX_TIMER_SECONDS = 2_147_483;

/** Shell tools every suite denies, so the agent cannot drive the device with raw adb. */
const ALWAYS_DENIED_TOOLS = ["Bash", "PowerShell"];

/** Text the oracle matches; a blank needle would match almost any screen or answer. */
const needle = z.string().refine((value) => value.trim() !== "", "must not be blank");

/**
 * A baseline count: a non-negative safe integer. Past 2^53 YAML has already rounded the value,
 * so the baseline and every delta against it would be wrong.
 */
const count = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a safe integer (at most 2^53 - 1)");

const baselineSchema = z
  .object({
    totalToolCalls: count.optional(),
    mcpToolCalls: count.optional(),
    toolErrors: count.optional(),
    numTurns: count.optional(),
    costUsd: z.number().finite().nonnegative().optional(),
    wallClockSeconds: z.number().finite().nonnegative().optional(),
    tools: z.record(count).optional(),
    /** The preflight app fingerprint the baseline was recorded against. */
    appBuild: z.string().min(1).optional(),
    /** SHA-256 prefix of the AutoMobile server bundle (`dist/src/index.js`) the run used. */
    serverBuild: z.string().min(1).optional(),
    /** Digest of the prompt and suite settings the baseline was recorded with. */
    suiteDigest: z.string().min(1).optional(),
    /** The model Claude reported running (stream-json init), not the requested selector. */
    observedModel: z.string().min(1).optional(),
    /** `claude --version` the baseline was recorded with. */
    claudeCodeVersion: z.string().min(1).optional(),
    /** SDK level, model, locale, screen size, and density of the device. */
    deviceFingerprint: z.string().min(1).optional(),
  })
  .strict();

// The tool lists follow a variadic flag, so an entry like "--settings" would be parsed as
// its own Claude option and could undo run isolation.
const toolRule = z
  .string()
  .min(1)
  .refine((rule) => !rule.startsWith("-"), "a tool rule cannot start with '-'");

const claudeSchema = z
  .object({
    model: z.string().min(1).optional(),
    appendSystemPrompt: z.string().optional(),
    allowedTools: z.array(toolRule).default([`mcp__${MCP_SERVER_NAME}`]),
    // Shell tools are always denied: raw adb would bypass the MCP server being measured.
    // PowerShell counts too (Claude Code can enable it alongside a Bash deny). A suite's own
    // list adds to them rather than replacing them.
    disallowedTools: z
      .array(toolRule)
      .default([])
      .transform((tools) => [
        ...ALWAYS_DENIED_TOOLS.filter((tool) => !tools.includes(tool)),
        ...tools,
      ]),
    maxBudgetUsd: z.number().finite().positive().optional(),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMER_SECONDS)
      .default(DEFAULT_TIMEOUT_SECONDS),
    // No free-form extra flags: any Claude flag can undo run isolation (--settings,
    // --resume, --plugin-dir, ...), so each supported knob gets its own typed field.
  })
  .strict();

const suiteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits, and dashes"),
    platform: z.literal("android"),
    prompt: z
      .string()
      .min(1)
      // CI classifies a Markdown-only change as docs and skips the Node tests, so a .md prompt
      // could change without the committed-suite guard ever loading it.
      .refine((path) => !/\.md$/i.test(path), "use a .txt prompt, not .md"),
    app: z
      .object({
        // Interpolated into adb shell commands, so it must be a real package name.
        packageName: z
          .string()
          .regex(
            ANDROID_PACKAGE_NAME_PATTERN,
            "use an Android package name such as com.example.app",
          ),
        apkPath: z.string().min(1).optional(),
      })
      .strict(),
    preflight: z
      .object({
        clearAppData: z.boolean().default(true),
        sharedPreferences: z
          .record(
            z.string().regex(/^[A-Za-z0-9_.-]+$/, "preference file names are plain identifiers"),
            z.record(
              xmlText,
              z.union([
                z.boolean(),
                // Android parses integers as int/long; beyond the safe range a JS number is
                // already imprecise and may serialize as 1e+21, which Android rejects.
                z
                  .number()
                  .finite()
                  .refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value), {
                    message: "integer preference values must be safe integers",
                  })
                  .refine((value) => Number.isInteger(value) || fitsFloat32(value), {
                    message: "non-integer preference values must fit Android's 32-bit float",
                  }),
                xmlText,
              ]),
            ),
          )
          .optional(),
        launchUri: z.string().min(1).optional(),
        settleSeconds: z.number().finite().nonnegative().max(MAX_TIMER_SECONDS).default(2),
        /** Text the app must show after settling; otherwise the run stops before Claude. */
        startScreenIncludes: z.array(needle).default([]),
      })
      .strict()
      .default({}),
    claude: claudeSchema.default({}),
    verify: z
      .object({
        answerIncludes: z.array(needle).default([]),
        screenIncludes: z.array(needle).default([]),
      })
      .strict()
      .default({}),
    failurePatterns: z.array(needle).default([]),
    ignoredFailurePatterns: z.array(needle).default([]),
    baseline: baselineSchema.optional(),
    baselineToolSequence: z.array(z.string().min(1)).optional(),
  })
  .strict()
  // The device screen is the oracle: an answer alone can be produced without ever touching
  // the app (or after only an inventory call such as listDevices).
  .refine((suite) => suite.verify.screenIncludes.length > 0, {
    message:
      "verify.screenIncludes needs at least one entry; without a device-backed check a run can pass without doing the task",
    path: ["verify", "screenIncludes"],
  });

export type SuiteBaseline = z.infer<typeof baselineSchema>;
export type SuiteDefinition = z.infer<typeof suiteSchema>;

export interface LoadedSuite {
  definition: SuiteDefinition;
  /** Absolute path of the suite YAML. */
  suitePath: string;
  /** Absolute path of the prompt file, resolved relative to the suite file. */
  promptPath: string;
  prompt: string;
  /** Absolute APK path, resolved relative to the repository root. */
  apkPath?: string;
}

export interface SuiteFs {
  readFile(path: string): string;
}

const realFs: SuiteFs = { readFile: (path) => readFileSync(path, "utf8") };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Validate an already-parsed YAML document. Throws with every issue on one line. */
export function parseSuiteDefinition(raw: unknown, source: string): SuiteDefinition {
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid agent benchmark suite ${source}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function loadSuite(suitePath: string, repoRoot: string, fs: SuiteFs = realFs): LoadedSuite {
  const absoluteSuitePath = resolve(suitePath);
  const definition = parseSuiteDefinition(load(fs.readFile(absoluteSuitePath)), absoluteSuitePath);
  const promptPath = resolve(dirname(absoluteSuitePath), definition.prompt);
  const prompt = fs.readFile(promptPath);
  if (prompt.trim().length === 0) {
    throw new Error(`Agent benchmark prompt ${promptPath} is empty`);
  }
  return {
    definition,
    suitePath: absoluteSuitePath,
    promptPath,
    prompt,
    apkPath: definition.app.apkPath ? resolve(repoRoot, definition.app.apkPath) : undefined,
  };
}

/** Short tool name: `mcp__auto-mobile__tapOn` → `tapOn`; built-in tools keep their name. */
export function shortToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
