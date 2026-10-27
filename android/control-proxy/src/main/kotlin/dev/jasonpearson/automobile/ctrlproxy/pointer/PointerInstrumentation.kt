package dev.jasonpearson.automobile.ctrlproxy.pointer

import android.app.Activity
import android.app.Instrumentation
import android.app.UiAutomation
import android.os.Bundle
import android.os.SystemClock

/**
 * Entry point of the stylus and hover injection route (#13097). The host starts it with `adb shell
 * am instrument -w -r -e request <base64 json> <package>/.pointer.PointerInstrumentation`; it
 * validates the request, injects through [UiAutomation] and reports `success`, `error`, `injected`
 * and `elapsedMs` as instrumentation results (`INSTRUMENTATION_RESULT: key=value`).
 *
 * `--no-restart` keeps `am` from force-stopping CtrlProxy (the instrumentation targets its own
 * package) at start and finish; see [PointerInjectionSupport]. The `UiAutomation` connection is
 * requested with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`; without it the system silences
 * accessibility services, CtrlProxy's own included, for as long as the instrumentation runs.
 * Device-unverified: see the design note's probe plan.
 */
class PointerInstrumentation : Instrumentation() {
  private var token: String? = null

  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    token = arguments?.getString(PointerRequestCodec.ARGUMENT)
    start()
  }

  override fun onStart() {
    super.onStart()
    val result =
      when (val parsed = PointerRequestCodec.decodeBase64(token)) {
        is PointerRequestParse.Rejected -> PointerInjectionResult(false, parsed.error)
        is PointerRequestParse.Parsed -> inject(parsed.request)
      }
    finish(
      Activity.RESULT_OK,
      Bundle().apply {
        putString("success", result.success.toString())
        putString("error", result.error.orEmpty())
        putString("injected", result.injected.toString())
        putString("elapsedMs", result.elapsedMs.toString())
      },
    )
  }

  private fun inject(request: PointerInjectionRequest): PointerInjectionResult {
    val uiAutomation: UiAutomation? =
      try {
        getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
      } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
        // The platform documents no specific type when the UiAutomation connection cannot be made.
        return PointerInjectionResult(false, "UiAutomation is unavailable: ${error.message}")
      }
    if (uiAutomation == null) {
      return PointerInjectionResult(
        false,
        "UiAutomation is unavailable: the instrumentation was not started with a shell connection",
      )
    }
    return PointerInjectionExecutor(
        sink = UiAutomationPointerSink(uiAutomation, request.tool),
        sleeper = { ms -> Thread.sleep(ms) },
        clock = { SystemClock.uptimeMillis() },
      )
      .run(request)
  }
}
