import { ActionableError } from "../../models";

/**
 * A clearAll step failed because the device was slow, not because the request is wrong: a shade
 * read timed out or came back unreadable or half-rendered, or the app's notification count could
 * not be read. Reading again may succeed, so the drain retries these before it swipes.
 */
export class TransientPreSwipeError extends ActionableError {}
