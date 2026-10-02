/** Reads the current caller without coupling quarantine policy to execution tracking. */
export interface AmbientExecutionIdReader {
  getExecutionId(): string | undefined;
}
