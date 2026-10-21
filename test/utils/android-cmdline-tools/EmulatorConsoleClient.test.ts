import { FakeSocket } from "../../fakes/FakeNetServer";
import { expect, describe, test, beforeEach } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { InMemoryEmulatorConsoleBusyRegistry } from "../../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import {
  consolePortFromSerial,
  EmulatorConsoleAuthTokenReader,
  parseConsoleAcknowledgement,
  RealEmulatorConsoleClient,
  EmulatorConsoleTransport,
  AVD_SNAPSHOT_CONSOLE_TIMEOUT_MS,
} from "../../../src/utils/android-cmdline-tools/EmulatorConsoleClient";

class RecordingTransport implements EmulatorConsoleTransport {
  public calls: {
    host: string;
    port: number;
    authToken: string | null;
    commands: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }[] = [];
  public nextOutput: string = "Android Console\nOK\nOK\nOK\n";
  public failWith: Error | null = null;

  async execute(
    host: string,
    port: number,
    authToken: string | null,
    commands: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<string> {
    this.calls.push({ host, port, authToken, commands, signal, timeoutMs });
    if (this.failWith) {
      throw this.failWith;
    }
    return this.nextOutput;
  }
}

class StaticTokenReader implements EmulatorConsoleAuthTokenReader {
  constructor(private token: string | null) {}
  async read(): Promise<string | null> {
    return this.token;
  }
}

describe("consolePortFromSerial", () => {
  test("extracts port from emulator-NNNN serial", () => {
    expect(consolePortFromSerial("emulator-5554")).toBe(5554);
    expect(consolePortFromSerial("emulator-5556")).toBe(5556);
    expect(consolePortFromSerial("emulator-5600")).toBe(5600);
  });

  test("returns null for non-emulator serials", () => {
    expect(consolePortFromSerial("HT85N1A02890")).toBeNull();
    expect(consolePortFromSerial("00008101-001C711E0EE0001E")).toBeNull();
    expect(consolePortFromSerial("emulator-abc")).toBeNull();
    expect(consolePortFromSerial("emulator-")).toBeNull();
    expect(consolePortFromSerial("")).toBeNull();
  });

  test("rejects ports outside the valid TCP range", () => {
    expect(consolePortFromSerial("emulator-0")).toBeNull();
    expect(consolePortFromSerial("emulator-65536")).toBeNull();
  });
});

describe("RealEmulatorConsoleClient", () => {
  let transport: RecordingTransport;
  let tokenReader: StaticTokenReader;
  let client: RealEmulatorConsoleClient;

  beforeEach(() => {
    transport = new RecordingTransport();
    tokenReader = new StaticTokenReader("test-token");
    client = new RealEmulatorConsoleClient(5554, transport, tokenReader);
  });

  test("gsmCall sends `gsm call <number>` with auth token", async () => {
    await client.gsmCall("+15551234567");

    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0].host).toBe("127.0.0.1");
    expect(transport.calls[0].port).toBe(5554);
    expect(transport.calls[0].authToken).toBe("test-token");
    expect(transport.calls[0].commands).toEqual(["gsm call +15551234567"]);
  });

  test("geoFix sends longitude before latitude and accepts empty payload after OK", async () => {
    await client.geoFix(-122.4194, 37.7749);
    expect(transport.calls[0].commands).toEqual(["geo fix -122.4194 37.7749"]);
  });

  test("geoFix forwards cancellation to the transport", async () => {
    const controller = new AbortController();
    await client.geoFix(1, 2, undefined, controller.signal);
    expect(transport.calls[0].signal).toBe(controller.signal);
  });

  test("geoFix rejects non-finite or out-of-range points before opening the console", async () => {
    await expect(client.geoFix(Infinity, 0)).rejects.toThrow("longitude");
    await expect(client.geoFix(0, -91)).rejects.toThrow("latitude");
    expect(transport.calls).toEqual([]);
  });

