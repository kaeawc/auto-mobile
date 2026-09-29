import { expect, test } from "bun:test";
import { toPosixPath } from "../../scripts/check-utils-import-direction";

test("normalizes Windows source and target paths for baseline edges", () => {
  const file = toPosixPath("src\\utils\\toolUtils.ts");
  const target = toPosixPath("src\\server\\deviceLossOutcome");

  expect(`${file} -> ${target}`).toBe("src/utils/toolUtils.ts -> src/server/deviceLossOutcome");
  expect(toPosixPath("src/utils/toolUtils.ts")).toBe("src/utils/toolUtils.ts");
});
