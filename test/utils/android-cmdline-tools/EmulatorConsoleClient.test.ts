import { expect, describe, test, beforeEach } from "bun:test";
import {
  consolePortFromSerial,
  EmulatorConsoleAuthTokenReader,
  RealEmulatorConsoleClient,
  EmulatorConsoleTransport,
} from "../../../src/utils/android-cmdline-tools/EmulatorConsoleClient";

class RecordingTransport implements EmulatorConsoleTransport {
  public calls: { host: string; port: number; authToken: string | null; commands: string[] }[] = [];
  public nextOutput: string = "OK\n";
  public failWith: Error | null = null;

  async execute(
    host: string,
    port: number,
    authToken: string | null,
    commands: string[],
  ): Promise<string> {
    this.calls.push({ host, port, authToken, commands });
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
    expect(transport.calls[0].host).toBe("localhost");
    expect(transport.calls[0].port).toBe(5554);
    expect(transport.calls[0].authToken).toBe("test-token");
    expect(transport.calls[0].commands).toEqual(["gsm call +15551234567"]);
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
      "Android Console: type 'help' for a list of commands\nOK\nKO: unknown command\n";
    await expect(client.gsmCall("5551234567")).rejects.toThrow(
      /Emulator console rejected command: unknown command/,
    );
  });

  test("propagates transport errors", async () => {
    transport.failWith = new Error("ECONNREFUSED");
    await expect(client.smsSend("5551234567", "hi")).rejects.toThrow(/ECONNREFUSED/);
  });
});

import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { NetEmulatorConsoleTransport } from "../../../src/utils/android-cmdline-tools/EmulatorConsoleClient";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Minimal EventEmitter-backed stand-in for net.Socket. There is no real fake
 * socket in the repo, so a bare emitter with the surface the transport touches
 * (setEncoding/write/destroy/removeAllListeners) is the only way to drive the
 * wire protocol without opening a real TCP connection.
 */
class FakeSocket extends EventEmitter {
  public written: string[] = [];
  public destroyed = false;
  setEncoding(): this {
    return this;
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

describe("NetEmulatorConsoleTransport wire protocol", () => {
  function makeTransport(socket: FakeSocket, timer: FakeTimer): NetEmulatorConsoleTransport {
    return new NetEmulatorConsoleTransport(() => socket as unknown as net.Socket, 5000, timer);
  }

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
