package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformReport
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import dev.jasonpearson.automobile.prototype.PrototypePlatformRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class PrototypePlatformReporting(
  private val registry: PrototypePlatformRegistry,
  private val inFlightByModule: () -> Map<String, Int>,
) {
  fun report(runtime: PrototypePlatformReport.Runtime, appState: String): PrototypePlatformReport {
    val inFlight = inFlightByModule()
    val defaultMode =
      PrototypePlatformReport.Mode.REAL.takeIf {
        runtime == PrototypePlatformReport.Runtime.CTRL_PROXY
      }
    return PrototypePlatformReport(
      runtime,
      registry.modules.associate { module ->
        module.name to moduleStatus(module, defaultMode, inFlight[module.name] ?: 0)
      },
      appState = appState,
      permissions =
        (registry.module("permissions") as? PrototypePermissionsModule)?.permissionReport,
    )
  }

  private fun moduleStatus(
    module: PrototypePlatformModule,
    defaultMode: PrototypePlatformReport.Mode?,
    inFlight: Int,
  ): PrototypePlatformReport.Module {
    val availability = module.availability()
    val mode = (module as? PrototypePlatformModeSource)?.platformMode ?: defaultMode
    val reason =
      when (availability) {
        is PlatformAvailability.NeedsPermission -> PrototypePlatformReport.Reason.PERMISSION_DENIED
        is PlatformAvailability.Unavailable ->
          PrototypePlatformReport.Reason.entries.firstOrNull { it.wire == availability.reason }
        PlatformAvailability.Ready ->
          PrototypePlatformReport.Reason.FAKE_MODE.takeIf {
            mode == PrototypePlatformReport.Mode.FAKE
          }
      }
    return PrototypePlatformReport.Module(
      if (availability == PlatformAvailability.Ready) PrototypePlatformReport.Availability.READY
      else PrototypePlatformReport.Availability.UNAVAILABLE,
      mode,
      reason,
      inFlight,
    )
  }

  fun outcomeMetadata(call: String): JsonObject {
    val module = registry.module(call) ?: return JsonObject(emptyMap())
    return buildJsonObject {
      put("inFlight", inFlightByModule()[module.name] ?: 0)
      val mode = (module as? PrototypePlatformModeSource)?.platformMode
      mode?.let {
        put("mode", Json.encodeToJsonElement(PrototypePlatformReport.Mode.serializer(), it))
      }
    }
  }
}
