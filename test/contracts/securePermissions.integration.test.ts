import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultSecurePermissions,
  type SecurePermissions,
} from "../../src/utils/filesystem/securePermissions";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { runSecurePermissionsContract } from "./SecurePermissionsContract";

// Both sides run over a private mkdtemp directory removed afterwards (#11868).
async function inTempDir(permissions: SecurePermissions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-secure-permissions-contract-"));
  return { permissions, root, dispose: () => rm(root, { recursive: true, force: true }) };
}

runSecurePermissionsContract("FakeSecurePermissions", () => inTempDir(new FakeSecurePermissions()));
runSecurePermissionsContract("defaultSecurePermissions", () => inTempDir(defaultSecurePermissions));
