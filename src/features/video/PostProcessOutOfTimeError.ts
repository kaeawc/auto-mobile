import { ActionableError } from "../../models";

/**
 * ffmpeg ran out of its time (or the stop request had none left to give it), as opposed to
 * failing. The raw capture is returned for either, but the warning says which.
 */
export class PostProcessOutOfTimeError extends ActionableError {}