  test("accepts an explicit OK terminal line", async () => {
    transport.nextOutput = "Android Console\nOK\nOK\nOK\n";
    await expect(client.gsmCall("5551234567")).resolves.toBeUndefined();
  });

  test("accepts CRLF banner, auth, and command acknowledgements", async () => {
    transport.nextOutput = "Android Console\r\nOK\r\nOK\r\nOK\r\n";
    await expect(client.gsmCall("5551234567")).resolves.toBeUndefined();
  });

  test("rejects a close after banner and auth acknowledgements without a command ack", async () => {
    // The first OK is the banner acknowledgement and the second is auth; there
    // is no third terminal line acknowledging the command.
    transport.nextOutput = "Android Console\r\nOK\r\nOK\r\n";
    await expect(client.gsmCall("5551234567")).rejects.toThrow(/closed before acknowledging/);
  });

  test("rejects a response closed before an OK terminal line (#6569)", async () => {
    // Regression for #6569: this fails before the fix because no KO was
    // treated as success, so the call resolves instead of rejecting.
    transport.nextOutput = "";
    await expect(client.gsmCall("5551234567")).rejects.toThrow(/closed before acknowledging/);
  });

  test("rejects partial output without an OK or KO terminal line", async () => {
    transport.nextOutput = "some partial garbage with no terminal line\n";
    await expect(client.gsmCall("5551234567")).rejects.toThrow(/closed before acknowledging/);
  });

  test("propagates transport timeout errors unchanged", async () => {
    const timeout = new ActionableError("Emulator console connection timed out after 5000ms");
    transport.failWith = timeout;
    await expect(client.gsmCall("5551234567")).rejects.toBe(timeout);
  });

  test("accepts data lines before an explicit OK terminal line", async () => {
    transport.nextOutput =
      "Android Console: type 'help' for a list of commands\nOK\nOK\nsome data line\nOK\n";
    await expect(client.gsmCall("5551234567")).resolves.toBeUndefined();
  });

  test("gsmAccept/gsmCancel/gsmBusy each send their respective command", async () => {
    await client.gsmAccept("5551234567");
    await client.gsmCancel("5551234567");
    await client.gsmBusy("5551234567");

    expect(transport.calls.map((c) => c.commands[0])).toEqual([
      "gsm accept 5551234567",
      "gsm cancel 5551234567",
      "gsm busy 5551234567",
    ]);
  });

  test("gsmHold sends `gsm hold` without a number", async () => {
    await client.gsmHold();
    expect(transport.calls[0].commands).toEqual(["gsm hold"]);
  });

  test("smsSend sends `sms send <number> <message>`", async () => {
    await client.smsSend("+15551234567", "Hello, world!");
    expect(transport.calls[0].commands).toEqual(["sms send +15551234567 Hello, world!"]);
  });

  test("falls back to null auth token when reader returns null", async () => {
    client = new RealEmulatorConsoleClient(5554, transport, new StaticTokenReader(null));
    transport.nextOutput = "Android Console\r\nOK\r\nOK\r\n";
    await client.gsmCall("5551234567");
    expect(transport.calls[0].authToken).toBeNull();
  });

  test("invalid phone numbers throw ActionableError before reaching the transport", async () => {
    await expect(client.gsmCall("not-a-number")).rejects.toThrow(/Invalid phone number/);
    await expect(client.gsmCall("5551234567 ; rm -rf /")).rejects.toThrow(/Invalid phone number/);
    await expect(client.smsSend("abc", "hi")).rejects.toThrow(/Invalid phone number/);
    expect(transport.calls.length).toBe(0);
  });

  test("rejects SMS messages with newline or NUL characters", async () => {
    await expect(client.smsSend("5551234567", "line1\nline2")).rejects.toThrow(/newline/);
    await expect(client.smsSend("5551234567", "with\0nul")).rejects.toThrow(/newline/);
    await expect(client.smsSend("5551234567", "")).rejects.toThrow(/must not be empty/);
    expect(transport.calls.length).toBe(0);
  });

