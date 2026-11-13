import { readFileSync } from "node:fs";
import { observeResultFromJsonText } from "./observeFixture";

const directory = "../fixtures/observe-output/compose-control-shapes-17955/";
const captures = {
  before: observeResultFromJsonText(
    readFileSync(new URL(`${directory}observe-full.json`, import.meta.url), "utf8"),
  ),
  after: observeResultFromJsonText(
    readFileSync(new URL(`${directory}observe-full-after-swipe.json`, import.meta.url), "utf8"),
  ),
  default: observeResultFromJsonText(
    readFileSync(new URL(`${directory}observe-default.json`, import.meta.url), "utf8"),
  ),
};

/** Fresh copies keep the real merged and window trees intact, including duplicate ids. */
export function composeControlShapesObservation(capture: keyof typeof captures = "before") {
  return structuredClone(captures[capture]);
}
