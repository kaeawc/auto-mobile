/**
 * Backward-compatible daemon entry point for the shared interval utility.
 * Daemon-specific consumers keep their existing import path while lower-level
 * monitors can depend on the utility without reversing the layer boundary.
 */
export { SingleFlightInterval } from "../utils/SingleFlightInterval";
