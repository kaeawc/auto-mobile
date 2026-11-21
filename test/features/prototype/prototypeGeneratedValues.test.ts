import { expect, test } from "bun:test";
import { actionSchema } from "../../../src/features/prototype/prototypeSpec";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const actions = [
  { type: "appendData", path: "/data/rows", value: { generate: "id" } },
  { type: "setState", key: "at", value: { now: "epochMs" } },
  {
    type: "request",
    url: "https://example.test",
    into: "/data/rows",
    where: { field: "id", equals: { lastGenerated: true } },
    member: "result",
  },
];
for (const action of actions) {
  test(`generated schema and strict gate: ${action.type}`, () => {
    expect(actionSchema.safeParse(action).success).toBe(true);
    expect(
      prototypeRequiredCapabilities({ root: { type: "button", label: "Go", onTap: [action] } }).map(
        (gate) => gate.capability,
      ),
    ).toContain("prototype_data_actions_v2");
  });
}

import fixtures from "../../fixtures/prototype-spec/data/generated-values.json";
import {
  createPrototypeActionContext,
  type PrototypeActionContext,
} from "../../../src/features/prototype/prototypeGeneratedValues";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  applyPrototypeDataAction,
  resolvePrototypeDataWriteValue,
} from "../../../src/features/prototype/prototypeDataWrite";
import { resolvePrototypeRequest } from "../../../src/features/prototype/prototypeRequest";
import { applyPrototypeRequestOutcome } from "../../../src/features/prototype/prototypeRequestOutcome";
import { prototypeSecureStorageActionError } from "../../../src/features/prototype/prototypeSecureStorage";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import type { PrototypeData } from "../../../src/features/prototype/prototypeSpec";

for (const fixture of fixtures) {
  test(`shared generated fixture: ${fixture.name}`, () => {
    let id = 0;
    const context = createPrototypeActionContext(
      { next: () => fixture.ids[id++]! },
      { now: () => fixture.clockMs },
    );
    let data: PrototypeData = structuredClone(fixture.initialData);
    let errorCode: string | undefined;
    let responseIndex = 0;
    const completions: (() => void)[] = [];
    const run = (list: Record<string, unknown>[], scope: PrototypeActionContext) => {
      for (const action of list) {
        if (action.type !== "request") {
          const result = applyPrototypeDataAction(action, { data, state: {}, context: scope });
          if (!result.success) {
            errorCode = result.error.code;
            return;
          }
          data = result.data;
          continue;
        }
        const resolved = resolvePrototypeRequest(action, String(action.url), {
          data,
          state: {},
          context: scope,
        });
        if (!resolved.success) {
          errorCode = resolved.error.code;
          return;
        }
        const response = fixture.mockResponses[responseIndex++]!;
        completions.push(() => {
          const request = resolved.request;
          const outcome = applyPrototypeRequestOutcome(
            data,
            typeof action.into === "string" ? action.into : undefined,
            {
              type: "prototype_response",
              requestId: "mock",
              ok: true,
              status: response.status,
              body: response.body,
              headers: {},
              durationMs: 0,
            },
            request.where ? { where: request.where, member: request.member } : undefined,
          );
          data = outcome.data;
          if (outcome.meta.error) {
            errorCode = outcome.meta.error.code;
          }
          const followUps = action[outcome.status === "success" ? "onSuccess" : "onError"];
          if (Array.isArray(followUps)) {
            errorCode = undefined;
            run(followUps, request.context!);
          }
        });
      }
    };
    run(fixture.actions, context);
    for (const complete of completions) {
      complete();
    }
    if (fixture.expected.errorCode) {
      expect(errorCode).toBe(fixture.expected.errorCode);
    } else {
      expect(errorCode).toBeUndefined();
      expect<unknown>(data).toEqual(fixture.expected.data);
    }
  });
}

test("CountingIdGenerator and fake clock resolve each occurrence once and now does not replace lastGenerated", () => {
  const timer = new FakeTimer();
  timer.advanceTime(1700000000000);
  const context = createPrototypeActionContext(new CountingIdGenerator(), timer);
  const inputs = { state: {}, context };
  expect(resolvePrototypeDataWriteValue({ generate: "id" }, inputs)).toEqual({
    success: true,
    value: "id-1",
  });
  expect(resolvePrototypeDataWriteValue({ now: "iso" }, inputs)).toEqual({
    success: true,
    value: "2023-11-14T22:13:20.000Z",
  });
  expect(resolvePrototypeDataWriteValue({ lastGenerated: true }, inputs)).toEqual({
    success: true,
    value: "id-1",
  });
  expect(resolvePrototypeDataWriteValue({ generate: "id" }, inputs)).toEqual({
    success: true,
    value: "id-2",
  });
  expect(
    resolvePrototypeDataWriteValue(
      { lastGenerated: true },
      { state: {}, context: createPrototypeActionContext(new CountingIdGenerator(), timer) },
    ),
  ).toMatchObject({ success: false, error: { code: "lastGenerated_unset" } });
});

