import { AdbInputSourceRoute } from "./AdbInputSourceRoute";
import { CtrlProxyA11yRoute } from "./CtrlProxyA11yRoute";
import type { PointerDispatch } from "./DispatchingRoute";
import { InstrumentationRoute } from "./InstrumentationRoute";
import type { PointerInjector } from "./PointerInjector";

/** The routes in preference order: the fast finger path first, then the shell, then instrumentation. */
export function defaultPointerRoutes(dispatches: {
  a11y: PointerDispatch;
  adbInputSource: PointerDispatch;
  instrumentation: PointerDispatch;
}): PointerInjector[] {
  return [
    new CtrlProxyA11yRoute(dispatches.a11y),
    new AdbInputSourceRoute(dispatches.adbInputSource),
    new InstrumentationRoute(dispatches.instrumentation),
  ];
}
