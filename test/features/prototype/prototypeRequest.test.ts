import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import {
  PROTOTYPE_SPEC_CAPABILITY_GATES,
  prototypeRequiredCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_REQUEST_EVENT_NAME,
  prototypeRequestMetaPath,
  resolvePrototypeRequest,
} from "../../../src/features/prototype/prototypeRequest";
import {
  DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
  MAX_PROTOTYPE_RESPONSE_BYTES,
} from "../../../src/features/prototype/prototypeRequestLimits";
import { applyPrototypeRequestOutcome } from "../../../src/features/prototype/prototypeRequestOutcome";
import { prototypeRequestEventOf } from "../../../src/features/prototype/prototypeRequestEvent";
import { PROTOTYPE_REQUEST_METHODS } from "../../../src/features/prototype/prototypeRequestProtocol";
import {
  actionSchema,
  prototypeSpecSchema,
  MAX_PROTOTYPE_DATA_WRITE_BYTES,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

type Raw = Record<string, unknown>;
// Undefined members are dropped so a spec never carries one (the validator rejects them).
const request = (extra: Raw = {}): Raw =>
  Object.fromEntries(
    Object.entries({
      type: "request",
      url: "http://localhost:8080/feed",
      into: "/data/feed",
      ...extra,
    }).filter(([, value]) => value !== undefined),
  );
function spec(onTap: Raw[], extra: Raw = {}, state: Raw = {}) {
  return {
    id: "req",
    window: { placement: { type: "fullscreen" } },
    state: { status: "idle", count: 0, flag: false, q: "a", ...state },
    data: { title: "T" },
    root: { type: "button", label: "Go", onTap },
    ...extra,
  };
}
const check = (action: Raw, extra: Raw = {}, state: Raw = {}) =>
  validatePrototypeSpec(spec([action], extra, state));
const failure = (action: Raw, extra: Raw = {}, state: Raw = {}) => {
  const result = check(action, extra, state);
  return result.success ? undefined : result.error;
};

describe("request action validation", () => {
  test("accepts the full action and defaults", () => {
    expect(check(request()).success).toBe(true);
    expect(
      check(
        request({
          method: "POST",
          headers: { Accept: "application/json", "X-Q": { state: "q" }, "X-T": { data: "/title" } },
          query: { q: { state: "q" }, n: { value: 3 }, lit: "x" },
          body: { state: "q" },
          statusKey: "status",
          via: "device",
          timeoutMs: MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
          onSuccess: [{ type: "setState", key: "count", value: 1 }],
          onError: [{ type: "toggle", key: "flag" }],
        }),
      ).success,
    ).toBe(true);
    expect(check({ type: "request", url: "https://example.com" }).success).toBe(true);
  });

  test.each(PROTOTYPE_REQUEST_METHODS)("accepts method %s", (method) => {
    const body = method === "GET" || method === "HEAD" ? {} : { body: { value: 1 } };
    expect(check(request({ method, ...body })).success).toBe(true);
  });

  test.each([
    ["ftp://example.com/x", "A request url must be an absolute http or https URL"],
    ["/relative", "A request url must be an absolute http or https URL"],
    ["file:///etc/passwd", "A request url must be an absolute http or https URL"],
    ["{q}://example.com", "A templated request url must start with a literal http:// or https://"],
    ["{base}/feed", "A templated request url must start with a literal http:// or https://"],
  ])("refuses url %s", (url, message) => {
    expect(failure(request({ url }), {}, { base: "x" })).toEqual({
      path: "root.onTap[0].url",
      message,
    });
  });

  test("a templated url may bind state and data after the scheme, with any host", () => {
    for (const url of [
      "http://{q}/feed",
      "https://localhost:{count}/{data:/title}",
      "http://192.168.1.4/x?{q}=1",
    ]) {
      expect(check(request({ url })).success).toBe(true);
    }
  });

  test("localhost, loopback and private hosts are allowed (no allowlist)", () => {
    for (const url of [
      "http://localhost/",
      "http://127.0.0.1:9/",
      "http://[::1]/",
      "http://10.0.2.2:8080/",
      "http://169.254.169.254/",
    ]) {
      expect(check(request({ url })).success).toBe(true);
    }
  });

  test("statusKey must be a declared string state key", () => {
    expect(check(request({ statusKey: "status" })).success).toBe(true);
    expect(failure(request({ statusKey: "missing" }))).toEqual({
      path: "root.onTap[0].statusKey",
      message: "statusKey must name a declared state key",
    });
    for (const key of ["count", "flag"]) {
      expect(failure(request({ statusKey: key }))).toEqual({
        path: "root.onTap[0].statusKey",
        message: "statusKey requires a string state key",
      });
    }
  });

  test("statusKey drives visibleWhen like any state key", () => {
    const result = validatePrototypeSpec({
      ...spec([request({ statusKey: "status" })]),
      root: {
        type: "column",
        children: [
          { type: "text", text: "Loading", visibleWhen: { key: "status", equals: "loading" } },
          { type: "button", label: "Go", onTap: [request({ statusKey: "status" })] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test.each([
    ["/feed", "request into is /data/<RFC 6901 pointer> and addresses a member of data"],
    ["/state/feed", "request into is /data/<RFC 6901 pointer> and addresses a member of data"],
    ["/data", "request into is /data/<RFC 6901 pointer> and addresses a member of data"],
    [
      "/data/feed/0",
      "request into must name an object member, not an array element, so into__meta can be written beside it",
    ],
  ])("refuses into %s", (into, message) => {
    expect(failure(request({ into }))).toEqual({ path: "root.onTap[0].into", message });
  });

  test("into is optional and a nested member is fine", () => {
    expect(check({ type: "request", url: "http://x.test/", method: "POST" }).success).toBe(true);
    expect(check(request({ into: "/data/a/b/c" })).success).toBe(true);
  });

  test("a body is refused on GET, HEAD and an omitted method", () => {
    for (const method of ["GET", "HEAD", undefined]) {
      expect(failure(request({ method, body: { value: 1 } }))).toEqual({
        path: "root.onTap[0].body",
        message: "A GET or HEAD request cannot have a body",
      });
    }
  });

  test("header and query bindings accept every runtime binding form and reject objects", () => {
    expect(
      check(request({ headers: { A: { state: "q" }, B: { data: "/title" }, C: { value: 1 } } }))
        .success,
    ).toBe(true);
    expect(failure(request({ headers: { A: { value: { nested: 1 } } } }))).toEqual({
      path: "root.onTap[0].headers.A.value",
      message: "A header or query literal must be a string, number or boolean",
    });
    expect(failure(request({ query: { a: { value: [1] } } }))?.path).toBe(
      "root.onTap[0].query.a.value",
    );
    expect(failure(request({ headers: { "bad name": "x" } }))).toEqual({
      path: 'root.onTap[0].headers["bad name"]',
      message: "Invalid header name",
    });
    expect(failure(request({ query: { a: { bogus: 1 } } }))?.path).toBe(
      "root.onTap[0].query.a.bogus",
    );
    expect(failure(request({ body: { state: "q", extra: 1 } }))?.path).toBe(
      "root.onTap[0].body.extra",
    );
  });

  test("timeoutMs is validated against the contract maximum", () => {
    expect(check(request({ timeoutMs: MAX_PROTOTYPE_REQUEST_TIMEOUT_MS + 1 })).success).toBe(false);
    expect(check(request({ timeoutMs: 0 })).success).toBe(false);
    expect(check(request({ timeoutMs: 1.5 })).success).toBe(false);
    expect(
      prototypeSpecSchema.safeParse(
        spec([request({ timeoutMs: MAX_PROTOTYPE_REQUEST_TIMEOUT_MS + 1 })]),
      ).success,
    ).toBe(false);
  });

  test("unknown fields, a bad method and an empty follow-up list are refused", () => {
    expect(failure(request({ extra: 1 }))?.path).toBe("root.onTap[0].extra");
    expect(failure(request({ method: "TRACE" }))?.path).toBe("root.onTap[0].method");
    expect(failure(request({ onSuccess: [] }))?.path).toBe("root.onTap[0].onSuccess");
    expect(failure(request({ via: "proxy" }))?.path).toBe("root.onTap[0].via");
  });

  test("follow-up actions are validated like any action, at their nested path", () => {
    expect(failure(request({ onError: [{ type: "toggle", key: "count" }] }))).toEqual({
      path: "root.onTap[0].onError[0].key",
      message: "Toggle requires a boolean state key",
    });
    expect(failure(request({ onSuccess: [{ type: "bogus" }] }))?.path).toBe(
      "root.onTap[0].onSuccess[0].type",
    );
    expect(failure(request({ onSuccess: [{ type: "pop", stack: "nope" }] }))).toEqual({
      path: "root.onTap[0].onSuccess[0].stack",
      message: "Unknown stack id",
    });
  });

  test("nested follow-ups are bounded by MAX_PROTOTYPE_ACTION_DEPTH", () => {
    const depth = contract.limits.MAX_PROTOTYPE_ACTION_DEPTH;
    const nested = (levels: number): Raw =>
      levels === 1 ? request() : request({ onSuccess: [nested(levels - 1)] });
    expect(check(nested(depth)).success).toBe(true);
    const over = failure(nested(depth + 1));
    expect(over?.message).toBe("Action nesting limit exceeded");
    expect(over?.path.split("onSuccess").length - 1).toBe(depth);
  });

  test("the emit name used for request events is reserved", () => {
    expect(failure({ type: "emit", name: PROTOTYPE_REQUEST_EVENT_NAME })).toEqual({
      path: "root.onTap[0].name",
      message: "The emit name prototype_request is reserved for request events",
    });
  });

  test("inside a repeat, statusKey and into bind per row", () => {
    const rows = {
      type: "column",
      repeat: { items: [{ id: "a" }, { id: "b" }], as: "row" },
      children: [
        {
          type: "button",
          label: "Go",
          onTap: [
            request({
              url: "http://localhost/{row.id}",
              into: "/data/rows/{index}/body",
              statusKey: "s_{row.id}",
            }),
          ],
        },
      ],
    };
    const state = { s_a: "idle", s_b: "idle" };
    const ok = validatePrototypeSpec({ ...spec([]), state, data: { rows: [{}, {}] }, root: rows });
    expect(ok.success).toBe(true);
    const missing = validatePrototypeSpec({
      ...spec([]),
      state: { s_a: "idle" },
      root: rows,
    });
    expect(missing.success).toBe(false);
  });
});

describe("request contract mirror", () => {
  test("Zod and the contract list the same request fields", () => {
    const { request: variant } = contract.definitions.action.variants;
    const option = actionSchema.options.find(
      (candidate) => candidate.shape.type.options[0] === "request",
    );
    expect(Object.keys(option!.shape).sort()).toEqual(Object.keys(variant.fields).sort());
  });

  test("request is the only action whose lists nest actions", () => {
    const nesting = Object.entries(contract.definitions.action.variants).filter(([, variant]) =>
      JSON.stringify(variant).includes('"name":"action"'),
    );
    expect(nesting.map(([name]) => name)).toEqual(["request"]);
  });
});

describe("request limits", () => {
  test("the host executor limits are the contract limits", () => {
    expect(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS).toBe(
      contract.limits.DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
    );
    expect(MAX_PROTOTYPE_REQUEST_TIMEOUT_MS).toBe(contract.limits.MAX_PROTOTYPE_REQUEST_TIMEOUT_MS);
    expect(MAX_PROTOTYPE_RESPONSE_BYTES).toBe(contract.limits.MAX_PROTOTYPE_RESPONSE_BYTES);
    expect(MAX_PROTOTYPE_REQUESTS_IN_FLIGHT).toBe(contract.limits.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT);
  });

  test("the values", () => {
    expect([
      DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
      MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
      MAX_PROTOTYPE_RESPONSE_BYTES,
      MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
    ]).toEqual([10_000, 30_000, 256 * 1024, 4]);
  });

  test("an accepted response always fits one /data write, and the default fits the maximum", () => {
    expect(MAX_PROTOTYPE_RESPONSE_BYTES).toBeLessThanOrEqual(MAX_PROTOTYPE_DATA_WRITE_BYTES);
    expect(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
      MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
    );
  });
});

describe("request capability gates", () => {
  const networkGates = new Set([PROTOTYPE_NETWORK_CAPABILITY, PROTOTYPE_NETWORK_DEVICE_CAPABILITY]);
  const gatesOf = (candidate: unknown) =>
    prototypeRequiredCapabilities(candidate).filter((gate) => networkGates.has(gate.capability));
  const required = (onTap: Raw[]) =>
    gatesOf(spec(onTap)).map((gate) => [gate.capability, gate.fields]);

  test("both capabilities are registered", () => {
    const registered = PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability);
    expect(registered).toContain(PROTOTYPE_NETWORK_CAPABILITY);
    expect(registered).toContain(PROTOTYPE_NETWORK_DEVICE_CAPABILITY);
    expect([PROTOTYPE_NETWORK_CAPABILITY, PROTOTYPE_NETWORK_DEVICE_CAPABILITY]).toEqual([
      "prototype_network_v1",
      "prototype_network_device_v1",
    ]);
  });

  test("a host request (explicit or default) needs only the network capability", () => {
    for (const via of ["host", undefined]) {
      expect(required([request({ via })])).toEqual([
        [PROTOTYPE_NETWORK_CAPABILITY, ["root.onTap[0]"]],
      ]);
    }
  });

  test("a device request needs the network and the device capability", () => {
    expect(required([request({ via: "device" })])).toEqual([
      [PROTOTYPE_NETWORK_CAPABILITY, ["root.onTap[0]"]],
      [PROTOTYPE_NETWORK_DEVICE_CAPABILITY, ["root.onTap[0]"]],
    ]);
  });

  test("the device gate lists only the via-device requests, including nested ones", () => {
    const fields = gatesOf(
      spec([
        request({ via: "host", onSuccess: [request({ via: "device" })] }),
        request({ via: "device" }),
      ]),
    );
    expect(fields.map((gate) => [gate.capability, gate.fields])).toEqual([
      [
        PROTOTYPE_NETWORK_CAPABILITY,
        ["root.onTap[0]", "root.onTap[0].onSuccess[0]", "root.onTap[1]"],
      ],
      [PROTOTYPE_NETWORK_DEVICE_CAPABILITY, ["root.onTap[0].onSuccess[0]", "root.onTap[1]"]],
    ]);
  });

  test("a spec without requests needs neither", () => {
    expect(required([{ type: "dismiss" }])).toEqual([]);
  });

  test("component definitions are located at their authored path", () => {
    const fields = gatesOf({
      id: "c",
      window: { placement: { type: "fullscreen" } },
      components: {
        Loader: { root: { type: "button", label: "x", onTap: [request({ via: "device" })] } },
      },
      root: { type: "use", component: "Loader" },
    });
    expect(fields.map((gate) => gate.capability)).toEqual([
      PROTOTYPE_NETWORK_CAPABILITY,
      PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
    ]);
    expect(
      fields[0].fields.some((field) => field.endsWith("components.Loader.root.onTap[0]")),
    ).toBe(true);
  });

  test("the refusal names the field and the fallback", () => {
    const [network, device] = gatesOf(spec([request({ via: "device" })]));
    expect(network.unsupportedMessage(network.fields, "android")).toContain(
      "prototype_network_v1, so it cannot run the request action at root.onTap[0]",
    );
    expect(device.unsupportedMessage(device.fields, "ios")).toContain(
      'prototype_network_device_v1, so it cannot run a request with via "device" at root.onTap[0]',
    );
  });
});

describe("resolvePrototypeRequest", () => {
  const inputs = { state: { q: "cats", n: 3, on: true }, data: { title: "Feed", obj: { a: 1 } } };

  test("resolves bindings, defaults the method and sets query values on the url", () => {
    const resolved = resolvePrototypeRequest(
      request({
        headers: { A: "lit", B: { state: "q" }, C: { data: "/title" }, D: { value: 5 } },
        query: { q: { state: "q" }, n: { state: "n" }, flag: { state: "on" }, z: "9" },
        body: { value: { k: 1 } },
        method: "POST",
      }),
      "http://localhost:8080/feed?q=old",
      inputs,
    );
    expect(resolved).toEqual({
      success: true,
      request: {
        method: "POST",
        url: "http://localhost:8080/feed?q=cats&flag=true&n=3&z=9",
        headers: { A: "lit", B: "cats", C: "Feed", D: "5" },
        body: { k: 1 },
      },
    });
    const bare = resolvePrototypeRequest({ type: "request", url: "x" }, "https://a.test", inputs);
    expect(bare).toMatchObject({ success: true, request: { method: "GET", headers: {} } });
  });

  test("query entries are applied in sorted key order, not authored order", () => {
    const resolved = resolvePrototypeRequest(
      request({ query: { z: "1", a: "2" } }),
      "http://a.test/p",
      inputs,
    );
    expect(resolved).toMatchObject({ request: { url: "http://a.test/p?a=2&z=1" } });
  });

  test("a body binding reads state and data", () => {
    expect(
      resolvePrototypeRequest(
        request({ method: "PUT", body: { data: "/obj" } }),
        "http://a.test",
        inputs,
      ),
    ).toMatchObject({ request: { body: { a: 1 } } });
    expect(
      resolvePrototypeRequest(
        request({ method: "PUT", body: { state: "q" } }),
        "http://a.test",
        inputs,
      ),
    ).toMatchObject({ request: { body: "cats" } });
  });

  test("bad urls and unresolvable bindings fail with typed codes", () => {
    expect(resolvePrototypeRequest(request(), "ftp://a.test", inputs)).toMatchObject({
      success: false,
      error: { code: "invalid_url" },
    });
    expect(resolvePrototypeRequest(request(), "not a url", inputs)).toMatchObject({
      error: { code: "invalid_url" },
    });
    for (const action of [
      request({ headers: { A: { state: "missing" } } }),
      request({ query: { a: { data: "/missing" } } }),
      request({ query: { a: { data: "/obj" } } }),
      request({ method: "POST", body: { state: "missing" } }),
    ]) {
      expect(resolvePrototypeRequest(action, "http://a.test", inputs)).toMatchObject({
        success: false,
        error: { code: "invalid_request" },
      });
    }
  });
});

describe("applyPrototypeRequestOutcome", () => {
  const ok = (body: unknown, status = 200) =>
    ({
      type: "prototype_response",
      requestId: "r",
      ok: true,
      status,
      headers: { "content-type": "application/json" },
      body,
      durationMs: 12,
    }) as never;

  test("meta is a sibling key with the suffix on the last segment", () => {
    expect(prototypeRequestMetaPath("/data/feed")).toBe("/data/feed__meta");
    expect(prototypeRequestMetaPath("/data/a/b~1c")).toBe("/data/a/b~1c__meta");
  });

  test("a JSON body is written to into and the metadata beside it", () => {
    const result = applyPrototypeRequestOutcome(
      { title: "T" },
      "/data/feed",
      ok({ items: [1, 2] }),
    );
    expect(result.status).toBe("success");
    expect(result.wroteInto).toBe(true);
    expect(result.data).toEqual({
      title: "T",
      feed: { items: [1, 2] },
      feed__meta: { status: 200, headers: { "content-type": "application/json" }, durationMs: 12 },
    });
  });

  test("a non-JSON body is a string and an empty body is an empty string", () => {
    expect(applyPrototypeRequestOutcome({}, "/data/t", ok("plain text")).data.t).toBe("plain text");
    expect(applyPrototypeRequestOutcome({}, "/data/t", ok(null, 204)).data.t).toBe("");
  });

  test("a non-2xx status leaves into alone, records http_error and reports error", () => {
    const result = applyPrototypeRequestOutcome({ feed: "old" }, "/data/feed", ok({ e: 1 }, 404));
    expect(result.status).toBe("error");
    expect(result.wroteInto).toBe(false);
    expect(result.data.feed).toBe("old");
    expect(result.data.feed__meta).toMatchObject({
      status: 404,
      error: { code: "http_error", message: "HTTP 404" },
    });
  });

  test("a transport failure writes only error metadata", () => {
    const result = applyPrototypeRequestOutcome({}, "/data/feed", {
      type: "prototype_response",
      requestId: "r",
      ok: false,
      error: { code: "timeout", message: "Request timed out after 10000ms." },
      durationMs: 10_000,
    });
    expect(result).toMatchObject({ status: "error", wroteInto: false });
    expect(result.data).toEqual({
      feed__meta: { durationMs: 10_000, error: { code: "timeout", message: expect.any(String) } },
    });
  });

  test("a body data cannot hold is an invalid_response error", () => {
    const result = applyPrototypeRequestOutcome({}, "/data/feed", ok({ a: null }));
    expect(result.status).toBe("error");
    expect(result.meta.error?.code).toBe("invalid_response");
    expect(result.data.feed).toBeUndefined();
    expect(result.data.feed__meta).toMatchObject({
      status: 200,
      error: { code: "invalid_response" },
    });
  });

  test("a body over the write limit fails the write and is reported", () => {
    const body = "x".repeat(MAX_PROTOTYPE_DATA_WRITE_BYTES);
    const result = applyPrototypeRequestOutcome({}, "/data/feed", ok(body));
    expect(result.meta.error?.code).toBe("invalid_response");
    expect(result.wroteInto).toBe(false);
  });

  test("without into only the outcome is reported", () => {
    const result = applyPrototypeRequestOutcome({ a: "b" }, undefined, ok({ x: 1 }));
    expect(result).toMatchObject({ status: "success", data: { a: "b" } });
  });

  test("headers are dropped when only they push the metadata past the write limit", () => {
    const filler = "y".repeat(MAX_PROTOTYPE_DATA_WRITE_BYTES - 400);
    const response = { ...ok("body"), headers: { "x-big": "z".repeat(1000) } } as never;
    const result = applyPrototypeRequestOutcome({ pad: filler }, "/data/feed", response);
    expect(result.data.feed).toBe("body");
    expect(result.data.feed__meta).toEqual({ status: 200, durationMs: 12 });
  });
});

// Frames cross the wire as JSON, so undefined members cannot be present.
const decodeForTest = (frame: unknown) =>
  decodePrototypeEvent(JSON.parse(JSON.stringify(frame ?? null)), "test");

describe("request events", () => {
  const frame = (payload: unknown, name = PROTOTYPE_REQUEST_EVENT_NAME, kind = "emit") => ({
    type: "prototype_event",
    timestamp: 1,
    id: "p",
    sequence: 1,
    kind,
    name,
    payload,
    state: { status: "success" },
    pages: {},
  });
  const success = {
    requestId: "req-1",
    method: "GET",
    url: "http://localhost:8080/feed?q=cats",
    via: "host",
    into: "/data/feed",
    outcome: "success",
    status: 200,
    durationMs: 31,
  };

  test("decodes a finished request and surfaces it from the decoded event", () => {
    const event = decodeForTest(frame(success));
    expect(event).toBeDefined();
    expect(prototypeRequestEventOf(event!)).toEqual(success);
  });

  test("an error outcome carries a typed error, with or without a status", () => {
    const refused = {
      ...success,
      outcome: "error",
      status: undefined,
      error: { code: "connection_refused", message: "Connection refused" },
    };
    expect(prototypeRequestEventOf(decodeForTest(frame(refused))!)?.error?.code).toBe(
      "connection_refused",
    );
    const notFound = {
      ...success,
      outcome: "error",
      status: 404,
      error: { code: "http_error", message: "HTTP 404" },
    };
    expect(prototypeRequestEventOf(decodeForTest(frame(notFound))!)?.status).toBe(404);
    expect(
      prototypeRequestEventOf(
        decodeForTest(
          frame({ ...success, outcome: "error", error: { code: "cancelled", message: "m" } }),
        )!,
      )?.error?.code,
    ).toBe("cancelled");
  });

  test("a malformed request event is dropped by the decoder", () => {
    for (const payload of [
      { ...success, outcome: "error" },
      { ...success, requestId: "" },
      { ...success, extra: 1 },
      { ...success, method: "TRACE" },
      null,
      "text",
    ]) {
      expect(decodeForTest(frame(payload))).toBeUndefined();
    }
  });

  test("other events and other emit names are not request events", () => {
    const other = decodeForTest(frame({ any: "thing" }, "tapped"));
    expect(other).toBeDefined();
    expect(prototypeRequestEventOf(other!)).toBeUndefined();
    expect(
      prototypeRequestEventOf({
        kind: "page_changed",
        name: PROTOTYPE_REQUEST_EVENT_NAME,
        payload: success,
      }),
    ).toBeUndefined();
  });
});
