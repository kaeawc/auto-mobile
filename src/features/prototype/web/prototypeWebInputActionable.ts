import { ActionableError } from "../../../models/ActionableError";
import { PrototypeWebInputError } from "./prototypeWebInputError";

/**
 * Runs a server entry point into the prototype web renderer, surfacing its invalid-input errors as
 * ActionableError with the same message, as the server's error paths branch on that class.
 */
export function withActionableWebInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof PrototypeWebInputError) {
      throw new ActionableError(error.message, { cause: error });
    }
    throw error;
  }
}
