import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  FileSigningKeyLock,
  HostKeystoreSigner,
  type SigningKeyLock,
} from "../../../../../src/features/prototype/disposableApp/android/DisposableAppSigner";
import type { HostCommandOptions } from "../../../../../src/utils/HostCommandExecutor";
import type { ExecResult } from "../../../../../src/models";
import { FakeTimer } from "../../../../fakes/FakeTimer";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../../fakes/FakeHostCommandExecutor";
import { CountingIdGenerator } from "../../../../../src/utils/IdGenerator";

test("creates PKCS12 lazily once and passes password files to keytool and apksigner", async () => {
  const fs = new FakeFileSystem();
  const executor = new FakeHostCommandExecutor();
  const signer = new HostKeystoreSigner("/temporary-test/key", {
    executor,
    fs,
    ids: new CountingIdGenerator(),
    lock: new SerialLock(),
  });
  expect(executor.getExecutedCalls()).toEqual([]);
  await signer.sign("/tools/apksigner", "/aligned.apk", "/signed.apk");
  await signer.sign("/tools/apksigner", "/aligned.apk", "/signed.apk");
  const calls = executor.getExecutedCalls();
  expect(calls.filter((call) => call.args.includes("-genkeypair"))).toHaveLength(1);
  expect(calls[0]?.args).toContain("PKCS12");
  expect(calls[0]?.args).toContain("-storepass:file");
  expect(calls[1]?.args).toContain(`file:${join("/temporary-test/key", "password")}`);
  expect(calls[1]?.args).toContain("--v2-signing-enabled");
  expect(calls[1]?.args).toContain("--v3-signing-enabled");
  const password = await fs.readFileBuffer("/temporary-test/key/password");
  expect(executor.getExecutedCommands().join("\n")).not.toContain(password.toString());
});
test("signs with a Windows apksigner.bat through the command processor", async () => {
  const fs = new FakeFileSystem();
  fs.setFile("/temporary-test/key/host.p12", "key");
  fs.setFile("/temporary-test/key/password", "password");
  const executor = new FakeHostCommandExecutor();
  const signer = new HostKeystoreSigner("/temporary-test/key", {
    executor,
    fs,
    lock: new SerialLock(),
  });
  await signer.sign("C:\\sdk\\apksigner.bat", "in.apk", "out.apk");
  const call = executor.getExecutedCalls()[0];
  expect(call?.command.toLowerCase()).toEndWith("cmd.exe");
  expect(call?.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  expect(call?.args[4]).toStartWith('""C:\\sdk\\apksigner.bat" "sign"');
});
test("reuses existing key and refuses lost password without rotating identity", async () => {
  const fs = new FakeFileSystem();
  fs.setFile("/temporary-test/key/host.p12", "key");
  const executor = new FakeHostCommandExecutor();
  const signer = new HostKeystoreSigner("/temporary-test/key", {
    executor,
    fs,
    lock: new SerialLock(),
  });
  await expect(signer.sign("apksigner", "in", "out")).rejects.toThrow("password file is missing");
  expect(executor.getExecutedCalls()).toEqual([]);
});
test("bad exported certificate is actionable", async () => {
  const fs = new FakeFileSystem();
  fs.setFile("/temporary-test/key/host.p12", "key");
  fs.setFile("/temporary-test/key/password", "password");
  await expect(
    new HostKeystoreSigner("/temporary-test/key", {
      executor: new FakeHostCommandExecutor(),
      fs,
      lock: new SerialLock(),
    }).signerSha256(),
  ).rejects.toThrow("Cannot read host signing certificate");
});

/** In-memory stand-in for the cross-process lock: one holder at a time, FIFO. */
class SerialLock implements SigningKeyLock {
  private tail: Promise<unknown> = Promise.resolve();
  acquisitions = 0;
  withLock<T>(_directory: string, work: () => Promise<T>): Promise<T> {
    this.acquisitions += 1;
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/** keytool stand-in that creates the keystore after yielding, opening the race window. */
class KeytoolCreatingExecutor extends FakeHostCommandExecutor {
  passwordAtGeneration = "";
  constructor(private readonly fs: FakeFileSystem) {
    super();
  }
  override async executeCommand(
    command: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    const result = await super.executeCommand(command, args, options);
    await Promise.resolve();
    const keystore = args[args.indexOf("-keystore") + 1];
    if (args.includes("-genkeypair") && keystore) {
      this.passwordAtGeneration = (
        await this.fs.readFileBuffer(join(dirname(keystore), "password"))
      ).toString();
      await this.fs.writeFileBuffer(keystore, Buffer.from("key"));
    }
    return result;
  }
}

test("concurrent signers sharing a directory create one key and keep its password", async () => {
  const fs = new FakeFileSystem();
  const executor = new KeytoolCreatingExecutor(fs);
  const lock = new SerialLock();
  const ids = new CountingIdGenerator();
  const first = new HostKeystoreSigner("/temporary-test/key", { executor, fs, ids, lock });
  const second = new HostKeystoreSigner("/temporary-test/key", { executor, fs, ids, lock });
  await Promise.all([first.sign("apksigner", "a", "b"), second.sign("apksigner", "c", "d")]);
  const generations = executor.getExecutedCalls().filter((c) => c.args.includes("-genkeypair"));
  expect(generations).toHaveLength(1);
  expect(lock.acquisitions).toBe(2);
  // The second signer re-checked under the lock, so the keystore's password was never replaced.
  expect((await fs.readFileBuffer("/temporary-test/key/password")).toString()).toBe(
    executor.passwordAtGeneration,
  );
});

test("file signing key lock serializes holders and releases its lock file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signing-lock-"));
  try {
    const timer = new FakeTimer();
    const order: string[] = [];
    const lock = new FileSigningKeyLock(timer, "owner-a");
    const other = new FileSigningKeyLock(timer, "owner-b");
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = lock.withLock(directory, async () => {
      order.push("first-start");
      await firstHeld;
      order.push("first-end");
    });
    const second = other.withLock(directory, async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(timer.getPendingSleepCount()).toBe(1);
    releaseFirst();
    await first;
    timer.advanceTime(100);
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(existsSync(join(directory, "key.lock"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file signing key lock times out with an actionable error while another holder keeps it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signing-lock-"));
  try {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let releaseHolder = (): void => {};
    const held = new Promise<void>((resolve) => (releaseHolder = resolve));
    const holder = new FileSigningKeyLock(timer, "holder").withLock(directory, () => held);
    await expect(
      new FileSigningKeyLock(timer, "waiter").withLock(directory, async () => undefined),
    ).rejects.toThrow("Timed out waiting for the host signing key lock");
    releaseHolder();
    await holder;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
