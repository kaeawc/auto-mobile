import { beforeAll, describe, expect, it } from "bun:test";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { dump } from "js-yaml";
import fs from "fs";
import path from "path";
import { PlanSchemaValidator } from "../../src/utils/plan/PlanSchemaValidator";
import { migratePlan } from "../../src/utils/plan/PlanMigrator";

/**
 * Drift contract between `schemas/test-plan.schema.json` (hand-maintained: nothing generates
 * it) and the live tool input schemas advertised in `schemas/tool-definitions.json` (generated
 * from the tool registry's zod schemas). Plan YAML is schema-validated BEFORE any step runs, so
 * a plan-schema rule that rejects a valid tool call (or accepts a spelling the tool then
 * rejects) is a plan that cannot run (#10124, #10125).
 *
 * For EVERY tool in the registry this test builds a minimal valid call from the tool's real JSON
 * schema, then every single optional property at its boundary / branch values, and asserts the
 * plan schema accepts the step both inline (`{ tool, ...input }`) and under `params`. For the
 * tools the plan schema carries per-tool rules for, it also asserts that a wrong-typed value the
 * tool schema rejects is rejected by the plan schema, and that the plan schema declares no
 * property the tool does not have.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ToolDefinition {
  name: string;
  inputSchema: JsonObject;
}

interface Probe {
  label: string;
  input: JsonObject;
}

const repoRoot = path.resolve(__dirname, "../..");
const toolDefinitions = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "schemas/tool-definitions.json"), "utf8"),
) as ToolDefinition[];
const planSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "schemas/test-plan.schema.json"), "utf8"),
) as JsonObject;

/**
 * Minimal valid calls for tools whose runtime refinements are not expressed in the advertised
 * JSON schema (so the generic generator cannot build a runtime-valid call from it). Each entry
 * must still validate against the tool's JSON schema; the test fails otherwise.
 */
const MINIMAL_INPUT_OVERRIDES: Record<string, JsonObject> = {
  // zod superRefine: exactly one of `shape` or a selector (elementId/text).
  highlight: { elementId: "com.example:id/btn_login" },
  // zod refine: at least one device state field.
  setDeviceState: { connectivity: { airplaneMode: true } },
  // zod refine: at least one of permissions / notificationsEnabled / notificationPolicyAccess /
  // scheduleExactAlarm.
  setAppPermissions: { appId: "com.example.app", permissions: ["android.permission.CAMERA"] },
};

/**
 * DELIBERATE divergence 1: a plan step's `device` key is the multi-device LABEL (a string,
 * `planStep.properties.device`), so a tool whose own `device` parameter is an object cannot be
 * written as a plan step at all. The test asserts the tool's `device` is still not a string so
 * this list cannot go stale.
 */
const TOOLS_WITH_OBJECT_DEVICE_PARAM: Record<string, string> = {
  killDevice: "its required `device` is a { name, deviceId, platform } object",
  provisionDevice: "its required `device` is an image selector object",
};

interface ByDesignRejection {
  reason: string;
  matches: (value: Json | undefined) => boolean;
}

const OVER_SETTIMEOUT_RANGE: ByDesignRejection = {
  reason: "plan schema caps timeout at 2147483647 (setTimeout range); the tool schema does not",
  matches: (value) => typeof value === "number" && value > 2147483647,
};

const INTERNAL_LOCK_NAMESPACE: ByDesignRejection = {
  reason: "internal, injected by PlanExecutor; authored plans must never set it",
  matches: () => true,
};

/**
 * DELIBERATE divergence 2: tool-valid calls the plan schema rejects on purpose, keyed by tool then
 * by property; only values `matches` selects are exempt (so `action: grant` must still pass). The
 * test asserts each exempt probe really is rejected, so an entry cannot go stale.
 */
const EMPTY_OBJECT_REFINEMENT: ByDesignRejection = {
  reason:
    "the tool's zod refinement ('provide at least one field') is not expressed in its JSON schema, so {} looks valid there; the plan schema mirrors the refinement",
  matches: (value) => isObject(value) && Object.keys(value).length === 0,
};

