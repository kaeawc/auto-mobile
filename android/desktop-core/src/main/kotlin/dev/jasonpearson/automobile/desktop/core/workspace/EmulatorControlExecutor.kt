package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val LOG = LoggerFactory.getLogger("EmulatorControlExecutor")

// Matches [McpDaemonClient.transportName]; the only transport that serves the direct `input/*`
// daemon helpers the fast button path uses.
private const val UNIX_TRANSPORT_NAME = "Unix Socket"

/**
 * Runs a device-mutating emulator control (Rotate, Snapshot, Unlock) against a real device. This is
 * the seam #4694 wires: the [WorkspaceViewModel] resolves the target column and invokes this off
 * the UI thread, exactly as the picker's [DevicePickerViewModel] drives its `McpResourceClient`.
 * The real implementation is untested IO (see [DaemonEmulatorControlExecutor]); behavior is pinned
 * at the ViewModel boundary with [FakeEmulatorControlExecutor].
 *
 * Screenshot is intentionally NOT a device mutation here — it captures and surfaces a PNG in the
 * pane via the observation stream, so it is handled UI-side rather than through this
 * fire-and-forget seam.
 */
interface EmulatorControlExecutor {
  /**
   * Run [control] against [deviceId] on [platform]. [orientation] is the target orientation, used
   * only by [EmulatorControl.Rotate]. Suspends until the device call completes (or throws).
   */
  suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  )

  /** Press a device system [button] (the `more` overflow menu items). */
  suspend fun pressButton(deviceId: String, platform: Platform, button: DeviceButton)

  /**
   * Apply [locale] (a BCP-47 tag) to the device. The implementation resolves the foreground app on
   * both platforms: Android `changeLocalization` *requires* an app target, while iOS applies the
   * locale device-wide but caches it per-app at launch — so the running app only reflects the new
   * locale after a relaunch, which the daemon performs when the app is passed as `restartApp`.
   */
  suspend fun setLocale(deviceId: String, platform: Platform, locale: String)
}

/** No-op seam for hosts/tests that don't wire real device execution. */
object NoOpEmulatorControlExecutor : EmulatorControlExecutor {
  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) = Unit

  override suspend fun pressButton(deviceId: String, platform: Platform, button: DeviceButton) =
    Unit

  override suspend fun setLocale(deviceId: String, platform: Platform, locale: String) = Unit
}

/**
 * Real executor backed by the daemon [AutoMobileClient]. Sets the active device first, then invokes
 * the control's MCP tool with the resolved platform + deviceId, enabling the tool's server
 * capability where one gates it. Untested IO seam (mirrors `DaemonMcpResourceClient`).
 */
