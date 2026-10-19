/** An Error carrying a string `code`, like a Node errno error or a structured daemon refusal. */
export class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