const PLAN_REJECTS_BY_DESIGN: Record<string, Record<string, ByDesignRejection>> = {
  setDeviceState: { doNotDisturb: EMPTY_OBJECT_REFINEMENT, connectivity: EMPTY_OBJECT_REFINEMENT },
  barrier: { timeout: OVER_SETTIMEOUT_RANGE, __lockNamespace: INTERNAL_LOCK_NAMESPACE },
  criticalSection: { timeout: OVER_SETTIMEOUT_RANGE, __lockNamespace: INTERNAL_LOCK_NAMESPACE },
};

/**
 * DELIBERATE divergence 3: `deviceId` is accepted by every device tool but deliberately left out
 * of the advertised JSON schema (the executor injects it after device allocation; see
 * `addDeviceTargetingToSchema`), so the plan schema may declare it without the tool listing it.
 */
const INJECTED_UNADVERTISED = new Set(["deviceId"]);

/**
 * DELIBERATE divergence 4: legacy spellings the plan schema must still ACCEPT because it validates
 * the raw YAML before `PlanMigrator` rewrites it, but the live tool does not have. The migrator
 * renames each one (a test below proves it), so the tool never sees it. Keyed by tool.
 */
const MIGRATED_LEGACY_ALIASES: Record<string, Record<string, string>> = {
  highlight: { id: "elementId" },
};

/** Probe size cap for tools the plan schema has no per-tool rules for. */
const MAX_UNRULED_PROBE_CHARS = 400;

const MAX_DEPTH = 3;
/** Hard stop for self-referential required structures (e.g. the overlay node tree). */
const MAX_SAMPLE_DEPTH = 10;

const STRING_CANDIDATES = [
  "x",
  "com.example.app",
  "a1",
  "1",
  "https://example.com/a",
  "123e4567-e89b-42d3-a456-426614174000",
];

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    return schema;
  }
  let node: Json = root;
  for (const part of ref.slice(2).split("/")) {
    node = isObject(node) ? node[part] : null;
  }
  return isObject(node) ? resolveRef(node, root) : schema;
}

function numberSamples(schema: JsonObject): Json[] {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const exclusive =
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
  const low = minimum ?? (exclusive === undefined ? 1 : exclusive + 1);
  const high = typeof schema.maximum === "number" ? schema.maximum : undefined;
  return high === undefined || high === low ? [low] : [low, high];
}

function stringSamples(schema: JsonObject): Json[] {
  if (schema.format === "date-time") {
    return ["2026-01-01T00:00:00Z"];
  }
  const pattern = typeof schema.pattern === "string" ? new RegExp(schema.pattern) : undefined;
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 1;
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  const fit = STRING_CANDIDATES.map((c) => c.padEnd(minLength, c.at(-1))).find(
    (c) => c.length <= maxLength && (pattern === undefined || pattern.test(c)),
  );
  return fit === undefined ? [] : [fit];
}

