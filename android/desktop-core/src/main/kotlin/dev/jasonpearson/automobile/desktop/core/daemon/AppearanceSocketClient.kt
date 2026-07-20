package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

/** Socket file the daemon binds for appearance control. */
internal const val APPEARANCE_SOCKET_FILE = "appearance.sock"

/**
 * Appearance a device can be told to use.
 *
 * `auto` means "follow the host", and is only ever a *request* or a stored default -- the daemon
 * never reports it as the mode actually applied. See [AppearanceResult.appliedMode].
 */
enum class AppearanceSyncMode(val wireName: String) {
  Light("light"),
  Dark("dark"),
  Auto("auto");

  companion object {
    fun fromWireName(value: String?): AppearanceSyncMode? = entries.firstOrNull {
      it.wireName.equals(value, ignoreCase = true)
    }
  }
}

/** The daemon's stored appearance configuration. */
@Serializable
data class AppearanceConfig(
  val syncWithHost: Boolean = false,
  val defaultMode: String = AppearanceSyncMode.Auto.wireName,
  val applyOnConnect: Boolean = false,
)

/**
 * Outcome of an appearance command.
 *
 * [appliedMode] is the concrete light/dark actually pushed to devices. It is **null when no devices
 * were connected** -- the daemon omits the field rather than failing, so a successful call with an
 * empty device pool still reports the stored config. It is never `auto`.
 */
data class AppearanceResult(
  val config: AppearanceConfig,
  val appliedMode: AppearanceSyncMode? = null,
)

/**
 * Controls device appearance through the daemon.
 *
 * This is deliberately not per-device: `appearance.sock` takes no device id and applies to every
 * pooled device plus the current session device. Callers should present it as a global control.
 */
interface AppearanceClient {
  fun getConfig(): AppearanceResult

  /** Enables or disables following the host's appearance. */
  fun setSyncWithHost(enabled: Boolean): AppearanceResult

  /**
   * Sets the appearance mode.
   *
   * Note the daemon couples these: choosing [AppearanceSyncMode.Light] or [AppearanceSyncMode.Dark]
   * also sets `syncWithHost` to false, and choosing [AppearanceSyncMode.Auto] sets it to true.
   */
  fun setMode(mode: AppearanceSyncMode): AppearanceResult

  /** True when the daemon exposes this socket; false on daemons that predate it. */
  fun isAvailable(): Boolean
}

/** Client for `~/.auto-mobile/appearance.sock`. One request per connection. */
class AppearanceSocketClient(
  private val socketPathValue: String = AutoMobileSocketPaths.socketPath(APPEARANCE_SOCKET_FILE),
  private val json: Json = DaemonJson,
) : AppearanceClient {

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun getConfig(): AppearanceResult = send(request("get_appearance_config"))

  override fun setSyncWithHost(enabled: Boolean): AppearanceResult =
    send(request("set_appearance_sync", AppearanceParams(enabled = enabled)))

  override fun setMode(mode: AppearanceSyncMode): AppearanceResult =
    send(request("set_appearance", AppearanceParams(mode = mode.wireName)))

  private fun request(command: String, params: AppearanceParams? = null) =
    AppearanceSocketRequest(id = UUID.randomUUID().toString(), command = command, params = params)

  private fun send(request: AppearanceSocketRequest): AppearanceResult {
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    SocketChannel.open(address).use { channel ->
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
      val writer =
        BufferedWriter(
          OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
        )

      writer.write(json.encodeToString(serializer<AppearanceSocketRequest>(), request))
      writer.newLine()
      writer.flush()

      val line = reader.readLine() ?: throw McpConnectionException("Appearance socket closed")
      val response = json.decodeFromString(serializer<AppearanceSocketResponse>(), line)

      if (!response.success) {
        throw McpConnectionException(response.error ?: "Appearance request failed")
      }
      val result =
        response.result ?: throw McpConnectionException("Appearance response missing result")

      return AppearanceResult(
        config = result.config ?: AppearanceConfig(),
        appliedMode = AppearanceSyncMode.fromWireName(result.appliedMode),
      )
    }
  }

  private fun ensureSocketExists() {
    if (!isAvailable()) {
      throw McpConnectionException("Appearance socket not found at $socketPathValue")
    }
  }
}

@Serializable
internal data class AppearanceSocketRequest(
  val id: String,
  val type: String = "appearance_request",
  val command: String,
  val params: AppearanceParams? = null,
)

@Serializable
internal data class AppearanceParams(val enabled: Boolean? = null, val mode: String? = null)

@Serializable
internal data class AppearanceSocketResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val result: AppearanceSocketResult? = null,
  val error: String? = null,
)

@Serializable
internal data class AppearanceSocketResult(
  // get_appearance_config always returns config; the field is nullable only for safety.
  val config: AppearanceConfig? = null,
  // Omitted entirely when no devices were connected to apply to.
  val appliedMode: String? = null,
)

/** In-memory [AppearanceClient] for previews and tests. */
class FakeAppearanceClient(
  initialConfig: AppearanceConfig = AppearanceConfig(),
  private val available: Boolean = true,
  /** When false, mimics a daemon with no connected devices, which omits `appliedMode`. */
  private val hasConnectedDevices: Boolean = true,
) : AppearanceClient {
  var config: AppearanceConfig = initialConfig
    private set

  override fun isAvailable(): Boolean = available

  override fun getConfig(): AppearanceResult = AppearanceResult(config)

  override fun setSyncWithHost(enabled: Boolean): AppearanceResult {
    config = config.copy(syncWithHost = enabled)
    return AppearanceResult(config, appliedMode())
  }

  override fun setMode(mode: AppearanceSyncMode): AppearanceResult {
    // Mirrors the daemon's coupling of mode and host sync.
    config =
      config.copy(defaultMode = mode.wireName, syncWithHost = mode == AppearanceSyncMode.Auto)
    return AppearanceResult(config, appliedMode())
  }

  private fun appliedMode(): AppearanceSyncMode? =
    when {
      !hasConnectedDevices -> null
      config.defaultMode == AppearanceSyncMode.Dark.wireName -> AppearanceSyncMode.Dark
      else -> AppearanceSyncMode.Light
    }
}
