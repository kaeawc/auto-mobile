/**
 * Unit tests must never dial the fixed CtrlProxy host ports (8765+), which a
 * developer's `adb forward`s or a stopped daemon's leftover forward keep open
 * (#11106). Installed suite-wide; integration files keep real `fetch`.
 */
import { installFixedCtrlProxyPortFetchGuard } from "./fixedCtrlProxyPortFetchGuard";

installFixedCtrlProxyPortFetchGuard(globalThis, () => Bun.main);
