/**
 * An invalid locale, text scale or device frame id given to the prototype web renderer. It is a
 * plain Error so the still renderer's browser bundle stays free of the server's ActionableError
 * (#16811); every server entry point maps it with `withActionableWebInput` so the client still
 * receives the message.
 */
export class PrototypeWebInputError extends Error {
  override readonly name = "PrototypeWebInputError";
}
