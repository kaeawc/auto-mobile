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
    // /proc/1/cgroup is Linux-only and may not exist (e.g. macOS/Windows); assume non-Docker rather than fail.
    logger.debug(`src/utils/dockerEnv.ts fallback failed: ${error}`, error);
    return false;
  }
}
