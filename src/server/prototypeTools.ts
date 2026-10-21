// Public entry point; implementation modules keep schemas, dispatch and host state separate.
export {
  prototypeSchema,
  prototypeOutputSchema,
  isPrototypeReadAction,
} from "./prototypeTools/schemas";
export type { PrototypeEventLifecycle } from "./prototypeLifecycle";
export { registerPrototypeTools } from "./prototypeTools/registration";
