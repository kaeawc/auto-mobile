import { expect, test } from "bun:test";
import { driftedEmbeddingSamples } from "../../../scripts/prototype/generateEmbeddingSamples";

// The committed embedding samples are the automobile:prototype/native resource's own output
// (#13732) and the automobile:prototype/eject scaffold (#16499), so CI compiles exactly what an
// agent receives. Regenerate them with
// `bun scripts/prototype/generateEmbeddingSamples.ts` after a template or emitter change.
test("committed embedding samples match the native resource output", async () => {
  expect(await driftedEmbeddingSamples()).toEqual([]);
});
