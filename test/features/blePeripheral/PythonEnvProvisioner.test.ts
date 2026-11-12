import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ManagedPythonEnvProvisioner,
  BLE_PYTHON_PINS,
} from "../../../src/features/blePeripheral/PythonEnvProvisioner";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecResult } from "../../../src/models";
import { shellQuote } from "../../../src/utils/shellQuote";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeDirectoryLock } from "../../fakes/FakeDirectoryLock";

function pythonVersion(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

function setup() {
  const files = new FakeFileSystem();
  const commands = new FakeHostCommandExecutor();
  commands.setCommandResponse("python3 --version", pythonVersion("Python 3.12.4\n"));
  const directory = join("fake", "data", "ble-peripheral");
  const python = join(directory, "venv", "bin/python3");
  const lock = new FakeDirectoryLock();
  const create = () =>
    new ManagedPythonEnvProvisioner({
      files,
      commands,
      directory: () => directory,
      platform: "linux",
      lock,
    });
  return { files, commands, directory, python, lock, create, env: create() };
}

describe("managed BLE Python environment", () => {
  test("first start creates a venv and installs the exact pins; concurrent starts share work", async () => {
    const { env, commands, directory, files, python } = setup();
    expect(await Promise.all([env.ensure(), env.ensure()])).toEqual([python, python]);
    expect(commands.getExecutedCalls().map(({ command, args }) => [command, args])).toEqual([
      ["python3", ["--version"]],
      ["python3", ["-m", "venv", "--clear", join(directory, "venv")]],
      [python, ["-I", "-m", "pip", "install", ...BLE_PYTHON_PINS]],
    ]);
    expect(await files.readFile(join(directory, "pins.json"))).toBe(
      JSON.stringify(BLE_PYTHON_PINS),
    );
    files.setFile(python, "fake executable");
    await env.ensure();
    expect(commands.getExecutedCalls()).toHaveLength(3);
  });

  test("changed pins, a missing marker or a missing interpreter rebuild the venv", async () => {
    const { env, commands, directory, files, python } = setup();
    const marker = join(directory, "pins.json");
    // A half-created venv: the interpreter exists but no install ever completed (no marker, maybe no pip).
    files.setFile(python, "fake executable");
    await env.ensure();
    expect(
      commands.getExecutedCommands().filter((c) => c.includes("-m venv --clear")),
    ).toHaveLength(1);
    files.setFile(marker, "old pin set");
    await env.ensure();
    await files.unlink(python);
    await env.ensure();
    expect(
      commands.getExecutedCommands().filter((c) => c.includes("-m venv --clear")),
    ).toHaveLength(3);
    expect(await files.readFile(marker)).toBe(JSON.stringify(BLE_PYTHON_PINS));
  });

  test.each([
    ["Python 3.10.12\n", "", /reports 3\.10/],
    ["", "Python 2.7.18\n", /reports 2\.7/],
    ["not python", "", /unrecognized version/],
  ])("python3 below 3.11 is refused before any venv work: %j", async (stdout, stderr, message) => {
    const { env, commands, files } = setup();
    commands.setCommandResponse("python3 --version", pythonVersion(stdout, stderr));
    await expect(env.ensure()).rejects.toThrow(message);
    await expect(env.ensure()).rejects.toThrow(/needs Python 3\.11\+/);
    expect(commands.wasCommandExecuted("-m venv")).toBe(false);
    expect(files.getWrittenFiles().size).toBe(0);
  });

  test("missing python3 throws an actionable exact fix before creating the environment", async () => {
    const { env, commands, files } = setup();
    commands.setCommandError("python3 --version", new Error("ENOENT"));
    await expect(env.ensure()).rejects.toBeInstanceOf(ActionableError);
    await expect(env.ensure()).rejects.toThrow(/Install Python 3.11 with venv support/);
    expect(files.getWrittenFiles().size).toBe(0);
    expect(commands.wasCommandExecuted("pip")).toBe(false);
  });

  test("pip failures include exact repair pins and never write a success marker", async () => {
    const { env, commands, files, python } = setup();
    commands.setCommandError("pip install", new Error("network unavailable"));
    await expect(env.ensure()).rejects.toThrow(
      `${shellQuote(python)} -I -m pip install ${BLE_PYTHON_PINS.join(" ")}`,
    );
    expect(files.getWrittenFiles().size).toBe(0);
  });

  test("provisioning runs under the directory lock; two processes sharing it build the venv once", async () => {
    const { env, create, commands, directory, files, lock, python } = setup();
    // The fake venv command creates nothing, so model the interpreter it would leave behind.
    files.setFile(python, "fake executable");
    // Each provisioner models a separate daemon process: no shared in-memory pending promise.
    expect(await Promise.all([env.ensure(), create().ensure()])).toEqual([python, python]);
    expect(lock.acquired).toEqual([directory, directory]);
    expect(
      commands.getExecutedCommands().filter((c) => c.includes("-m venv --clear")),
    ).toHaveLength(1);
  });

  test("a venv another process finished while this one waited is reused without --clear", async () => {
    const { env, commands, directory, files, lock, python } = setup();
    lock.onAcquire = () => {
      files.setFile(python, "fake executable");
      files.setFile(join(directory, "pins.json"), JSON.stringify(BLE_PYTHON_PINS));
    };
    expect(await env.ensure()).toBe(python);
    expect(commands.wasCommandExecuted("-m venv")).toBe(false);
    expect(commands.wasCommandExecuted("pip")).toBe(false);
  });

  test("a lock timeout fails provisioning without touching the venv", async () => {
    const { env, commands, files, lock } = setup();
    lock.error = new ActionableError("Timed out waiting for the BLE Python environment lock");
    await expect(env.ensure()).rejects.toThrow(/Timed out waiting for the BLE Python environment/);
    expect(commands.wasCommandExecuted("-m venv")).toBe(false);
    expect(files.getWrittenFiles().size).toBe(0);
  });
});
