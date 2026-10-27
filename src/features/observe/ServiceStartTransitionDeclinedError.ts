import { ActionableError } from "../../models/ActionableError";

/** Readiness admission changed; retry only after an assignment-only transition. */
export class ServiceStartTransitionDeclinedError extends ActionableError {}