  test("rejects SMS messages longer than 1024 characters", async () => {
    const tooLong = "a".repeat(1025);
    await expect(client.smsSend("5551234567", tooLong)).rejects.toThrow(/1024 characters/);
  });

  test("throws ActionableError when transport output contains a KO: response", async () => {
    transport.nextOutput =
      "Android Console: type 'help' for a list of commands\r\nOK\r\nOK\r\nKO: unknown command\r\n";
    await expect(client.gsmCall("5551234567")).rejects.toThrow(
      /Emulator console rejected command: unknown command/,
    );
  });

  test("reports CRLF KO reasons without carriage returns", async () => {
    transport.nextOutput = "Android Console\r\nOK\r\nOK\r\nKO: some reason\r\n";
    const error = await client.gsmCall("5551234567").catch((caught: Error) => caught);
    if (!(error instanceof Error)) {
      throw new Error("Expected console command to fail");
    }
    expect(error.message).toContain("some reason");
    expect(error.message).not.toContain("\r");
  });

  test("propagates transport errors", async () => {
    transport.failWith = new Error("ECONNREFUSED");
    await expect(client.smsSend("5551234567", "hi")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("RealEmulatorConsoleClient device-condition verbs (#14057)", () => {
  let transport: RecordingTransport;
  let registry: InMemoryEmulatorConsoleBusyRegistry;
  let client: RealEmulatorConsoleClient;

  beforeEach(() => {
    transport = new RecordingTransport();
    registry = new InMemoryEmulatorConsoleBusyRegistry();
    client = new RealEmulatorConsoleClient(
      5554,
      transport,
      new StaticTokenReader("test-token"),
      registry,
    );
  });

  test("each verb sends its console command line", async () => {
    await client.powerAc(false);
    await client.powerAc(true);
    await client.powerStatus("discharging");
    await client.powerHealth("overheat");
    await client.powerCapacity(5);
    await client.sensorSet("acceleration", [0, 9.81, 0.5]);
    await client.networkSpeed("edge");
    await client.networkSpeed({ upKbps: 64, downKbps: 128 });
    await client.networkDelay("gprs");
    await client.networkDelay({ minMs: 200, maxMs: 800 });
    await client.gsmData("unregistered");
    await client.gsmVoice("roaming");
    await client.gsmSignal(4, 99);
    await client.fingerTouch(1);
    await client.fingerRemove();
    await client.posture("rotate");
    await client.posture("fold");
    await client.posture("unfold");

    expect(transport.calls.map((call) => call.commands)).toEqual([
      ["power ac off"],
      ["power ac on"],
      ["power status discharging"],
      ["power health overheat"],
      ["power capacity 5"],
      ["sensor set acceleration 0:9.81:0.5"],
      ["network speed edge"],
      ["network speed 64:128"],
      ["network delay gprs"],
      ["network delay 200:800"],
      ["gsm data unregistered"],
      ["gsm voice roaming"],
      ["gsm signal 4 99"],
      ["finger touch 1"],
      ["finger remove"],
      ["rotate"],
      ["fold"],
      ["unfold"],
    ]);
    // Short verbs keep the transport's default deadline.
    expect(transport.calls.every((call) => call.timeoutMs === undefined)).toBe(true);
  });

  test("sensorGet parses the data line printed before the acknowledgement", async () => {
    transport.nextOutput =
      "Android Console\r\nOK\r\nOK\r\nacceleration = 0:9.77622:0.812349\r\nOK\r\n";
    await expect(client.sensorGet("acceleration")).resolves.toEqual([0, 9.77622, 0.812349]);
    expect(transport.calls[0].commands).toEqual(["sensor get acceleration"]);
  });

  test("sensorGet rejects when the console acknowledges without a value line", async () => {
    await expect(client.sensorGet("light")).rejects.toThrow(
      /did not report a value for sensor 'light'/,
    );
  });

  test.each([
    ["powerStatus", () => client.powerStatus("charging")],
    ["sensorSet", () => client.sensorSet("proximity", [1])],
    ["networkDelay", () => client.networkDelay("none")],
    ["gsmData", () => client.gsmData("home")],
    ["fingerTouch", () => client.fingerTouch(2)],
    ["avdSnapshot", () => client.avdSnapshot("load", "fixture")],
    ["posture", () => client.posture("fold")],
  ])("%s rejects with the console's KO reason", async (_name, invoke) => {
    transport.nextOutput = "Android Console\r\nOK\r\nOK\r\nKO: bad argument\r\n";
    await expect(invoke()).rejects.toThrow(/Emulator console rejected command: bad argument/);
  });

  test("invalid arguments are rejected before the console is opened", async () => {
    await expect(client.powerCapacity(101)).rejects.toThrow(/Battery capacity/);
    await expect(client.powerCapacity(12.5)).rejects.toThrow(/Battery capacity/);
    await expect(client.sensorSet("accel\nquit", [1])).rejects.toThrow(/Invalid sensor name/);
    await expect(client.sensorSet("acceleration", [])).rejects.toThrow(/1 to 3 values/);
    await expect(client.gsmSignal(32)).rejects.toThrow(/rssi/);
    await expect(client.fingerTouch(0)).rejects.toThrow(/Fingerprint id/);
    await expect(client.avdSnapshot("save", "two words")).rejects.toThrow(/not valid/);
    expect(transport.calls).toEqual([]);
  });

  test("avdSnapshot uses the console verb spelling, a long deadline, and the caller's signal", async () => {
    const controller = new AbortController();
    await client.avdSnapshot("save", "rooted-fixture", controller.signal);
    await client.avdSnapshot("delete", "rooted-fixture");

    expect(transport.calls.map((call) => call.commands)).toEqual([
      ["avd snapshot save rooted-fixture"],
      ["avd snapshot del rooted-fixture"],
    ]);
    expect(transport.calls[0].timeoutMs).toBe(AVD_SNAPSHOT_CONSOLE_TIMEOUT_MS);
    expect(transport.calls[0].signal).toBe(controller.signal);
  });

  test("avdSnapshot marks the emulator console busy until the exchange settles", async () => {
    const busyDuringExchange: boolean[] = [];
    const generationBefore = registry.getGeneration("emulator-5554");
    transport.execute = async () => {
      busyDuringExchange.push(registry.isBusy("emulator-5554"));
      return "Android Console\nOK\nOK\nKO: snapshot failed\n";
    };

    await expect(client.avdSnapshot("load", "fixture")).rejects.toThrow(/snapshot failed/);

    expect(busyDuringExchange).toEqual([true]);
    expect(registry.isBusy("emulator-5554")).toBe(false);
    expect(registry.getGeneration("emulator-5554")).toBe(generationBefore + 2);
  });

  test("non-snapshot verbs do not mark the console busy", async () => {
    await client.powerAc(true);
    expect(registry.getGeneration("emulator-5554")).toBe(0);
  });
});

describe("parseConsoleAcknowledgement", () => {
  test("succeeds with exactly one OK per command after banner and auth", () => {
    expect(parseConsoleAcknowledgement("OK\r\nOK\r\nOK\r\n", true, 1)).toEqual({ ok: true });
  });

  test("fails with one fewer OK than commands after banner and auth", () => {
    expect(parseConsoleAcknowledgement("OK\r\nOK\r\nOK\r\n", true, 2)).toEqual({
      ok: false,
    });
  });

  test("fails with a post-skip KO and reports its reason", () => {
    expect(parseConsoleAcknowledgement("OK\r\nOK\r\nKO: rejected\r\n", true, 1)).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  test("skips only the banner acknowledgement when there is no auth token", () => {
    expect(parseConsoleAcknowledgement("OK\r\nOK\r\n", false, 1)).toEqual({ ok: true });
    expect(parseConsoleAcknowledgement("OK\r\n", false, 1)).toEqual({ ok: false });
  });
});

import { NetEmulatorConsoleTransport } from "../../../src/utils/android-cmdline-tools/EmulatorConsoleClient";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Minimal EventEmitter-backed stand-in for net.Socket. There is no real fake
 * socket in the repo, so a bare emitter with the surface the transport touches
 * (setEncoding/write/destroy/removeAllListeners) is the only way to drive the
 * wire protocol without opening a real TCP connection.
 */

describe("NetEmulatorConsoleTransport wire protocol", () => {
  function makeTransport(socket: FakeSocket, timer: FakeTimer): NetEmulatorConsoleTransport {
    return new NetEmulatorConsoleTransport(() => socket, 5000, timer);
  }

  test("abort closes an in-flight socket and clears its deadline", async () => {
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const pending = makeTransport(socket, timer).execute(
      "localhost",
      5554,
      null,
      ["geo fix 1 2"],
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(socket.written).toEqual([]);
  });

  test("sends the auth line, each command, and a trailing quit on connect", async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(socket, new FakeTimer());

    const pending = transport.execute("localhost", 5554, "s3cr3t", ["gsm call 5551234567"]);
    socket.emit("connect");
    socket.emit("data", "OK\n");
    socket.emit("close");

    await pending;
    expect(socket.written).toEqual(["auth s3cr3t\ngsm call 5551234567\nquit\n"]);
  });

  test("omits the auth line when no token is provided", async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(socket, new FakeTimer());

    const pending = transport.execute("localhost", 5554, null, ["sms send 5551234567 hi"]);
    socket.emit("connect");
    socket.emit("close");

    await pending;
    expect(socket.written).toEqual(["sms send 5551234567 hi\nquit\n"]);
  });

  test("resolves with the aggregated server output when the socket closes", async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(socket, new FakeTimer());

    const pending = transport.execute("localhost", 5554, null, ["gsm hold"]);
    socket.emit("connect");
    socket.emit("data", "Android Console\n");
    socket.emit("data", "OK\n");
    socket.emit("close");

    expect(await pending).toBe("Android Console\nOK\n");
  });

  test("rejects with an actionable timeout when the connection never settles", async () => {
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const transport = makeTransport(socket, timer);

    const pending = transport.execute("localhost", 5554, null, ["gsm hold"]);
    // No connect/close: only the timer fires.
    timer.advanceTime(5000);

    await expect(pending).rejects.toThrow(/timed out after 5000ms/);
    expect(socket.destroyed).toBe(true);
  });

  test("a per-call timeout overrides the transport default", async () => {
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const pending = makeTransport(socket, timer).execute(
      "localhost",
      5554,
      null,
      ["avd snapshot save fixture"],
      undefined,
      30_000,
    );
    timer.advanceTime(5000);
    expect(socket.destroyed).toBe(false);
    timer.advanceTime(25_000);
    await expect(pending).rejects.toThrow(/timed out after 30000ms/);
  });

  test("rejects when the socket errors before settling", async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(socket, new FakeTimer());

    const pending = transport.execute("localhost", 5554, null, ["gsm hold"]);
    socket.emit("error", new Error("ECONNREFUSED"));

    await expect(pending).rejects.toThrow(/failed: ECONNREFUSED/);
  });

  test("settles once: a later close does not override the first error settle", async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(socket, new FakeTimer());

    const pending = transport.execute("localhost", 5554, null, ["gsm hold"]);
    socket.emit("error", new Error("ECONNRESET"));
    // A stray close after the error settle must not flip the rejection into a resolve.
    socket.emit("close");

    await expect(pending).rejects.toThrow(/failed: ECONNRESET/);
  });
});