const spec = (onTap: unknown[]) => ({
  id: "generated",
  window: { placement: { type: "fullscreen" } },
  data: { rows: [] },
  state: { token: "", at: 0 },
  root: { type: "button", label: "Send", onTap },
});

test("validator follows request capture and refuses statically unset bindings", () => {
  expect(
    validatePrototypeSpec(
      spec([{ type: "setData", path: "/data/value", value: { lastGenerated: true } }]),
    ),
  ).toMatchObject({ success: false, error: { code: "lastGenerated_unset" } });
  for (const fixture of fixtures.slice(0, 3)) {
    expect(validatePrototypeSpec(spec(fixture.actions)).success).toBe(true);
  }
  expect(
    validatePrototypeSpec(
      spec([
        {
          type: "request",
          url: "https://example.test",
          onSuccess: [{ type: "setData", path: "/data/value", value: { lastGenerated: true } }],
        },
        { type: "setData", path: "/data/id", value: { generate: "id" } },
      ]),
    ),
  ).toMatchObject({ success: false, error: { code: "lastGenerated_unset" } });
});

test("secure selectors are guarded but generated bindings are not state keys", () => {
  const root = { storage: { secure: ["state:token"] } };
  for (const type of ["request", "setData", "removeData"]) {
    const action = { type, where: { field: "id", equals: { state: "token" } } };
    expect(prototypeSecureStorageActionError(action, "action", root)?.message).toContain(
      "Secure storage key state:token",
    );
    for (const equals of [{ generate: "id" }, { now: "iso" }, { lastGenerated: true }]) {
      expect(
        prototypeSecureStorageActionError(
          { ...action, where: { field: "id", equals } },
          "action",
          root,
        ),
      ).toBeUndefined();
    }
  }
});

test("request resolves generated body, headers, query and selector once and captures its own id", () => {
  let ticks = 0;
  const ids = new CountingIdGenerator();
  const context = createPrototypeActionContext(ids, { now: () => 1700000000000 + ticks++ });
  const result = resolvePrototypeRequest(
    {
      method: "POST",
      headers: { "x-id": { generate: "id" } },
      query: { at: { now: "epochMs" } },
      body: { lastGenerated: true },
      where: { field: "id", equals: { lastGenerated: true } },
    },
    "https://example.test",
    { state: {}, context },
  );
  expect(result).toMatchObject({
    success: true,
    request: {
      headers: { "x-id": "id-1" },
      url: "https://example.test/?at=1700000000000",
      body: "id-1",
      where: { field: "id", equals: "id-1" },
      context: { lastGenerated: "id-1" },
    },
  });
  expect(ticks).toBe(1);
  resolvePrototypeDataWriteValue({ generate: "id" }, { state: {}, context });
  expect(result.success && result.request.context?.lastGenerated).toBe("id-1");
  expect(ids.next()).toBe("id-3");
});

test("keyed request needs into and member needs where, while non-keyed into retains its guard", () => {
  for (const action of [
    { type: "request", url: "https://example.test", member: "value" },
    { type: "request", url: "https://example.test", where: { field: "id", equals: { value: 1 } } },
    { type: "request", url: "https://example.test", into: "/data/rows/0" },
  ]) {
    expect(validatePrototypeSpec(spec([action])).success).toBe(false);
  }
});

test("secure request selector opt-in and exact rejection path", () => {
  const action = {
    type: "request",
    url: "https://example.test",
    into: "/data/rows",
    where: { field: "id", equals: { state: "token" } },
  };
  const root = { storage: { secure: ["state:token"] } };
  expect(prototypeSecureStorageActionError(action, "action", root)?.path).toBe(
    "action.where.equals",
  );
  expect(
    prototypeSecureStorageActionError({ ...action, allowSecureInRequest: true }, "action", root),
  ).toBeUndefined();
  for (const type of ["setData", "removeData"]) {
    expect(prototypeSecureStorageActionError({ ...action, type }, "action", root)?.path).toBe(
      "action.where.equals",
    );
  }
});

test("generated keyed action contributes one capability location", () => {
  const candidate = spec([
    {
      type: "setData",
      path: "/data/rows",
      where: { field: "id", equals: { lastGenerated: true } },
      value: { now: "iso" },
    },
  ]);
  expect(
    prototypeRequiredCapabilities(candidate).find(
      (gate) => gate.capability === "prototype_data_actions_v2",
    )?.fields,
  ).toEqual(["root.onTap[0]"]);
});
