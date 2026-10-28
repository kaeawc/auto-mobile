import { ActionableError } from "../../models";

/** The helper must advertise H.264 encoding support before capture can start. */
export class EncodedUnsupportedError extends ActionableError {}
