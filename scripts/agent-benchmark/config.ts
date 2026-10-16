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

/** Claude flags that load an earlier conversation, which would contaminate a run. */
const SESSION_RESUME_FLAGS = ["--resume", "-r", "--continue", "-c", "--fork-session"];

function matchesFlag(arg: string, flags: readonly string[]): boolean {
  return flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Android stores <float> preferences as Float32. Non-integers are all below 2^53, so the
 * only loss to reject is underflow: a tiny nonzero value that would be stored as 0.
 */
function fitsFloat32(value: number): boolean {
  const stored = Math.fround(value);
  return Number.isFinite(stored) && (stored !== 0 || value === 0);
}

const baselineSchema = z
  .object({
    totalToolCalls: z.number().int().nonnegative().optional(),
    mcpToolCalls: z.number().int().nonnegative().optional(),
    toolErrors: z.number().int().nonnegative().optional(),
    numTurns: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    wallClockSeconds: z.number().nonnegative().optional(),
    tools: z.record(z.number().int().nonnegative()).optional(),
    /** The preflight app fingerprint the baseline was recorded against. */
    appBuild: z.string().min(1).optional(),
    /** Digest of the prompt and suite settings the baseline was recorded with. */
    suiteDigest: z.string().min(1).optional(),
  })
  .strict();

const claudeSchema = z
  .object({
    model: z.string().min(1).optional(),
    appendSystemPrompt: z.string().optional(),
    allowedTools: z.array(z.string().min(1)).default([`mcp__${MCP_SERVER_NAME}`]),
    disallowedTools: z.array(z.string().min(1)).default(["Bash"]),
    maxBudgetUsd: z.number().positive().optional(),
    timeoutSeconds: z.number().int().positive().default(DEFAULT_TIMEOUT_SECONDS),
    extraArgs: z
      .array(z.string())
      .default([])
      .refine((args) => !args.some((arg) => matchesFlag(arg, ["--model"])), {
        message: "set claude.model (or pass --model on the command line), not --model in extraArgs",
      })
      .refine((args) => !args.some((arg) => matchesFlag(arg, SESSION_RESUME_FLAGS)), {
        message: "extraArgs must not resume or continue a session; every run starts fresh",
      }),
  })
  .strict();

const suiteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits, and dashes"),
    platform: z.literal("android"),
    prompt: z.string().min(1),
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
                z.string(),
              ]),
            ),
          )
          .optional(),
        launchUri: z.string().min(1).optional(),
        settleSeconds: z.number().nonnegative().default(2),
      })
      .strict()
      .default({}),
    claude: claudeSchema.default({}),
    verify: z
      .object({
        answerIncludes: z.array(z.string().min(1)).default([]),
        screenIncludes: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
    failurePatterns: z.array(z.string().min(1)).default([]),
    ignoredFailurePatterns: z.array(z.string().min(1)).default([]),
    baseline: baselineSchema.optional(),
    baselineToolSequence: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((suite) => suite.verify.answerIncludes.length + suite.verify.screenIncludes.length > 0, {
    message:
      "verify needs at least one answerIncludes or screenIncludes entry; without one a run passes without doing the task",
    path: ["verify"],
  });

export type SuiteBaseline = z.infer<typeof baselineSchema>;
export type SuiteDefinition = z.infer<typeof suiteSchema>;

export interface LoadedSuite {
  definition: SuiteDefinition;
  /** Absolute path of the suite YAML. */
  suitePath: string;
  /** Absolute path of the prompt Markdown, resolved relative to the suite file. */
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
