import fs from "node:fs";
import { logger } from "./logger";

export function isRunningInDocker(): boolean {
  try {
    if (fs.existsSync("/.dockerenv")) {
      return true;
    }

    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return cgroup.includes("docker") || cgroup.includes("containerd");
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/utils/dockerEnv.ts fallback failed: ${error}`, error);
    return false;
  }
}
