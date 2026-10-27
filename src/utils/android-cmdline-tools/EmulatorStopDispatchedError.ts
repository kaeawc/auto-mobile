import { ActionableError } from "../../models/ActionableError";

/** A stop reached the console or signaler; a late exit must remain intentional. */
export class EmulatorStopDispatchedError extends ActionableError {}
