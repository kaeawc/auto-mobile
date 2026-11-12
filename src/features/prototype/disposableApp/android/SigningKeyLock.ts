import { type DirectoryLock, FileDirectoryLock } from "../../../../utils/directoryLock";
import { defaultIdGenerator } from "../../../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../../../utils/SystemTimer";

/** Serializes host key creation across signer instances and processes sharing a directory. */
export type SigningKeyLock = DirectoryLock;

/** The canonical `O_EXCL` file lock on `<directory>/key.lock`, polled until a bounded deadline. */
export class FileSigningKeyLock extends FileDirectoryLock {
  constructor(timer: Timer = defaultTimer, ownerToken: string = defaultIdGenerator.next()) {
    super({
      fileName: "key.lock",
      description: "the host signing key lock",
      holderActivity: "Another AutoMobile process is creating the key",
      timeoutMs: 60_000,
      timer,
      ownerToken,
    });
  }
}
