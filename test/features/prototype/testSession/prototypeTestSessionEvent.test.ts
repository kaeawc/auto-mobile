import { expect, test } from "bun:test";
import {
  recordableStep,
  prototypeScreenLabel,
} from "../../../../src/features/prototype/testSession/prototypeTestSessionEvent";
import { prototypeSecureKeys } from "../../../../src/features/prototype/testSession/prototypeTestSessionSpec";
import { event } from "../../../helpers/prototypeTestEvent";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";

const secret = "hunter2-sentinel";
function step(overrides: Partial<PrototypeEvent>) {
  return recordableStep(
    { ...event(1), state: { email: secret }, context: { secret }, ...overrides },
    new Set(["password"]),
  );
}
test("all recorded kinds exclude snapshots, authored payload/context and data values", () => {
  const events: Partial<PrototypeEvent>[] = [
    { name: "submit", payload: { text: secret } },
    { name: "prototype_request", payload: { body: secret } },
    { kind: "change", name: "/data/user", payload: { op: "set", value: secret, revision: 4 } },
    {
      name: "change",
      payload: { key: "email", value: secret },
      validity: { email: false, password: false },
    },
    {
      name: "change",
      payload: {
        keys: ["email", "password", "count"],
        values: { email: secret, password: secret, count: 3 },
      },
    },
    { kind: "validation_failed", keys: ["email", "password"] },
    {
      kind: "screen_changed",
      name: "checkout",
      payload: { screen: "done", depth: 2, text: secret },
    },
    { kind: "page_changed", name: "pages", payload: 2 },
    { kind: "dismissed", payload: { reason: "close", text: secret } },
  ];
  for (const e of events) {
    const recorded = step(e);
    expect(recorded).toBeDefined();
    expect(JSON.stringify(recorded)).not.toContain(secret);
    expect(JSON.stringify(recorded)).not.toContain("password");
  }
  expect(JSON.parse(step(events[3]!)!.detail_json)).toEqual({
    changes: [{ key: "email", valueLength: 16, valid: false }],
  });
  expect(JSON.parse(step(events[4]!)!.detail_json)).toEqual({
    changes: [
      { key: "email", valueLength: 16 },
      { key: "count", valueType: "number" },
    ],
  });
});
test("secure-only changes disappear; failed secure validation is retained with no keys", () => {
  expect(step({ name: "change", payload: { key: "password", value: secret } })).toBeUndefined();
  expect(JSON.parse(step({ kind: "validation_failed", keys: ["password"] })!.detail_json)).toEqual({
    keys: [],
  });
  expect(step({ kind: "appearance_changed" })).toBeUndefined();
});
test("dead taps are strictly parsed with finite coordinates and nullable stack/screen", () => {
  const payload = { stack: null, screen: null, x: 48.1, y: 2 };
  expect(JSON.parse(step({ name: "prototype_dead_tap", payload })!.detail_json)).toEqual(payload);
  for (const malformed of [
    { ...payload, secret },
    { x: 0, y: 0 },
    { ...payload, x: Infinity },
    { ...payload, y: "2" },
  ]) {
    expect(step({ name: "prototype_dead_tap", payload: malformed })).toBeUndefined();
  }
});
test("deepest path and lexicographic tie determine screen, ignoring declared depth", () => {
  expect(prototypeScreenLabel(undefined)).toBe("(root)");
  expect(
    prototypeScreenLabel({
      z: { path: ["home", "details"], depth: 1 },
      a: { path: ["start", "done"], depth: 2 },
    }),
  ).toBe("a/done");
});
test("secure walk covers components, repeat templates and slots conservatively", () => {
  expect([
    ...prototypeSecureKeys({
      components: { login: { root: { type: "textField", stateKey: "password", secure: true } } },
      root: {
        type: "repeat",
        template: { slot: { type: "searchBar", stateKey: "query", secure: "{private}" } },
        children: [{ type: "textField", stateKey: "public", secure: false }],
      },
    }),
  ]).toEqual(["password", "query"]);
  expect(
    prototypeSecureKeys({ type: "textField", stateKey: "{item.key}", secure: true }).has("*"),
  ).toBe(true);
});

test("unknown secure templates suppress all field keys, including validation keys", () => {
  expect(
    recordableStep(
      { ...event(1), name: "change", payload: { key: "email", value: secret } },
      new Set(["*"]),
    ),
  ).toBeUndefined();
  const recorded = recordableStep(
    { ...event(2), kind: "validation_failed", keys: ["email"] },
    new Set(["*"]),
  );
  expect(JSON.parse(recorded!.detail_json)).toEqual({ keys: [] });
});
