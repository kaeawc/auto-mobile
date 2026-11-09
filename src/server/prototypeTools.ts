// Public entry point; implementation modules keep schemas, dispatch and host state separate.
// It imports the runtime eagerly. The server registers through `prototypeTools/registration`
// instead, which imports the runtime on the tool's first call (#17709).
import { loadedFeatureModule } from "../utils/lazyFeatureModule";
import { registerPrototypeTools as registerWithRuntime } from "./prototypeTools/registration";
import * as prototypeToolRuntime from "./prototypeTools/runtime";
import type { PrototypeToolDependencies } from "./prototypeTools/types";

export {
  prototypeSchema,
  prototypeOutputSchema,
  isPrototypeReadAction,
} from "./prototypeTools/schemas";
export type { PrototypeEventLifecycle } from "./prototypeLifecycle";

const loadedRuntime = loadedFeatureModule(prototypeToolRuntime);

/** Registers the prototype tool with its runtime already loaded: built at registration. */
export function registerPrototypeTools(dependencies: PrototypeToolDependencies = {}): () => void {
  return registerWithRuntime(dependencies, loadedRuntime);
}
