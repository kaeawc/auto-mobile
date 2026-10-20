// Public entry point; implementation modules keep schemas, dispatch and host state separate.
export {
  PROTOTYPE_TOOL_NAME,
  prototypeSchema,
  prototypeOutputSchema,
  isPrototypeReadAction,
} from "./prototypeTools/schemas";
export type { PrototypeEventLifecycle } from "./prototypeLifecycle";
export type { PrototypeToolDependencies } from "./prototypeTools/types";
export { registerPrototypeTools } from "./prototypeTools/registration";
export { specCapabilityRefusal } from "./prototypeTools/preflight";
