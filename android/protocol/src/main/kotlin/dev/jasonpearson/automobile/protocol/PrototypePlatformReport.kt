package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Presentation-local platform runtime state, mirrored by the host as `platformRuntime`. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PrototypePlatformReport(
  val runtime: Runtime,
  val modules: Map<String, Module>,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val appState: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val permissions: Map<String, String>? = null,
) {
  @OptIn(ExperimentalSerializationApi::class)
  @Serializable
  data class Module(
    val availability: Availability,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val mode: Mode? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val reason: Reason? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val inFlight: Int? = null,
  ) {
    init {
      require(inFlight == null || inFlight >= 0) { "inFlight must be nonnegative" }
    }
  }

  @Serializable
  enum class Runtime {
    @SerialName("ctrlproxy") CTRL_PROXY,
    @SerialName("iosAgent") IOS_AGENT,
    @SerialName("iosViewer") IOS_VIEWER,
    @SerialName("disposableApp") DISPOSABLE_APP,
    @SerialName("protoviewer") PROTOVIEWER,
    @SerialName("embedded") EMBEDDED,
  }

  @Serializable
  enum class Availability {
    @SerialName("ready") READY,
    @SerialName("degraded") DEGRADED,
    @SerialName("unavailable") UNAVAILABLE,
  }

  @Serializable
  enum class Mode {
    @SerialName("real") REAL,
    @SerialName("fake") FAKE,
    @SerialName("simulated") SIMULATED,
  }

  @Serializable
  enum class Reason(val wire: String) {
    @SerialName("permission_denied") PERMISSION_DENIED("permission_denied"),
    @SerialName("hardware_unavailable") HARDWARE_UNAVAILABLE("hardware_unavailable"),
    @SerialName("play_services_missing") PLAY_SERVICES_MISSING("play_services_missing"),
    @SerialName("simulator") SIMULATOR("simulator"),
    @SerialName("fake_mode") FAKE_MODE("fake_mode"),
  }
}
