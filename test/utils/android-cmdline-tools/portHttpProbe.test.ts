import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdbReverseCommands } from "../../../src/utils/android-cmdline-tools/adbReverse";
import {
  parsePortHttpProbeOutput,
  portHttpProbeScript,
} from "../../../src/utils/android-cmdline-tools/portHttpProbe";

// Captured by running portHttpProbeScript with `sh -c` on a Linux host (OpenBSD netcat 1.226)
// against real loopback servers: a Python http.server answering /metadata with 200 and anything
// else with 404, a server that closes at once, one that never answers, and one that sends an SSH
// banner. Toybox captures through a reverse are listed for the device lane.
const http = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/port-reverse-http-probe", name), "utf8");
// Toybox captures of the TCP probe (API 35 emulator). This script runs the same `timeout nc` and
// prints the same exit marker, and both outcomes end before any request byte is sent.
const tcp = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/port-reverse-probe", name), "utf8");

describe("port HTTP probe", () => {
  test("a status line is a response with the body after the headers", () => {
    expect(parsePortHttpProbeOutput(http("status-200.txt"))).toEqual({
      kind: "response",
      status: 200,
      body: '{"name":"mock-backend","ready":true}',
    });
    expect(parsePortHttpProbeOutput(http("status-404.txt"))).toEqual({
      kind: "response",
      status: 404,
      body: "not found",
    });
  });

  test("a close without a response, or a non-HTTP answer, is no_response", () => {
    expect(parsePortHttpProbeOutput(http("closed-without-response.txt"))).toEqual({
      kind: "no_response",
      detail: "connection closed without a response",
    });
    expect(parsePortHttpProbeOutput(http("non-http-banner.txt"))).toEqual({
      kind: "no_response",
      detail: "SSH-2.0-OpenSSH_9.6",
    });
  });

  test("a connection that stays silent until the device timeout is timeout", () => {
    expect(parsePortHttpProbeOutput(http("no-response-timeout.txt"))).toEqual({ kind: "timeout" });
  });

  test("a refused connect and a missing binary keep their TCP-probe meaning", () => {
    expect(parsePortHttpProbeOutput(tcp("refused.txt"))).toEqual({ kind: "refused" });
    expect(parsePortHttpProbeOutput(tcp("missing-binary.txt"))).toEqual({
      kind: "unsupported",
      detail: "timeout: exec nonexistentnc: No such file or directory",
    });
    expect(parsePortHttpProbeOutput("")).toEqual({ kind: "unsupported", detail: "no output" });
  });

  test("the request lines are printf arguments, so % and quotes in the path are literal", () => {
    expect(portHttpProbeScript(8081, { path: "/a%20b?x='1'", timeoutSeconds: 2 })).toBe(
      "(printf '%s\\r\\n' 'GET /a%20b?x='\\''1'\\'' HTTP/1.0' 'Host: localhost:8081' " +
        "'Connection: close' ''; sleep 2.1) | timeout 2 nc -w 2 127.0.0.1 8081 2>&1; " +
        'printf "\\nautomobile-probe-exit=%s\\n" $?',
    );
  });

  test("a path or Host header that is not plain printable ASCII is refused", () => {
    expect(() => portHttpProbeScript(8081, { path: "health", timeoutSeconds: 1 })).toThrow();
    expect(() => portHttpProbeScript(8081, { path: "/a b", timeoutSeconds: 1 })).toThrow();
    expect(() =>
      portHttpProbeScript(8081, { path: "/", hostHeader: "x\r\nEvil: 1", timeoutSeconds: 1 }),
    ).toThrow();
  });

  test("httpProbe runs one shell command bounded past the device timeout", async () => {
    const commands: string[] = [];
    const timeouts: (number | undefined)[] = [];
    const reverse = createAdbReverseCommands({
      executeCommand: async (command: string, options?: { timeoutMs?: number }) => {
        commands.push(command);
        timeouts.push(options?.timeoutMs);
        return { stdout: http("status-200.txt"), stderr: "" } as never;
      },
    });
    const request = { path: "/metadata", hostHeader: "api.local:3000", timeoutSeconds: 2 };
    expect(await reverse.httpProbe(3000, request)).toMatchObject({ kind: "response", status: 200 });
    expect(commands).toEqual([
      `shell sh -c ${"'" + portHttpProbeScript(3000, request).replaceAll("'", "'\\''") + "'"}`,
    ]);
    expect(timeouts).toEqual([5000]);
  });
});
