import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import skips from "../../fixtures/prototype-spec/action-trace-skips.json";
import {
  applyPrototypeDataWrite,
  resolvePrototypeDataWriteValue,
  type PrototypeDataWrite,
  type PrototypeRuntimeDataActionValue,
} from "../../../src/features/prototype/prototypeDataWrite";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

/**
 * Shared action traces (#16456): a spec, then steps that each run one tap's actions or advance a
 * fake clock, with the expected state, `/data`, stack paths, pager pages and shown flag after it.
 * The Kotlin runtime (`PrototypeActionTracesTest`) and the Swift session
 * (`PrototypeActionTracesTests`) run the same files. A platform that cannot run a trace lists it
 * in `action-trace-skips.json` with the issue that closes the gap.
 */
type Action = Record<string, unknown> & { type: string };
interface Expectation {
  state?: Record<string, unknown>;
  data?: Record<string, unknown>;
  stacks?: Record<string, string[]>;
  pages?: Record<string, number>;
  shown?: boolean;
}
interface Step {
  actions?: Action[];
  advanceMs?: number;
  expect: Expectation;
}
interface Trace {
  name: string;
  spec: Record<string, unknown> & { root: unknown; data?: Record<string, unknown> };
  steps: Step[];
}
interface Skip {
  trace: string;
  issue: number;
}

const directory = join(import.meta.dir, "../../fixtures/prototype-spec/action-traces");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const traces: Trace[] = files.flatMap(
  (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Trace[],
);
const platforms: Record<string, Skip[]> = skips;

const EXPECTATION_KEYS = new Set(["state", "data", "stacks", "pages", "shown"]);
const DATA_ACTIONS = new Set(["setData", "appendData", "prependData", "upsertData", "removeData"]);

/** The spec with one step's actions on a button, so the validator checks them in context. */
function withActions(trace: Trace, actions: Action[]): unknown {
  return {
    ...trace.spec,
    root: {
      type: "column",
      children: [trace.spec.root, { type: "button", label: "Run", onTap: actions }],
    },
  };
}

/**
 * The host has no action runtime yet (#16529); it runs the traces whose every step is a `/data`
 * write, through the same pure write the host mirror and storage restore use.
 */
function runsInTypeScript(trace: Trace): boolean {
  return trace.steps.every(
    (step) =>
      step.advanceMs === undefined &&
      Object.keys(step.expect).every((key) => key === "data") &&
      (step.actions ?? []).every((action) => DATA_ACTIONS.has(action.type)),
  );
}

function dataWrite(action: Action, value: unknown): PrototypeDataWrite {
  const path = String(action.path);
  switch (action.type) {
    case "setData":
      return { op: "set", path, value };
    case "appendData":
      return { op: "append", path, value };
    case "prependData":
      // One row at the start: the host's `prepend` writer op takes the row as a one-row page.
      return { op: "prepend", path, value: [value] };
    case "upsertData":
      return { op: "upsert", path, key: String(action.key), value };
    default:
      return { op: "remove", path };
  }
}

function runDataTrace(trace: Trace): void {
  let data: Record<string, unknown> = structuredClone(trace.spec.data ?? {});
  trace.steps.forEach((step, index) => {
    for (const action of step.actions ?? []) {
      const resolved =
        action.type === "removeData"
          ? { success: true as const, value: null }
          : resolvePrototypeDataWriteValue(action.value as PrototypeRuntimeDataActionValue, {
              state: {},
              data,
            });
      expect(resolved.success).toBe(true);
      const written = resolved.success
        ? applyPrototypeDataWrite(data, dataWrite(action, resolved.value))
        : undefined;
      // A refused write changes nothing on a device, and the rest of the list still runs.
      if (written?.success) {
        data = written.data;
      }
    }
    expect({ step: index, data }).toEqual({ step: index, data: step.expect.data ?? {} });
  });
}

describe("prototype action traces", () => {
  test("every trace is well formed and uniquely named", () => {
    expect(traces.length).toBeGreaterThan(0);
    expect(new Set(traces.map((trace) => trace.name)).size).toBe(traces.length);
    for (const trace of traces) {
      expect(trace.steps.length).toBeGreaterThan(0);
      for (const step of trace.steps) {
        expect([step.actions === undefined, step.advanceMs === undefined]).toContain(true);
        expect(step.actions !== undefined || Number.isInteger(step.advanceMs)).toBe(true);
        expect(Object.keys(step.expect).length).toBeGreaterThan(0);
        expect(Object.keys(step.expect).filter((key) => !EXPECTATION_KEYS.has(key))).toEqual([]);
      }
    }
  });

  test("every skip names a trace, an issue and a known platform", () => {
    const names = new Set(traces.map((trace) => trace.name));
    expect(Object.keys(platforms).sort()).toEqual(["kotlin", "swift", "typescript"]);
    for (const list of Object.values(platforms)) {
      expect(new Set(list.map((skip) => skip.trace)).size).toBe(list.length);
      for (const skip of list) {
        expect(names.has(skip.trace)).toBe(true);
        expect(Number.isInteger(skip.issue) && skip.issue > 0).toBe(true);
      }
    }
  });

  test("the TypeScript skip list is exactly the traces the host cannot run", () => {
    const skipped = platforms.typescript.map((skip) => skip.trace).sort();
    const unrunnable = traces
      .filter((trace) => !runsInTypeScript(trace))
      .map((trace) => trace.name)
      .sort();
    expect(skipped).toEqual(unrunnable);
  });

  for (const trace of traces) {
    test(`spec and actions validate: ${trace.name}`, () => {
      expect(validatePrototypeSpec(trace.spec)).toMatchObject({ success: true });
      const actions = trace.steps.flatMap((step) => step.actions ?? []);
      if (actions.length > 0) {
        expect(validatePrototypeSpec(withActions(trace, actions))).toMatchObject({ success: true });
      }
    });
  }

  for (const trace of traces.filter(runsInTypeScript)) {
    test(`runs: ${trace.name}`, () => {
      runDataTrace(trace);
    });
  }
});
