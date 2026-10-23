import { CachedIosLockStateProbe } from "./CachedIosLockStateProbe";
import { NotifyutilIosLockStateProbe } from "./IosLockStateProbe";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer } from "../../../utils/SystemTimer";

let instance: CachedIosLockStateProbe | undefined;
export function getIosLockStateCache(): CachedIosLockStateProbe {
  return (instance ??= new CachedIosLockStateProbe(
    new NotifyutilIosLockStateProbe(new SimCtlClient(), { timeoutMs: 4_000 }),
    defaultTimer,
  ));
}
export function setIosLockStateCache(cache: CachedIosLockStateProbe): void {
  instance = cache;
}
export function resetIosLockStateCache(): void {
  instance = undefined;
}
