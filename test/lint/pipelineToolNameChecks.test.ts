import {
  typeScriptFiles,
  relativePosix,
  readGuardFile,
  parseGuardSource,
  GuardVisitor as Visitor,
  guardTextMayMatch,
} from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";

/**
 * #11825: per-tool behavior belongs on the tool definition (`ToolTraits`), not in tool-name
 * lists or `name === "<tool>"` branches inside the call pipeline. A `*_TOOLS` declaration under
 * `src/server/pipeline/` fails outright; the inline tool-name comparisons that remain are pinned
 * per file and may only shrink: lower a count in the PR that moves its branch onto a trait.
 */
const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const PIPELINE_DIR = path.join(REPO_ROOT, "src", "server", "pipeline");
const SRC_DIR = path.join(REPO_ROOT, "src");
const TOOL_LIST_NAME = /_TOOLS$/;
// Parsing the pipeline tree can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

const REMAINING_TOOL_NAME_CHECKS: Readonly<Record<string, number>> = {
  "src/server/pipeline/afterToolCall.ts": 2,
  "src/server/pipeline/deviceCallDispatch.ts": 2,
  "src/server/pipeline/executionTarget.ts": 1,
  "src/server/pipeline/ingress/acquisition.ts": 3,
  "src/server/pipeline/ingress/bindSession.ts": 1,
  "src/server/pipeline/ingress/invoke.ts": 2,
  "src/server/pipeline/navigationRecording.ts": 1,
  "src/server/pipeline/planLifecycle.ts": 3,
};

type Node = { type: string; [key: string]: unknown };

function toolLiteral(node: unknown, tools: ReadonlySet<string>): boolean {
  const n = node as Node | undefined;
  return n?.type === "Literal" && typeof n.value === "string" && tools.has(n.value);
}

/** `x === "<tool>"` comparisons and `case "<tool>":` labels, plus `*_TOOLS` declarations. */
export function scanToolNameChecks(
  file: string,
  source: string,
  tools: ReadonlySet<string>,
): { comparisons: number; toolLists: string[] } {
  let comparisons = 0;
  const toolLists: string[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (
        ["===", "!==", "==", "!="].includes(node.operator) &&
        (toolLiteral(node.left, tools) || toolLiteral(node.right, tools))
      ) {
        comparisons += 1;
      }
    },
    SwitchCase(node) {
      if (toolLiteral(node.test, tools)) {
        comparisons += 1;
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && TOOL_LIST_NAME.test(node.id.name)) {
        toolLists.push(node.id.name);
      }
    },
  }).visit(parseGuardSource(file, source));
  return { comparisons, toolLists };
}

function registeredToolNames(): Set<string> {
  const defs = JSON.parse(readGuardFile(path.join(REPO_ROOT, "schemas/tool-definitions.json"))) as {
    name: string;
  }[];
  return new Set(defs.map((def) => def.name));
}

