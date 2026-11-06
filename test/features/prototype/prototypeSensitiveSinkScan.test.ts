import { beforeAll, describe, expect, test } from "bun:test";
import { prototypeSensitiveSinkScan } from "../../../src/features/prototype/prototypeStrictPolicy";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const TAINTS = 3000;
const UNRELATED = 5000;
const COPIES_PER_BUTTON = 30;
const QUERIES_PER_REQUEST = 15;
const REQUESTS_PER_BUTTON = 30;
const COPY_BUTTONS = TAINTS / COPIES_PER_BUTTON;

function scanSpec() {
  const copies = Array.from({ length: COPY_BUTTONS }, (_, button) => ({
    type: "button",
    label: `Copy ${button}`,
    onTap: Array.from({ length: COPIES_PER_BUTTON }, (_, offset) => ({
      type: "setData",
      path: `/data/copy${button * COPIES_PER_BUTTON + offset}`,
      value: { platform: "/auth/userId" },
    })),
  }));
  const requests = Array.from(
    { length: Math.ceil(UNRELATED / QUERIES_PER_REQUEST) },
    (_, request) => ({
      type: "request",
      url: "https://example.com/submit",
      via: "device",
      query: {
        ...Object.fromEntries(
          Array.from(
            { length: Math.min(QUERIES_PER_REQUEST, UNRELATED - request * QUERIES_PER_REQUEST) },
            (_, offset) => {
              const index = request * QUERIES_PER_REQUEST + offset;
              return [`q${index}`, { data: `/unrelated${index}` }];
            },
          ),
        ),
        ...(request === 0 ? { secret: { data: `/copy${TAINTS - 1}` } } : {}),
      },
    }),
  );
  const sends = Array.from(
    { length: Math.ceil(requests.length / REQUESTS_PER_BUTTON) },
    (_, button) => ({
      type: "button",
      label: `Send ${button}`,
      onTap: requests.slice(button * REQUESTS_PER_BUTTON, (button + 1) * REQUESTS_PER_BUTTON),
    }),
  );
  return {
    id: "sensitive-sink-scan",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["auth"] },
    root: { type: "column", children: [...copies, ...sends] },
  };
}

// Prepare the input outside the test; count deterministic scan work, never elapsed time.
const spec = scanSpec();

describe("sensitive sink overlap scan", () => {
  beforeAll(() => {
    expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  });

  test("many taints and unrelated bindings cost bounded overlap checks", () => {
    const result = prototypeSensitiveSinkScan(spec);
    expect(result.errors).toEqual([
      {
        path: `root.children[${COPY_BUTTONS}].onTap[0].query.secret`,
        message: "Sensitive value cannot be bound into a request",
      },
    ]);
    expect(result.checks).toBeLessThanOrEqual(8 * (UNRELATED + 1) + TAINTS);
  });

  test.each([
    ["/user/name", "/rows/{index}/secret", "/long/path/deep", "/é", "/foo/\u0301bar"],
    ["/literal/child", "/literal/{index}/secret"],
    ["/branch/fixed/no", "/branch/{index}/secret"],
    ["/"],
    ["/{index}/secret"],
    [],
  ])("indexed sinks agree with brute-force overlap for taints %j", (...taints: string[]) => {
    const pointers = [
      "",
      "/",
      "/other",
      "/user",
      "/user/name/detail",
      "/user/other",
      "/rows/3",
      "/rows/3/secret/value",
      "/rows/3/plain",
      "/rows/{index}/secret",
      "/{index}/secret",
      "/{index}/missing",
      "/literal/{index}/secret",
      "/literal/child/value",
      "/branch/fixed/secret",
      "/long/path",
      "/é",
      "/e\u0301",
      "/foo",
    ];
    const query = Object.fromEntries(
      pointers.map((pointer, index) => [`q${index}`, { data: pointer }]),
    );
    const result = prototypeSensitiveSinkScan({
      requires: { platform: ["auth"] },
      root: {
        type: "column",
        children: [
          ...taints.map((pointer) => ({ type: "pasteButton", into: `/data${pointer}` })),
          { type: "button", onTap: [{ type: "request", query }] },
        ],
      },
    });
    const expected = pointers.flatMap((pointer, index) => {
      const right = pointer.slice(1).split("/");
      const hit = taints.some((taint) =>
        taint
          .slice(1)
          .split("/")
          .every((left, at) => at >= right.length || left === right[at] || left === "{index}"),
      );
      return hit
        ? [
            {
              path: `root.children[${taints.length}].onTap[0].query.q${index}`,
              message: "Sensitive value cannot be bound into a request",
            },
          ]
        : [];
    });
    expect(result.errors).toEqual(
      expected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    );
  });
});