class DaemonEmulatorControlExecutor(
  private val client: AutoMobileClient,
  private val foregroundAppResolver: ForegroundAppResolver = ObservationForegroundAppResolver(),
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : EmulatorControlExecutor {
  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) {
    withContext(ioDispatcher) {
      val wire = platform.wireName()
      // Target the pane's device explicitly (belt-and-suspenders with the deviceId arg below), so a
      // control never races onto whichever device happened to be active.
      client.setActiveDeviceChecked(deviceId, wire)
      when (control) {
        EmulatorControl.Rotate -> {
          client.setToolEnabled("rotate")
          client.callToolChecked(
            "rotate",
            buildJsonObject {
              put("orientation", orientation.toolValue)
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        }
        EmulatorControl.Snapshot -> {
          client.setToolEnabled("deviceSnapshot")
          client.callToolChecked(
            "deviceSnapshot",
            buildJsonObject {
              put("action", "capture")
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        }
        EmulatorControl.Unlock ->
          client.callToolChecked(
            "wakeAndUnlock",
            buildJsonObject {
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        // Handled UI-side via the observation stream, not as a fire-and-forget device call.
        EmulatorControl.Screenshot -> Unit
        // Open menus, not one-shot device calls — their selections go through
        // pressButton/setLocale.
        EmulatorControl.Locale,
        EmulatorControl.More -> Unit
      }
    }
  }

  override suspend fun pressButton(deviceId: String, platform: Platform, button: DeviceButton) {
    val wire = platform.wireName()
    // Non-Unix transports (MCP HTTP/STDIO) don't implement the direct `input/*` daemon helpers, so
    // the fast path below would always report `unsupportedInputAction`. Route those through the
    // `pressButton` MCP tool instead — the transport-agnostic path the command bar used before the
    // fast path landed — so Back/Home/Recent/Power keep working off a remote daemon.
    if (client.transportName != UNIX_TRANSPORT_NAME) {
      withContext(ioDispatcher) {
        client.setActiveDeviceChecked(deviceId, wire)
        client.callToolChecked(
          "pressButton",
          buildJsonObject {
            put("button", button.toolValue)
            put("platform", wire)
            put("deviceId", deviceId)
          },
        )
      }
      return
    }
    // Unix fast path: single lightweight round-trip, matching the video-pane tap path.
    // `input/pressButton` targets the deviceId directly, so the old `setActiveDeviceChecked`
    // pre-call was redundant — and it was a whole extra (sometimes slow) daemon round-trip that
    // dominated command-bar button latency. Dropping it and the heavier `pressButton` MCP-tool
    // dispatch in favor of the direct `inputPressButton` wire method halves the round-trips.
    val startMs = MONOTONIC_NOW_MS()
    val result =
      withContext(ioDispatcher) {
        client.inputPressButton(
          button = button.toolValue,
          platform = wire,
          deviceId = deviceId,
          frameContext = null,
        )
      }
    // Perf span for the command-bar path (previously unmeasured): click → daemon ack, including the
    // dispatcher hop. Lets us compare button latency against the video-pane tap tracer.
    LOG.info(
      "button ${button.toolValue} $deviceId: dispatch=${MONOTONIC_NOW_MS() - startMs}ms success=${result.success}"
    )
    if (!result.success) {
      throw McpConnectionException(
        result.error ?: "input/pressButton failed for ${button.toolValue} on $deviceId"
      )
    }
  }

  override suspend fun setLocale(deviceId: String, platform: Platform, locale: String) {
    withContext(ioDispatcher) {
      val wire = platform.wireName()
      client.setActiveDeviceChecked(deviceId, wire)
      client.setToolEnabled("changeLocalization")
      // Resolve the foreground app on both platforms: Android *requires* it as the change target,
      // while iOS applies the locale device-wide but must relaunch the app (restartApp) to show it.
      val foregroundApp = foregroundAppResolver.resolve(deviceId)
      if (platform == Platform.Android && foregroundApp == null) {
        LOG.warn("Cannot change locale on $deviceId: no foreground app to target")
        return@withContext
      }
      client.callToolChecked(
        "changeLocalization",
        buildJsonObject {
          put("locale", locale)
          put("platform", wire)
          put("deviceId", deviceId)
          // Android sends the app as appId (the change target); iOS sends it as restartApp so the
          // app relaunches into the new locale. The daemon rejects appId on iOS.
          foregroundApp?.let {
            put(if (platform == Platform.Android) "appId" else "restartApp", it)
          }
        },
      )
    }
  }
}

/** Records requests for tests; optionally throws to exercise the ViewModel's failure handling. */
class FakeEmulatorControlExecutor : EmulatorControlExecutor {
  data class Request(
    val deviceId: String,
    val platform: Platform,
    val control: EmulatorControl,
    val orientation: Orientation,
  )

  data class ButtonRequest(val deviceId: String, val platform: Platform, val button: DeviceButton)

  data class LocaleRequest(val deviceId: String, val platform: Platform, val locale: String)

  val requests: MutableList<Request> = mutableListOf()
  val buttonRequests: MutableList<ButtonRequest> = mutableListOf()
  val localeRequests: MutableList<LocaleRequest> = mutableListOf()
  var error: Throwable? = null

  // When set, [setLocale] suspends on this gate before recording, so a test can hold a locale
  // request "in flight" (as the real foreground-app resolution would) to exercise supersede/cancel.
  var localeGate: CompletableDeferred<Unit>? = null

  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) {
    error?.let { throw it }
    requests += Request(deviceId, platform, control, orientation)
  }

  override suspend fun pressButton(deviceId: String, platform: Platform, button: DeviceButton) {
    error?.let { throw it }
    buttonRequests += ButtonRequest(deviceId, platform, button)
  }

  override suspend fun setLocale(deviceId: String, platform: Platform, locale: String) {
    error?.let { throw it }
    localeGate?.await()
    localeRequests += LocaleRequest(deviceId, platform, locale)
  }
}
