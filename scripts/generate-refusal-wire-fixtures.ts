import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REFUSAL_FIXTURES_DIR,
  buildRefusalWireFixtures,
  serializeRefusalFixture,
} from "../test/helpers/refusalWireFixtures";

/**
 * Rewrites test/fixtures/refusal-wire/<code>.json from the real TypeScript builders. The JUnit
 * runner and XCTestRunner decode the same files, classified per `expectations.json` there.
 * Run after adding or changing a daemon refusal: `bun scripts/generate-refusal-wire-fixtures.ts`.
 */
mkdirSync(REFUSAL_FIXTURES_DIR, { recursive: true });
for (const fixture of buildRefusalWireFixtures()) {
  writeFileSync(
    join(REFUSAL_FIXTURES_DIR, `${fixture.code}.json`),
    serializeRefusalFixture(fixture),
  );
}
console.log(`wrote refusal fixtures to ${REFUSAL_FIXTURES_DIR}`);