describe("pipeline tool-name check guard", () => {
  let counts: Record<string, number>;
  let toolLists: string[];
  beforeAll(() => {
    const tools = registeredToolNames();
    counts = {};
    toolLists = [];
    for (const file of typeScriptFiles(PIPELINE_DIR)) {
      const relative = relativePosix(REPO_ROOT, file);
      const scan = scanToolNameChecks(relative, readGuardFile(file), tools);
      if (scan.comparisons > 0) {
        counts[relative] = scan.comparisons;
      }
      toolLists.push(...scan.toolLists.map((name) => `${relative}\t${name}`));
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("detector counts tool-name comparisons, cases and *_TOOLS declarations only", () => {
    const tools = new Set(["tapAt", "observe"]);
    const source = [
      'if (name === "tapAt") {}',
      'if ("observe" !== toolName) {}',
      'switch (name) { case "tapAt": break; case "other": break; }',
      'if (name === "notATool") {}',
      'const label = "tapAt";',
      'const LIFECYCLE_TOOLS = new Set(["tapAt"]);',
      "const TOOLS_SEEN = 1;",
    ].join("\n");
    expect(scanToolNameChecks("x.ts", source, tools)).toEqual({
      comparisons: 3,
      toolLists: ["LIFECYCLE_TOOLS"],
    });
  });

  test("no *_TOOLS name list lives in the pipeline", () => {
    expect(toolLists, "Declare the behavior as a ToolTraits field instead.").toEqual([]);
  });

  test("tool-name comparisons do not grow", () => {
    const grown = Object.entries(counts).filter(
      ([file, count]) => count > (REMAINING_TOOL_NAME_CHECKS[file] ?? 0),
    );
    expect(grown, "Move the branch onto a ToolTraits field instead of naming the tool.").toEqual(
      [],
    );
  });

  test("the remaining counts are tight, so moving a check must lower them", () => {
    expect(counts).toEqual(REMAINING_TOOL_NAME_CHECKS);
  });
});

/**
 * #15672: outside the pipeline, per-tool behaviour also belongs on the tool definition. These are the
 * `*_TOOLS` declarations that stay, each for a stated reason; any other one fails. Lists naming the
 * hidden `startDevice` cannot become `_meta` traits, because the generated definitions omit hidden
 * tools.
 */
const EXEMPT_TOOL_LISTS: Readonly<Record<string, string>> = {
  "src/daemon/deviceSessionResult.ts\tDEVICE_SESSION_ACQUISITION_TOOLS": "names hidden startDevice",
  "src/daemon/sessionBroker/lifecycleTools.ts\tBROKER_LIFECYCLE_TOOLS": "names hidden startDevice",
  "src/daemon/socketRequestAdmission.ts\tSOCKET_ROUTING_MUTATING_TOOLS": "names hidden startDevice",
  "src/models/deviceSessionRecovery.ts\tDEVICE_SESSION_RECOVERY_TOOLS":
    "what recovery guidance tells a client to call, pinned to the registry by a test",
  "src/server/deviceMutationLifecycleAdapters.ts\tAPP_FALLBACK_TOOLS":
    "the vocabulary of an opaque fallback key prefix, not a behaviour list",
  "src/server/watchOsToolSupport.ts\tWATCHOS_SUPPORTED_TOOLS":
    "a policy allow-list documented in docs/decisions/watchos-platform.md",
  "src/utils/android-cmdline-tools/detection.ts\tANDROID_TOOLS":
    "Android SDK command-line tools, not MCP tools",
  "src/utils/plan/coordinationTools.ts\tCOORDINATION_TOOLS":
    "plan code specific to barrier/criticalSection; src/utils cannot read the registry or schemas",
  "src/utils/removedTools.ts\tREMOVED_TOOLS": "names of tools that no longer exist",
};

describe("tool-name lists outside the pipeline (#15672)", () => {
  let toolLists: string[];
  beforeAll(() => {
    const tools = registeredToolNames();
    toolLists = typeScriptFiles(SRC_DIR)
      .filter((file) => !file.startsWith(PIPELINE_DIR + path.sep))
      .flatMap((file) => {
        const source = readGuardFile(file);
        if (!guardTextMayMatch(source, "_TOOLS")) {
          return [];
        }
        const relative = relativePosix(REPO_ROOT, file);
        return scanToolNameChecks(relative, source, tools).toolLists.map(
          (name) => `${relative}\t${name}`,
        );
      })
      .sort();
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("every *_TOOLS declaration outside the pipeline is a named exemption", () => {
    expect(
      toolLists.filter((entry) => !Object.hasOwn(EXEMPT_TOOL_LISTS, entry)),
      "Declare the behaviour as a ToolTraits field, or add a reasoned exemption.",
    ).toEqual([]);
  });

  test("the exemption list is tight, so a removed list must leave it", () => {
    expect(Object.keys(EXEMPT_TOOL_LISTS).sort()).toEqual(toolLists);
  });
});
