/**
 * Host validation cost of feed-scale prototype specs at the shared limits (#14183).
 *
 * Not a unit test: wall-clock numbers are machine dependent, so nothing here asserts a time.
 * Run `bun benchmark/prototype-feed-limits.ts` (optionally `--runs N`) and compare rows. The
 * limits come from `schemas/prototype-spec-contract.json`, so the cases track the contract.
 */
import contract from "../schemas/prototype-spec-contract.json";
import { validatePrototypeSpec } from "../src/features/prototype/prototypeValidation";

const limits = contract.limits;
const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag >= 0 ? Math.max(3, Number(process.argv[runsFlag + 1])) : 15;

const base = () => ({
  id: "feed",
  window: { placement: { type: "fullscreen" } },
});

/** A timeline row: header, body text, counters and an action; one template for every row. */
const feedRow = {
  type: "column",
  children: [
    { type: "text", text: "{post.author} ({post.handle})" },
    { type: "text", text: "{post.caption}" },
    { type: "text", text: "{post.likes} likes - {post.comments} comments" },
    { type: "button", label: "Like", onTap: [{ type: "setState", key: "liked", value: true }] },
  ],
};

function feedSpec(rows: number): Record<string, unknown> {
  return {
    ...base(),
    state: { liked: false },
    data: {
      feed: {
        items: Array.from({ length: rows }, (_, id) => ({
          id,
          author: `User ${id}`,
          handle: `@user${id}`,
          caption: `A caption for post number ${id}, long enough to look like a real timeline entry.`,
          likes: id * 3,
          comments: id % 40,
          posted: `2026-10-${String((id % 28) + 1).padStart(2, "0")}`,
        })),
      },
    },
    root: {
      type: "list",
      repeat: { items: { path: "/feed/items" }, as: "post", key: "id" },
      children: [feedRow],
    },
  };
}

function bytesSpec(dataBytes: number): Record<string, unknown> {
  // `{"x":"..."}` costs eight bytes of structure around the string.
  return { ...base(), root: { type: "spacer" }, data: { x: "x".repeat(dataBytes - 8) } };
}

interface Case {
  name: string;
  /** What is handed to the validator: a parsed object, or the raw JSON text. */
  input: () => unknown;
}

const cases: Case[] = [
  { name: "feed 500 rows (previous cap), object", input: () => feedSpec(500) },
  { name: "feed 1000 rows, object", input: () => feedSpec(1000) },
  {
    name: `feed ${limits.MAX_PROTOTYPE_LIST_ITEMS} rows (list cap), object`,
    input: () => feedSpec(limits.MAX_PROTOTYPE_LIST_ITEMS),
  },
  {
    name: `feed ${limits.MAX_PROTOTYPE_LIST_ITEMS} rows (list cap), raw JSON text`,
    input: () => JSON.stringify(feedSpec(limits.MAX_PROTOTYPE_LIST_ITEMS)),
  },
  {
    name: `data string at the data byte cap (${limits.MAX_PROTOTYPE_DATA_BYTES}), raw JSON text`,
    input: () => JSON.stringify(bytesSpec(limits.MAX_PROTOTYPE_DATA_BYTES)),
  },
  {
    name: `data array at the item cap (${limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS}), object`,
    input: () => ({
      ...base(),
      root: { type: "spacer" },
      data: { x: Array.from({ length: limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS }, (_, i) => i) },
    }),
  },
];

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measure(input: unknown): { size: number; times: number[]; ok: boolean } {
  let ok = true;
  const times: number[] = [];
  // Warm up once so JIT and module initialization do not land in the first sample.
  validatePrototypeSpec(input);
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    const result = validatePrototypeSpec(input);
    times.push(performance.now() - start);
    ok &&= result.success;
  }
  const size = typeof input === "string" ? Buffer.byteLength(input) : JSON.stringify(input).length;
  return { size, times: times.sort((a, b) => a - b), ok };
}

console.log(`prototype feed-scale validation (${RUNS} runs each, ms)`);
console.log(
  `limits: list ${limits.MAX_PROTOTYPE_LIST_ITEMS}, data array ${limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS}, ` +
    `data bytes ${limits.MAX_PROTOTYPE_DATA_BYTES}, spec bytes ${limits.MAX_PROTOTYPE_SPEC_BYTES}, ` +
    `repeat cells ${limits.MAX_PROTOTYPE_REPEAT_PATH_CELLS}`,
);
console.log("case".padEnd(70), "bytes".padStart(9), "median".padStart(8), "p95".padStart(8), "ok");
for (const entry of cases) {
  const { size, times, ok } = measure(entry.input());
  console.log(
    entry.name.padEnd(70),
    String(size).padStart(9),
    percentile(times, 0.5).toFixed(1).padStart(8),
    percentile(times, 0.95).toFixed(1).padStart(8),
    ok ? "yes" : "NO",
  );
}
