import { basename } from "node:path";
import { FileAvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";

// config.ini lines captured in #15881 from a real AVD config;
// the source.properties block is the verbatim real file.
export const TV_CONFIG = `abi.type=arm64-v8a
hw.device.name=tv_1080p
hw.dPad=yes
hw.keyboard=no
hw.lcd.width=1920
hw.lcd.height=1080
hw.lcd.density=320
PlayStore.enabled=no
tag.id=android-tv
tag.ids=android-tv
target=android-36
image.sysdir.1=system-images/android-36/android-tv/arm64-v8a/
`;
export const TV_SOURCE_PROPERTIES = `Pkg.Desc=Android SDK Platform 16
Pkg.UserSrc=false
Pkg.Revision=4
Pkg.Dependencies=emulator#35.2.10
AndroidVersion.ApiLevel=36
AndroidVersion.ExtensionLevel=17
AndroidVersion.IsBaseSdk=true
SystemImage.Abi=arm64-v8a
SystemImage.GpuSupport=true
SystemImage.TagId=android-tv
SystemImage.TagDisplay=Android TV
`;

export function tvConfigReader() {
  const reads: string[] = [];
  const reader = new FileAvdConfigReader(
    async (path) => {
      reads.push(path);
      return basename(path) === "source.properties" ? TV_SOURCE_PROPERTIES : TV_CONFIG;
    },
    (path) => basename(path) === "config.ini" || basename(path) === "source.properties",
    "/fixture/avd",
    "/fixture/sdk",
  );
  return { reader, reads };
}
