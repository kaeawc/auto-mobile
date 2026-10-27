import { resolvePrototypeDataPointer } from "./prototypeData";
import { prototypeIntoError, type PrototypeRequestActionError } from "./prototypeRequest";
import { record } from "./prototypeTemplate";

/** Static append checks are shared by authored, component-expanded and repeat-bound actions. */
export function prototypeRequestAppendError(
  action: Record<string, unknown>,
  at: string,
  data?: unknown,
): PrototypeRequestActionError | undefined {
  const append = record(action.append);
  if (typeof append?.to !== "string") {
    return undefined;
  }
  const to = append.to;
  const path = `${at}.append.to`;
  const malformed = prototypeIntoError(to, "request");
  if (malformed) {
    return { path, message: malformed };
  }
  if (
    typeof action.into === "string" &&
    (to === action.into || to.startsWith(`${action.into}/`) || action.into.startsWith(`${to}/`))
  ) {
    return { path, message: "append.to must not overlap into" };
  }
  if (!to.split("/").includes("{index}") && data !== undefined) {
    const target = resolvePrototypeDataPointer(data, to.slice("/data".length));
    if (target !== undefined && !Array.isArray(target)) {
      return { path, message: "append.to must name an array" };
    }
  }
  return undefined;
}