function objectSample(schema: JsonObject, root: JsonObject, full: boolean, depth: number): Json {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: JsonObject = {};
  for (const [key, sub] of Object.entries(properties)) {
    const include = required.has(key) || (full && depth < MAX_DEPTH);
    const value =
      include && isObject(sub) ? sampleValues(sub, root, full, depth + 1)[0] : undefined;
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function typedSamples(schema: JsonObject, root: JsonObject, full: boolean, depth: number): Json[] {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "string") {
    return stringSamples(schema);
  }
  if (type === "number" || type === "integer") {
    return numberSamples(schema);
  }
  if (type === "boolean") {
    return [true];
  }
  if (type === "null") {
    return [null];
  }
  if (type === "array") {
    const items = isObject(schema.items) ? sampleValues(schema.items, root, full, depth + 1) : [];
    return [items.length > 0 ? [items[0]] : []];
  }
  if (type === "object" || isObject(schema.properties)) {
    const minimal = objectSample(schema, root, false, depth);
    return full ? [minimal, objectSample(schema, root, true, depth)] : [minimal];
  }
  return ["x"];
}

/** An object whose `anyOf`/`oneOf` branches only add `required` constraints (zod refinements). */
function requiredBranchSamples(
  schema: JsonObject,
  branches: Json[],
  root: JsonObject,
  full: boolean,
  depth: number,
): Json[] {
  const base = objectSample(schema, root, full, depth) as JsonObject;
  const properties = schema.properties as JsonObject;
  return branches.map((branch) => {
    const sample: JsonObject = { ...base };
    const required = isObject(branch) && Array.isArray(branch.required) ? branch.required : [];
    for (const key of required) {
      const sub = properties[String(key)];
      const value = isObject(sub) ? sampleValues(sub, root, full, depth + 1)[0] : undefined;
      if (value !== undefined) {
        sample[String(key)] = value;
      }
    }
    return sample;
  });
}

/** Candidate values for a (sub)schema: one per branch, boundaries for numbers. */
function sampleValues(
  raw: JsonObject,
  root: JsonObject,
  full: boolean,
  depth: number,
  all = false,
): Json[] {
  const schema = resolveRef(raw, root);
  if (depth > MAX_SAMPLE_DEPTH) {
    return [];
  }
  if (schema.const !== undefined) {
    return [schema.const];
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && isObject(schema.properties)) {
    const samples = requiredBranchSamples(
      schema,
      all ? branches : branches.slice(0, 1),
      root,
      full,
      depth,
    );
    return samples;
  }
  if (Array.isArray(branches)) {
    // Only a probe wants every branch; nested sampling takes the first, which keeps deeply nested
    // anyOf trees (the overlay spec) linear instead of exponential.
    return (all ? branches : branches.slice(0, 1)).flatMap((b) =>
      isObject(b) ? sampleValues(b, root, full, depth) : [],
    );
  }
  if (Array.isArray(schema.allOf) && isObject(schema.allOf[0])) {
    return sampleValues(schema.allOf[0], root, full, depth);
  }
  return typedSamples(schema, root, full, depth);
}

/** Tools the plan schema carries per-tool `if/then` rules for, with their `then` block. */
function planToolRules(): Map<string, JsonObject> {
  const defs = planSchema.$defs as JsonObject;
  const step = defs.planStep as JsonObject;
  const rules = new Map<string, JsonObject>();
  for (const entry of step.allOf as Json[]) {
    if (!isObject(entry) || !isObject(entry.if) || !isObject(entry.then)) {
      continue;
    }
    const properties = (entry.if.properties ?? {}) as JsonObject;
    const tool = isObject(properties.tool) ? properties.tool.const : undefined;
    if (typeof tool === "string") {
      rules.set(tool, entry.then);
    }
  }
  return rules;
}

/** Property names the plan schema declares for a tool, inline and in its params definition. */
function planDeclaredProps(tool: string): string[] {
  const rule = planToolRules().get(tool)!;
  const inlineProps = isObject(rule.properties) ? rule.properties : {};
  const paramsRef = isObject(inlineProps.params) ? inlineProps.params : {};
  const paramsDef = resolveRef(paramsRef, planSchema);
  const paramsProps = isObject(paramsDef.properties) ? paramsDef.properties : {};
  return [...new Set([...Object.keys(inlineProps), ...Object.keys(paramsProps)])].filter(
    (key) => key !== "params",
  );
}

function toolProperties(def: ToolDefinition): JsonObject {
  return isObject(def.inputSchema.properties) ? def.inputSchema.properties : {};
}

describe("plan schema vs live tool input schemas (#10124, #10125)", () => {
  let validator: PlanSchemaValidator;
  const toolValidators = new Map<string, ValidateFunction>();

  const planAccepts = (step: JsonObject): boolean =>
    validator.validateYaml(dump({ name: "contract", steps: [step] })).valid;
  const inline = (tool: string, input: JsonObject): JsonObject => ({ tool, ...input });
  const viaParams = (tool: string, input: JsonObject): JsonObject => ({ tool, params: input });

  beforeAll(async () => {
    validator = new PlanSchemaValidator();
    await validator.loadSchema();
    // Warm the plan schema compile so no test body pays for it (100ms/test budget).
    planAccepts({ tool: "observe" });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    addFormats(ajv as unknown as Parameters<typeof addFormats>[0]);
    for (const def of toolDefinitions) {
      toolValidators.set(def.name, ajv.compile(def.inputSchema));
    }
  });

  /**
   * Start from the schema's required properties, then add whatever the tool's own validator
   * reports missing (conditional requirements such as `appLifecycle` needing `appId`).
   */
  const generatedInput = (def: ToolDefinition): JsonObject => {
    const validate = toolValidators.get(def.name)!;
    const properties = toolProperties(def);
    const input = objectSample(def.inputSchema, def.inputSchema, false, 0) as JsonObject;
    for (let attempt = 0; attempt < 5 && !validate(input); attempt++) {
      const missing = (validate.errors ?? [])
        .filter((error) => error.keyword === "required" && error.instancePath === "")
        .map((error) => String(error.params.missingProperty));
      const additions = missing.filter((key) => isObject(properties[key]));
      if (additions.length === 0) {
        break;
      }
      for (const key of additions) {
        const value = sampleValues(properties[key] as JsonObject, def.inputSchema, false, 1)[0];
        if (value !== undefined) {
          input[key] = value;
        }
      }
    }
    return input;
  };

  const minimalInput = (def: ToolDefinition): JsonObject => {
    const override = MINIMAL_INPUT_OVERRIDES[def.name];
    if (override !== undefined) {
      return override;
    }
    const generated = generatedInput(def);
    const validate = toolValidators.get(def.name)!;
    if (!validate(generated)) {
      throw new Error(
        `${def.name}: no minimal valid input could be derived from its schema; add a MINIMAL_INPUT_OVERRIDES entry (${JSON.stringify(generated)} -> ${JSON.stringify(validate.errors)})`,
      );
    }
    return generated;
  };

  /** The minimal call, then each optional property at its sample values; tool-valid ones only. */
  const probeCalls = (def: ToolDefinition): Array<Probe & { key?: string; value?: Json }> => {
    const base = minimalInput(def);
    const required = new Set(
      Array.isArray(def.inputSchema.required) ? def.inputSchema.required : [],
    );
    const ruled = planToolRules().has(def.name);
    const calls: Array<Probe & { key?: string; value?: Json }> = [
      { label: "<minimal>", input: base },
    ];
    for (const [key, sub] of Object.entries(toolProperties(def))) {
      // Required properties are probed too (nested selectors). Tools without per-tool plan rules
      // take the generic open step shape, so only their small values are probed: sampling the
      // overlay spec tree costs seconds and could only exercise the generic rules anyway.
      if (!isObject(sub) || (required.has(key) && !ruled)) {
        continue;
      }
      for (const value of sampleValues(sub, def.inputSchema, true, 0, true)) {
        const label = `${key}=${JSON.stringify(value)}`;
        if (!ruled && label.length > MAX_UNRULED_PROBE_CHARS) {
          continue;
        }
        calls.push({ label, key, value, input: { ...base, [key]: value } });
      }
    }
    return calls.filter(({ input }) => toolValidators.get(def.name)!(input));
  };

  const isByDesign = (tool: string, key: string | undefined, value: Json | undefined): boolean =>
    key !== undefined && PLAN_REJECTS_BY_DESIGN[tool]?.[key]?.matches(value) === true;

  it("derives or overrides a minimal input that is valid for every tool's own schema", () => {
    const unresolved: string[] = [];
    for (const def of toolDefinitions) {
      try {
        expect(toolValidators.get(def.name)!(minimalInput(def))).toBe(true);
      } catch (error) {
        unresolved.push(String(error).slice(0, 400));
      }
    }
    expect(unresolved.join("\n")).toBe("");
  });

  it.each(
    toolDefinitions
      .filter((def) => TOOLS_WITH_OBJECT_DEVICE_PARAM[def.name] === undefined)
      .map((def) => [def.name, def] as const),
  )("%s: a valid call is a valid plan step, inline and under params", (_name, def) => {
    const failures: string[] = [];
    for (const { label, key, value, input } of probeCalls(def)) {
      if (isByDesign(def.name, key, value)) {
        continue;
      }
      if (!planAccepts(inline(def.name, input))) {
        failures.push(`inline rejected: ${label}`);
      }
      if (!planAccepts(viaParams(def.name, input))) {
        failures.push(`params rejected: ${label}`);
      }
    }
    expect(failures.join("\n")).toBe("");
  });

  it("keeps the by-design exceptions honest (each one still holds)", () => {
    const stale: string[] = [];
    for (const [tool, reason] of Object.entries(TOOLS_WITH_OBJECT_DEVICE_PARAM)) {
      const def = toolDefinitions.find((d) => d.name === tool)!;
      const device = toolProperties(def).device;
      if (isObject(device) && device.type === "string") {
        stale.push(`${tool}: device is a string now (${reason})`);
      }
    }
    for (const tool of Object.keys(PLAN_REJECTS_BY_DESIGN)) {
      const def = toolDefinitions.find((d) => d.name === tool)!;
      const designed = probeCalls(def).filter(({ key, value }) => isByDesign(tool, key, value));
      if (designed.length === 0) {
        stale.push(`${tool}: no probe matches its by-design entry`);
      }
      for (const { label, input } of designed) {
        if (planAccepts(inline(tool, input))) {
          stale.push(`${tool}: ${label} is accepted now`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("keeps the migrated legacy aliases honest: absent on the tool, accepted by the plan, renamed by the migrator", () => {
    const stale: string[] = [];
    for (const [tool, aliases] of Object.entries(MIGRATED_LEGACY_ALIASES)) {
      const def = toolDefinitions.find((d) => d.name === tool)!;
      const toolProps = toolProperties(def);
      for (const [alias, canonical] of Object.entries(aliases)) {
        if (toolProps[alias] !== undefined) {
          stale.push(`${tool}.${alias} is a real tool parameter now`);
        }
        if (toolProps[canonical] === undefined) {
          stale.push(`${tool}.${canonical} is not a tool parameter`);
        }
        const legacy = { [alias]: "com.example:id/btn" };
        for (const step of [inline(tool, legacy), viaParams(tool, legacy)]) {
          if (!planAccepts(step)) {
            stale.push(`${tool}: legacy ${alias} is rejected by the plan schema`);
          }
          const migrated = migratePlan({ name: "contract", steps: [step] }).plan.steps[0];
          if (migrated.params[canonical] !== "com.example:id/btn" || alias in migrated.params) {
            stale.push(`${tool}: ${alias} is not renamed to ${canonical} by the migrator`);
          }
          if (!toolValidators.get(tool)!(migrated.params)) {
            stale.push(`${tool}: the migrated ${alias} step is not valid for the tool`);
          }
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("accepts an inline highlight description the migrator leaves as a tool parameter", () => {
    const step = inline("highlight", { elementId: "x", description: "Login button" });
    expect(planAccepts(step)).toBe(true);
    expect(planDeclaredProps("highlight")).toContain("description");
    const migrated = migratePlan({ name: "contract", steps: [step] }).plan.steps[0];
    expect(migrated.params).toEqual({ elementId: "x", description: "Login button" });
    expect(migrated.label).toBeUndefined();
    expect(toolValidators.get("highlight")!(migrated.params)).toBe(true);
  });

  it("lists the tools the plan schema has per-tool rules for", () => {
    expect([...planToolRules().keys()].sort()).toEqual([
      "barrier",
      "criticalSection",
      "dragAndDrop",
      "getAppPermissions",
      "getDeviceState",
      "getNotificationPolicy",
      "highlight",
      "setAppPermissions",
      "setDeviceState",
      "setNotificationPolicy",
    ]);
  });

  it.each(
    toolDefinitions
      .filter((def) => planToolRules().has(def.name))
      .map((def) => [def.name, def] as const),
  )(
    "%s: plan-declared properties exist on the tool and wrong types are rejected alike",
    (_name, def) => {
      const toolProps = toolProperties(def);
      const declared = planDeclaredProps(def.name);
      const legacy = MIGRATED_LEGACY_ALIASES[def.name] ?? {};
      expect(
        declared.filter(
          (key) =>
            toolProps[key] === undefined &&
            !INJECTED_UNADVERTISED.has(key) &&
            legacy[key] === undefined,
        ),
      ).toEqual([]);
      const base = minimalInput(def);
      const validate = toolValidators.get(def.name)!;
      const failures: string[] = [];
      // Injected-but-unadvertised keys (deviceId) are not in the tool's JSON schema, so every
      // value is "rejected" there and no parity can be asserted for them.
      for (const key of declared.filter((name) => toolProps[name] !== undefined)) {
        for (const wrong of ["wrong", 12345, true, [], {}] as Json[]) {
          const input = { ...base, [key]: wrong };
          if (validate(input)) {
            continue;
          }
          const shown = `${key}=${JSON.stringify(wrong)}`;
          if (planAccepts(inline(def.name, input))) {
            failures.push(`inline accepted ${shown}`);
          }
          if (planAccepts(viaParams(def.name, input))) {
            failures.push(`params accepted ${shown}`);
          }
        }
      }
      expect(failures.join("\n")).toBe("");
    },
  );
});
