import { ActionableError } from "../../../models/ActionableError";

/** swiftc exited non-zero with diagnostics: retrying the same sources cannot succeed. */
export class SimHidCompileError extends ActionableError {}
