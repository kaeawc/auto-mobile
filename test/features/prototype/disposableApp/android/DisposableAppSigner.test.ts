import { expect, test } from "bun:test";
import { HostKeystoreSigner } from "../../../../../src/features/prototype/disposableApp/android/DisposableAppSigner";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../../fakes/FakeHostCommandExecutor";
import { CountingIdGenerator } from "../../../../../src/utils/IdGenerator";

test("creates PKCS12 lazily once and passes password files to keytool and apksigner", async () => {
  const fs = new FakeFileSystem();
  const executor = new FakeHostCommandExecutor();
  const signer = new HostKeystoreSigner(
    "/temporary-test/key",
    executor,
    fs,
    new CountingIdGenerator(),
  );
  expect(executor.getExecutedCalls()).toEqual([]);
  await signer.sign("/tools/apksigner", "/aligned.apk", "/signed.apk");
  await signer.sign("/tools/apksigner", "/aligned.apk", "/signed.apk");
  const calls = executor.getExecutedCalls();
  expect(calls.filter((call) => call.args.includes("-genkeypair"))).toHaveLength(1);
  expect(calls[0]?.args).toContain("PKCS12");
  expect(calls[0]?.args).toContain("-storepass:file");
  expect(calls[1]?.args).toContain("file:/temporary-test/key/password");
  expect(calls[1]?.args).toContain("--v2-signing-enabled");
  expect(calls[1]?.args).toContain("--v3-signing-enabled");
  const password = await fs.readFileBuffer("/temporary-test/key/password");
  expect(executor.getExecutedCommands().join("\n")).not.toContain(password.toString());
});
test("reuses existing key and refuses lost password without rotating identity", async () => {
  const fs = new FakeFileSystem();
  fs.setFile("/temporary-test/key/host.p12", "key");
  const executor = new FakeHostCommandExecutor();
  const signer = new HostKeystoreSigner("/temporary-test/key", executor, fs);
  await expect(signer.sign("apksigner", "in", "out")).rejects.toThrow("password file is missing");
  expect(executor.getExecutedCalls()).toEqual([]);
});
test("bad exported certificate is actionable", async () => {
  const fs = new FakeFileSystem();
  fs.setFile("/temporary-test/key/host.p12", "key");
  fs.setFile("/temporary-test/key/password", "password");
  await expect(
    new HostKeystoreSigner("/temporary-test/key", new FakeHostCommandExecutor(), fs).signerSha256(),
  ).rejects.toThrow("Cannot read host signing certificate");
});
