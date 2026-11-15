import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../src/features/observe/android/ctrlProxyProtocol";
import traces from "../../fixtures/prototype-spec/push/traces.json";
import { resolvePrototypeDataPointer } from "../../../src/features/prototype/prototypeData";
import {
  applyPrototypeDataWrite,
  type PrototypeDataWrite,
} from "../../../src/features/prototype/prototypeDataWrite";
import { prototypePlatformDeliveredEventOf } from "../../../src/features/prototype/prototypePlatformEvent";
import { validatePrototypePushPayload } from "../../../src/features/prototype/prototypePush";
import {
  PROTOTYPE_PUSH_DELIVERIES,
  PROTOTYPE_PUSH_EVENT,
} from "../../../src/features/prototype/prototypePushSimulate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

/**
 * Shared push traces (#14285): a spec, then simulated pushes, each with the `/data`, state and
 * events a runtime must produce after it. They are runtime-neutral, so the Android and iOS
 * runtimes can run the same file once they apply `notifications.push` handlers. Here the host
 * checks that every spec and payload is valid and that the expectations follow from the
 * handler's data and state writes with `{event: pointer}` read from the payload.
 */
interface Step {
  push: unknown;
  expect: {
    data: Record<string, unknown>;
    state: Record<string, unknown>;
    events: Array<Pick<PrototypeEvent, "kind" | "name" | "payload">>;
  };
}
interface Trace {
  name: string;
  spec: Record<string, unknown> & {
    data?: Record<string, unknown>;
    state?: Record<string, unknown>;
    platform?: { on?: Record<string, Array<Record<string, unknown>>> };
  };
  steps: Step[];
}

// The JSON import widens `kind` to string; the first test checks each trace's shape.
const all = traces as Trace[];

function eventValue(push: unknown, binding: unknown): unknown {
  const pointer = (binding as { event: string }).event;
  const value = resolvePrototypeDataPointer(push, pointer);
  expect({ pointer, found: value !== undefined }).toEqual({ pointer, found: true });
  return value;
}

/** The writes a handler makes; the traces use only appendData and setState. */
function applyHandler(
  actions: Array<Record<string, unknown>>,
  push: unknown,
  current: { data: Record<string, unknown>; state: Record<string, unknown> },
): void {
  for (const action of actions) {
    const value = eventValue(push, action.value);
    if (action.type === "setState") {
      current.state[String(action.key)] = value;
      continue;
    }
    expect(action.type).toBe("appendData");
    const write = { op: "append", path: String(action.path), value } as PrototypeDataWrite;
    const written = applyPrototypeDataWrite(current.data, write);
    expect(written.success).toBe(true);
    current.data = written.success ? written.data : current.data;
  }
}

describe("prototype push traces", () => {
  test("every trace is uniquely named with a valid spec and valid pushes", () => {
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((trace) => trace.name)).size).toBe(all.length);
    for (const trace of all) {
      expect({ name: trace.name, valid: validatePrototypeSpec(trace.spec).success }).toEqual({
        name: trace.name,
        valid: true,
      });
      for (const step of trace.steps) {
        expect(validatePrototypePushPayload(step.push).success).toBe(true);
      }
    }
  });

  test("each step's /data and state follow from the push handler", () => {
    for (const trace of all) {
      const handler = trace.spec.platform?.on?.[PROTOTYPE_PUSH_EVENT];
      const current = {
        data: structuredClone(trace.spec.data ?? {}),
        state: structuredClone(trace.spec.state ?? {}),
      };
      trace.steps.forEach((step, index) => {
        if (handler) {
          applyHandler(handler, step.push, current);
        }
        expect({ trace: trace.name, step: index, ...current }).toEqual({
          trace: trace.name,
          step: index,
          data: step.expect.data,
          state: step.expect.state,
        });
      });
    }
  });

  test("each step reports one delivered push event naming its type and whether it was handled", () => {
    for (const trace of all) {
      const handled = trace.spec.platform?.on?.[PROTOTYPE_PUSH_EVENT] !== undefined;
      for (const step of trace.steps) {
        expect(step.expect.events).toHaveLength(1);
        const delivered = prototypePlatformDeliveredEventOf(step.expect.events[0]!);
        const data = delivered?.data as { type: string; delivery: string; handled: boolean };
        expect(delivered?.event).toBe(PROTOTYPE_PUSH_EVENT);
        expect(data.type).toBe((step.push as { type: string }).type);
        expect(PROTOTYPE_PUSH_DELIVERIES).toContain(data.delivery as "foreground");
        expect(data.handled).toBe(handled);
      }
    }
  });
});
