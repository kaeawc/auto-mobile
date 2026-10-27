import type { Located } from "./prototypeBindingValidation";
import { prototypeChoreographyError } from "./prototypeChoreography";
import { prototypeMotionV3Error } from "./prototypeMotionV3";
import { prototypeMotionV2Error } from "./prototypeMotionV2";
import { prototypeLoopsError } from "./prototypeLoops";

/** Motion and choreography share the same located nodes and deterministic error order. */
export function prototypeMotionErrors(nodes: Located[]) {
  return (
    prototypeMotionV3Error(nodes) ??
    prototypeLoopsError(nodes) ??
    prototypeMotionV2Error(nodes) ??
    prototypeChoreographyError(nodes)
  );
}
