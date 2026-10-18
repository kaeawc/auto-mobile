import { ActionableError } from "../../models";

/** Offline discovery failed; callers must retain the prior episode state. */
export class AndroidOfflineProbeError extends ActionableError {}
