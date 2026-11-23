import { writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";

// Reuse one source across sibling repeats so the 65K-cell fixtures stay small.
// Outer id costs one cell; collection-valued fields do not count as scalar cells.
const limit = contract.limits.MAX_PROTOTYPE_REPEAT_PATH_CELLS;
const innerLimit = contract.limits.MAX_PROTOTYPE_INNER_REPEAT_ITEMS;
const width = 10;
const chunk = innerLimit * width;
const repetitions = Math.floor((limit - 1) / chunk);
const remainder = limit - 1 - repetitions * chunk;
const row = (fields: number) =>
  Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, 0]));
const rows = (cells: number) =>
  Array.from({ length: Math.ceil(cells / width) }, (_, i) =>
    row(Math.min(width, cells - i * width)),
  );
const nested = (field: string) => ({
  type: "column",
  repeat: { items: { field }, as: "line" },
  children: [],
});
function spec(extra: number) {
  return {
    id: "nested-cell-boundary",
    window: { placement: { type: "fullscreen" } },
    data: { orders: [{ id: "A", lines: rows(chunk), tail: rows(remainder + extra) }] },
    root: {
      type: "column",
      repeat: { items: { path: "/orders" }, as: "order" },
      children: [...Array.from({ length: repetitions }, () => nested("lines")), nested("tail")],
    },
  };
}
const directory = new URL("../../test/fixtures/prototype-spec/", import.meta.url);
writeFileSync(new URL("repeat/nested-cell-limit.json", directory), `${JSON.stringify(spec(0))}\n`);
writeFileSync(
  new URL("invalid/nested-repeat-cell-limit.json", directory),
  `${JSON.stringify({
    spec: spec(1),
    expectedPath: `root.children[${repetitions}].repeat.items.field`,
    expectedMessage: "Repeat path cell limit exceeded",
  })}\n`,
);
