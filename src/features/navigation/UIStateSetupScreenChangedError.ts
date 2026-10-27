import { ActionableError } from "../../models/ActionableError";

/** A setup gesture left the source screen; replay must stop, including fallback edges. */
export class UIStateSetupScreenChangedError extends ActionableError {}
