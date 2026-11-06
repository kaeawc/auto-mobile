import { createHash, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../../utils/HostCommandExecutor";
import { DefaultFileSystem, type FileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { resolveAutoMobileBaseDir } from "../../../../utils/tempDir";
import { defaultIdGenerator, type IdGenerator } from "../../../../utils/IdGenerator";

export interface DisposableAppSigner {
  signerSha256(): Promise<string>;
  sign(apksigner: string, input: string, output: string): Promise<void>;
}

/** A persistent host identity; passwords are passed by private file, never literal argv. */
export class HostKeystoreSigner implements DisposableAppSigner {
  private initialization?: Promise<void>;
  constructor(
    private readonly directory = join(resolveAutoMobileBaseDir(), "prototype-android-key"),
    private readonly executor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly fs: FileSystem = new DefaultFileSystem(),
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}
  private initialize(): Promise<void> {
    this.initialization ??= this.generate().catch((error: unknown) => {
      this.initialization = undefined;
      throw toActionableError(
        error,
        "Cannot prepare host Android signing key; check keytool and data directory permissions",
      );
    });
    return this.initialization;
  }
  private async generate(): Promise<void> {
    await this.fs.ensureDir(this.directory);
    const key = join(this.directory, "host.p12");
    if (await this.fs.pathExists(key)) {
      if (!(await this.fs.pathExists(join(this.directory, "password")))) {
        throw new ActionableError(
          "Host signing key password file is missing. Restore the host signing directory from backup.",
        );
      }
      return;
    }
    await this.fs.writeFileBuffer(
      join(this.directory, "password"),
      Buffer.from(this.ids.next() + this.ids.next()),
    );
    await this.executor.executeCommand("keytool", [
      "-genkeypair",
      "-storetype",
      "PKCS12",
      "-keystore",
      key,
      "-storepass:file",
      join(this.directory, "password"),
      "-alias",
      "prototype",
      "-keyalg",
      "RSA",
      "-keysize",
      "3072",
      "-validity",
      "10000",
      "-dname",
      "CN=AutoMobile Disposable Apps",
    ]);
  }
  async signerSha256(): Promise<string> {
    await this.initialize();
    const result = await this.executor.executeCommand("keytool", [
      "-exportcert",
      "-rfc",
      "-keystore",
      join(this.directory, "host.p12"),
      "-storepass:file",
      join(this.directory, "password"),
      "-alias",
      "prototype",
    ]);
    try {
      return createHash("sha256").update(new X509Certificate(result.stdout).raw).digest("hex");
    } catch (error) {
      throw toActionableError(error, "Cannot read host signing certificate");
    }
  }
  async sign(apksigner: string, input: string, output: string): Promise<void> {
    await this.initialize();
    await this.executor.executeCommand(apksigner, [
      "sign",
      "--ks",
      join(this.directory, "host.p12"),
      "--ks-key-alias",
      "prototype",
      "--ks-pass",
      `file:${join(this.directory, "password")}`,
      "--v2-signing-enabled",
      "true",
      "--v3-signing-enabled",
      "true",
      "--out",
      output,
      input,
    ]);
  }
}
