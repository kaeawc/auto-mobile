import { FileAvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";

// config.ini fields captured in #15881; source.properties uses the SDK image schema.
export const TV_CONFIG = `AvdId=AutoMobile-android-tv-36-c71f3a3d
abi.type=arm64-v8a
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
export const TV_SOURCE_PROPERTIES = `Pkg.Desc=Android TV ARM 64 v8a System Image
Pkg.Revision=1
AndroidVersion.ApiLevel=36
Platform.Version=16
SystemImage.Abi=arm64-v8a
SystemImage.TagId=android-tv
SystemImage.TagDisplay=Android TV
`;

export function tvConfigReader() {
  const reads: string[] = [];
  const reader = new FileAvdConfigReader(
    async (path) => {
      reads.push(path);
      return path.endsWith("source.properties") ? TV_SOURCE_PROPERTIES : TV_CONFIG;
    },
    (path) => path.endsWith("/config.ini") || path.endsWith("/source.properties"),
    "/fixture/avd",
    "/fixture/sdk",
  );
  return { reader, reads };
}
