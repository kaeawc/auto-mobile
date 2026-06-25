// Constants shared across the application
import { getTempDir, TEMP_SUBDIRS } from "./tempDir";

// Route tool logs through the shared temp tree (honors TMPDIR) instead of a
// hardcoded /tmp path, so all auto-mobile processes agree on the location.
export const LOG_DIR = getTempDir(TEMP_SUBDIRS.TOOL_LOGS);

// Fuzzy screenshot matching tolerance (percentage)
export const DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT = 0.02;

// Error message for cancelled operations
export const OPERATION_CANCELLED_MESSAGE = "Operation cancelled";
