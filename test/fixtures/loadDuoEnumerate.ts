import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDuoEnumerate(): string {
  return readFileSync(join(import.meta.dir, "duo-enumerate.txt"), "utf8").replace(/\r\n/g, "\n");
}
