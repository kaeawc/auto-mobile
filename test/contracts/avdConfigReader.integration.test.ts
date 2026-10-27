import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileAvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import { FakeAvdConfigReader } from "../fakes/FakeAvdConfigReader";
import { EMPTY_AVD_CONFIG, runAvdConfigReaderContract } from "./AvdConfigReaderContract";

runAvdConfigReaderContract("FakeAvdConfigReader", async (avdNames) => ({
  reader: FakeAvdConfigReader.forAvds(
    Object.fromEntries(avdNames.map((n) => [n, EMPTY_AVD_CONFIG])),
  ),
}));

// Real side: FileAvdConfigReader over a private mkdtemp AVD home (#11868).
runAvdConfigReaderContract("FileAvdConfigReader (temp AVD home)", async (avdNames) => {
  const avdHome = await mkdtemp(path.join(os.tmpdir(), "am-avd-config-contract-"));
  for (const avdName of avdNames) {
    await mkdir(path.join(avdHome, `${avdName}.avd`), { recursive: true });
    await writeFile(path.join(avdHome, `${avdName}.avd`, "config.ini"), "");
  }
  return {
    reader: new FileAvdConfigReader(undefined, undefined, avdHome),
    dispose: () => rm(avdHome, { recursive: true, force: true }),
  };
});
