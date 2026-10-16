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

/** MCP server name the harness registers; tool names arrive as `mcp__auto-mobile__<tool>`. */
export const MCP_SERVER_NAME = "auto-mobile";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const DEFAULT_TIMEOUT_SECONDS = 900;

const baselineSchema = z
  .object({
    totalToolCalls: z.number().int().nonnegative().optional(),
    mcpToolCalls: z.number().int().nonnegative().optional(),
    toolErrors: z.number().int().nonnegative().optional(),
    numTurns: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    wallClockSeconds: z.number().nonnegative().optional(),
    tools: z.record(z.number().int().nonnegative()).optional(),
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
      .refine((args) => !args.some((arg) => arg === "--model" || arg.startsWith("--model=")), {
        message: "set claude.model (or pass --model on the command line), not --model in extraArgs",
      }),
  })
  .strict();

const suiteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits, and dashes"),
    platform: z.literal("android"),
    prompt: z.string().min(1),
    app: z
      .object({ packageName: z.string().min(1), apkPath: z.string().min(1).optional() })
      .strict(),
    preflight: z
      .object({
        clearAppData: z.boolean().default(true),
        sharedPreferences: z
          .record(
            z.string().regex(/^[A-Za-z0-9_.-]+$/, "preference file names are plain identifiers"),
            z.record(z.union([z.boolean(), z.number(), z.string()])),
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
  .strict();

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
