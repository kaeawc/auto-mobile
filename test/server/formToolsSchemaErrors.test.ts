import { expect, test } from "bun:test";
import { setUIStateSchema } from "../../src/server/formTools";
import { formatToolParamError } from "../../src/server/toolParamError";

// #6931: this production strict selector is not union-derived, but a misplaced
// selector key can still be a real parameter of the enclosing tool and needs
// the same relocation hint as union-derived unrecognized-key issues.
test("setUIState points a strict nested unknown key at its top-level parameter", () => {
  const input = {
    fields: [{ selector: { elementId: "id", scrollDirection: "down" }, value: "x" }],
  };
  const result = setUIStateSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected invalid setUIState input");
  }

  expect(formatToolParamError("setUIState", result.error, input, setUIStateSchema)).toContain(
    'fields.0.selector Unrecognized key: "scrollDirection" — did you mean the top-level "scrollDirection" parameter?',
  );
});
