import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ManagedPythonEnvProvisioner,
  BLE_PYTHON_PINS,
} from "../../../src/features/blePeripheral/PythonEnvProvisioner";
import { ActionableError } from "../../../src/models/ActionableError";
import { shellQuote } from "../../../src/utils/shellQuote";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

function setup() {
  const files = new FakeFileSystem();
  const commands = new FakeHostCommandExecutor();
  const directory = join("fake", "data", "ble-peripheral");
  const python = join(directory, "venv", "bin/python3");
  const env = new ManagedPythonEnvProvisioner({
    files,
    commands,
    directory: () => directory,
    platform: "linux",
  });
  return { files, commands, directory, python, env };
}

describe("managed BLE Python environment", () => {
  test("first start creates a venv and installs the exact pins; concurrent starts share work", async () => {
    const { env, commands, directory, files, python } = setup();
    expect(await Promise.all([env.ensure(), env.ensure()])).toEqual([python, python]);
    expect(commands.getExecutedCalls().map(({ command, args }) => [command, args])).toEqual([
      ["python3", ["--version"]],
      ["python3", ["-m", "venv", join(directory, "venv")]],
      [python, ["-I", "-m", "pip", "install", ...BLE_PYTHON_PINS]],
    ]);
    expect(await files.readFile(join(directory, "pins.json"))).toBe(
      JSON.stringify(BLE_PYTHON_PINS),
    );
    files.setFile(python, "fake executable");
    await env.ensure();
    expect(commands.getExecutedCalls()).toHaveLength(3);
  });

  test("changed pins reinstall and a missing executable recreates the venv", async () => {
    const { env, commands, directory, files, python } = setup();
    files.setFile(python, "fake executable");
    files.setFile(join(directory, "pins.json"), "old pin set");
    await env.ensure();
    expect(commands.getExecutedCalls()).toHaveLength(2);
    expect(commands.wasCommandExecuted("-m venv")).toBe(false);
    await files.unlink(python);
    await env.ensure();
    expect(commands.wasCommandExecuted("-m venv")).toBe(true);
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
});
