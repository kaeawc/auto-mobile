import { describe, expect, test } from "bun:test";
import { restartOptionsForLostDaemon } from "../../../src/daemon/proxy/startupOptions";

describe("restartOptionsForLostDaemon", () => {
  test("requested concrete values override observed values while active flags survive false", () => {
    expect(
      restartOptionsForLostDaemon(
        { options: { port: 3195, host: "127.0.0.1", strictPort: true, debug: true } },
        { port: 4195, host: "localhost", strictPort: false, debug: false },
      ),
    ).toEqual({ port: 4195, host: "localhost", strictPort: true, debug: true });
  });

  test("undefined cannot erase any observed startup option", () => {
    expect(
      restartOptionsForLostDaemon(
        { options: { port: 3195, host: "127.0.0.1", debug: true, videoFps: 30 } },
        { port: undefined, host: undefined, debug: undefined, videoFps: undefined },
      ),
    ).toEqual({ port: 3195, host: "127.0.0.1", debug: true, videoFps: 30 });
  });

  test("prefers the recorded options port and falls back to the status port", () => {
    expect(restartOptionsForLostDaemon({ port: 4195, options: { port: 3195 } }, undefined)).toEqual(
      {
        port: 3195,
      },
    );
    expect(restartOptionsForLostDaemon({ port: 3195, options: { port: undefined } }, {})).toEqual({
      port: 3195,
    });
  });

  test("keeps requested child tool defaults and excludes observed connection presentation", () => {
    expect(
      restartOptionsForLostDaemon(
        { port: 3195, options: { enabledTools: ["tapOn"], disabledTools: ["observe"] } },
        {
          enabledTools: ["observe"],
          disabledTools: ["clipboard"],
          toolResultsNoStructuredContent: true,
          actionsCompactMetadata: true,
        },
      ),
    ).toEqual({ port: 3195, enabledTools: ["observe"], disabledTools: ["clipboard"] });
  });

  test("does not mutate the observed or requested records", () => {
    const options = Object.freeze({ port: 3195, debug: true });
    const observed = Object.freeze({ options });
    const requested = Object.freeze({ port: undefined, debug: false });
    expect(restartOptionsForLostDaemon(observed, requested)).toEqual(options);
    expect(requested).toEqual({ port: undefined, debug: false });
  });
});
