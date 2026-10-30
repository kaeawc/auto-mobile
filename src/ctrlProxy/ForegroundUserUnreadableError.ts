import { ActionableError } from "../models/ActionableError";

/** The foreground-user command answered before Android could report a numeric user. */
export class ForegroundUserUnreadableError extends ActionableError {}
