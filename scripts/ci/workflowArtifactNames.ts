// Structural extractor of the artifact names a GitHub Actions workflow uploads,
// for test/bats/workflow-artifact-name-uniqueness.bats (#14578, #14580).
//
// upload-artifact v4+ fails a run that uploads the same artifact name twice, so
// the guard needs every upload a workflow run performs. That includes uploads
// nested in local composite actions (`uses: ./.github/actions/...`): those land
// in the caller's artifact namespace once per invocation, so they are expanded
// at every call site rather than recorded once per action.
//
// Names are compared as templates, not evaluated. Per invocation the extractor
// resolves `${{ github.job }}` to the calling job id and a bare
// `${{ inputs.<name> }}` to the caller's `with:` value (or the input default).
// A composite name that still depends on its inputs or step outputs after that
// gets the inputs it reads appended, so two invocations with the same inputs
// collide and two with different inputs do not.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ArtifactUpload {
  job: string;
  name: string;
}

/** Returns the action.yml text for a local `./...` action reference. */
export type LocalActionLoader = (ref: string) => string;

type YamlMap = Record<string, unknown>;

interface Scope {
  job: string;
  /** Effective inputs of the composite being expanded; undefined at workflow level. */
  inputs?: Record<string, string>;
  /** Composite steps, so `steps.<id>` references can be traced to inputs. */
  steps?: YamlMap[];
}

interface Expansion {
  loadAction: LocalActionLoader;
  stack: string[];
}

const UPLOAD_ACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Default names per actions/upload-artifact's action.yml files.
  [/^actions\/upload-artifact\/merge(@|$)/, "merged-artifacts"],
  [/^actions\/upload-artifact(@|$)/, "artifact"],
];
const EXPRESSION = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
const INPUT_REF = /\binputs\.([A-Za-z0-9_-]+)/g;
const STEP_REF = /\bsteps\.([A-Za-z0-9_-]+)/g;

function isMap(value: unknown): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stepsOf(value: unknown): YamlMap[] {
  return Array.isArray(value) ? value.filter(isMap) : [];
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function substitute(text: string, scope: Scope): string {
  return text.replace(EXPRESSION, (whole, expr: string) => {
    if (expr === "github.job") {
      return scope.job;
    }
    const input = /^inputs\.([A-Za-z0-9_-]+)$/.exec(expr);
    if (input && scope.inputs && input[1] in scope.inputs) {
      return scope.inputs[input[1]];
    }
    return whole;
  });
}

/** Inputs an unresolved composite expression reads, directly or via step outputs. */
function inputsReadBy(text: string, scope: Scope): string[] {
  const read = new Set<string>();
  const seenSteps = new Set<string>();
  const pending = [text];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    matches(current, INPUT_REF).forEach((name) => read.add(name));
    for (const id of matches(current, STEP_REF).filter((stepId) => !seenSteps.has(stepId))) {
      seenSteps.add(id);
      const step = scope.steps?.find((candidate) => candidate.id === id);
      if (step) {
        pending.push(JSON.stringify(step));
      } else {
        // An untraceable step output may depend on any input.
        Object.keys(scope.inputs ?? {}).forEach((name) => read.add(name));
      }
    }
  }
  return [...read].sort();
}

function artifactName(raw: string, scope: Scope): string {
  const name = substitute(raw, scope);
  if (!scope.inputs) {
    return name;
  }
  const unresolved = matches(name, EXPRESSION).join("\n");
  const read = inputsReadBy(unresolved, scope);
  if (read.length === 0) {
    return name;
  }
  const inputs = Object.fromEntries(read.map((key) => [key, scope.inputs?.[key] ?? ""]));
  return `${name} [inputs ${JSON.stringify(inputs)}]`;
}

function effectiveInputs(action: YamlMap, given: YamlMap, scope: Scope): Record<string, string> {
  const declared = isMap(action.inputs) ? action.inputs : {};
  const names = new Set([...Object.keys(declared), ...Object.keys(given)]);
  return Object.fromEntries(
    [...names].map((name) => {
      const spec = declared[name];
      if (name in given) {
        return [name, substitute(stringify(given[name]), scope)];
      }
      return [name, isMap(spec) && "default" in spec ? stringify(spec.default) : ""];
    }),
  );
}

function expandLocalAction(
  ref: string,
  given: YamlMap,
  scope: Scope,
  expansion: Expansion,
): ArtifactUpload[] {
  if (expansion.stack.includes(ref)) {
    throw new Error(`local action cycle: ${[...expansion.stack, ref].join(" -> ")}`);
  }
  const action: unknown = Bun.YAML.parse(expansion.loadAction(ref));
  const runs = isMap(action) && isMap(action.runs) ? action.runs : {};
  if (!isMap(action) || runs.using !== "composite") {
    return [];
  }
  const steps = stepsOf(runs.steps);
  const inner: Scope = { job: scope.job, inputs: effectiveInputs(action, given, scope), steps };
  const nested = { ...expansion, stack: [...expansion.stack, ref] };
  return steps.flatMap((step) => uploadsOfStep(step, inner, nested));
}

function uploadsOfStep(step: YamlMap, scope: Scope, expansion: Expansion): ArtifactUpload[] {
  const uses = typeof step.uses === "string" ? step.uses.trim() : "";
  const given = isMap(step.with) ? step.with : {};
  const upload = UPLOAD_ACTIONS.find(([pattern]) => pattern.test(uses));
  if (upload) {
    const raw = "name" in given ? stringify(given.name) : upload[1];
    return [{ job: scope.job, name: artifactName(raw, scope) }];
  }
  if (uses.startsWith("./")) {
    return expandLocalAction(uses.replace(/\/+$/, ""), given, scope, expansion);
  }
  return [];
}

/**
 * Every artifact upload one run of the workflow performs, in step order, with
 * local composite actions expanded at each call site. Jobs that call a reusable
 * workflow (`jobs.<id>.uses`) have no steps and contribute nothing.
 */
export function extractArtifactUploads(
  workflowText: string,
  loadAction: LocalActionLoader,
): ArtifactUpload[] {
  const workflow: unknown = Bun.YAML.parse(workflowText);
  const jobs = isMap(workflow) && isMap(workflow.jobs) ? workflow.jobs : {};
  const expansion: Expansion = { loadAction, stack: [] };
  return Object.entries(jobs).flatMap(([job, body]) =>
    stepsOf(isMap(body) ? body.steps : undefined).flatMap((step) =>
      uploadsOfStep(step, { job }, expansion),
    ),
  );
}

export function fileActionLoader(root: string): LocalActionLoader {
  return (ref) => {
    const candidates = ["action.yml", "action.yaml"].map((file) => join(root, ref, file));
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      throw new Error(`local action ${ref} has no action.yml under ${root}`);
    }
    return readFileSync(found, "utf8");
  };
}

/**
 * `WORKFLOW...` -> one `<workflow>\t<job>\t<artifact name>` line per upload.
 * Local actions resolve against `root`, as GitHub resolves them against the
 * checked-out workspace.
 */
export function formatCli(files: readonly string[], root: string): string {
  const loadAction = fileActionLoader(root);
  return files
    .flatMap((file) =>
      extractArtifactUploads(readFileSync(file, "utf8"), loadAction).map(
        (upload) => `${file}\t${upload.job}\t${upload.name}\n`,
      ),
    )
    .join("");
}

if (import.meta.main) {
  process.stdout.write(formatCli(process.argv.slice(2), process.cwd()));
}
