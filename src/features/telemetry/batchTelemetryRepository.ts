// Thin re-export barrel so TelemetryEventBuffer depends on a single seam rather
// than four separate db modules. Keeping this indirection also gives tests one
// place to point at when they need a fake batch sink (issue #3138).
export { recordLogEvents } from "../../db/logEventRepository";
export { recordOsEvents } from "../../db/osEventRepository";
export { recordNavigationEvents } from "../../db/navigationEventRepository";
export { recordLayoutEvents } from "../../db/layoutEventRepository";
