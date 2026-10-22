import { beforeAll, expect, test } from "bun:test";
import { serializeBundleCorpus } from "../../../scripts/prototype/generate-bundle-corpus";
import corpusText from "../../fixtures/prototype-bundle/corpus.json" with { type: "text" };

beforeAll(() => {
  serializeBundleCorpus();
});

test("regenerating the full corpus matches the checked-in text", () => {
  // Warm deterministic DEFLATE inputs in beforeAll; every ZIP/header/manifest is rebuilt here.
  // No case or serialized corpus is cached, and all bytes still compare with the checked-in text.
  // Compare text as well as structure: fixed key order and newline are part of generator stability.
  const generated = serializeBundleCorpus();
  expect<unknown>(generated).toBe(corpusText);
});
