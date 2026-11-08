import { existsSync, readFileSync } from "node:fs";

/** Raw tvOS 26.5 simctl captures; absent output files represent empty streams. */
export function loadTvosSimctlFixture(name: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const file = (extension: string) =>
    new URL(`../fixtures/tvos-simctl/${name}.${extension}`, import.meta.url);
  const output = (extension: string) => {
    const path = file(extension);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return {
    stdout: output("stdout"),
    stderr: output("stderr"),
    exitCode: Number(readFileSync(file("exit"), "utf8").trim()),
  };
}
