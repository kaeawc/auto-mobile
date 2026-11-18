@file:OptIn(dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.isDevicePersistent
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeEffectReport
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeResolveAppearance
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import java.util.UUID
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

internal class RuntimeAttachTarget(
  private val host: EmbeddedPrototypeHost,
  override val appInstanceId: String = UUID.randomUUID().toString(),
  private val deviceDark: () -> Boolean,
) : AttachTarget {
  var runtime: PrototypeRuntime? = null
  private var sequence = 0L
  // Match CtrlProxy's spec encoding: optional defaults must be absent, not null.
  private val specJson = Json(attachJson) { encodeDefaults = false }

  fun nextSequence(): Long = ++sequence

  override suspend fun patch(id: String, baseRevision: Long?, ops: JsonArray): PrototypeResult =
    host.interactions.withLock {
      val current = runtime?.takeIf { it.current.active && it.current.spec.id == id }
      if (current == null) PrototypeResult(0, success = false, error = "Unknown prototype id: $id")
      else
        when (val result = current.patch(baseRevision, ops, specJson, ::validate)) {
          is PrototypeRuntime.PatchResult.Rejected ->
            PrototypeResult(0, success = false, error = result.message, revision = result.revision)
          is PrototypeRuntime.PatchResult.Conflict ->
            PrototypeResult(
              0,
              success = false,
              error = "conflict: state changed after baseRevision $baseRevision",
              revision = result.revision,
              conflict =
                PrototypePatchConflict(
                  result.revision,
                  publicState(current.current.spec, result.state),
                ),
            )
          is PrototypeRuntime.PatchResult.Applied ->
            PrototypeResult(0, success = true, revision = result.revision)
        }
    }

  override suspend fun status(): JsonObject =
    host.interactions.withLock {
      val current = runtime?.takeIf { it.current.active }
      if (current == null)
        buildJsonObject {
          put("shown", false)
          put("id", JsonNull)
          put("pages", JsonObject(emptyMap()))
          put("stacks", JsonObject(emptyMap()))
          put("state", JsonObject(emptyMap()))
          put("lastSequence", sequence)
        }
      else {
        val snapshot = current.current
        val model = current.renderModel(snapshot)
        val entry =
          PrototypeStatusEntry(
            id = snapshot.spec.id,
            persistent = isDevicePersistent(snapshot.spec),
            state = publicState(snapshot.spec, snapshot.state),
            data = snapshot.spec.data,
            pages = snapshot.pages.toMap(),
            stacks = snapshot.stacks.toMap(),
            lastSequence = sequence,
            appearance = prototypeResolveAppearance(model.root, snapshot.spec.theme, deviceDark()),
            storage = current.storage?.report(),
            timers = current.timerReports(),
            feedbackLog = current.feedbackLog.snapshot(),
            degradedEffects = prototypeEffectReport(model.root, current.effectHealth),
          )
        JsonObject(
          attachJson.encodeToJsonElement(PrototypeStatusEntry.serializer(), entry).jsonObject +
            ("shown" to JsonPrimitive(true)),
        )
      }
    }

  // This checkout has no shared runtime publicState helper; keep this boundary local.
  private fun publicState(
    spec: PrototypeSpec,
    state: Map<String, PrototypeScalar>,
  ): Map<String, PrototypeScalar> {
    val secure = spec.storage?.secure.orEmpty().map { it.removePrefix("state:") }.toSet()
    return state.mapValues { (key, value) ->
      if (key in secure) PrototypeScalar.Text("[redacted]") else value
    }
  }

  private fun validate(spec: JsonObject): PrototypeSpec =
    when (val validation = PrototypeSpecValidator.validate(spec.toString())) {
      is PrototypeSpecValidation.Success -> validation.spec
      is PrototypeSpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
    }
}
