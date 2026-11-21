@file:OptIn(dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.isDevicePersistent
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeEffectReport
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeResolveAppearance
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

internal class RuntimeAttachTarget(
  private val host: EmbeddedPrototypeHost,
  private val ledger: AttachEventLedger,
  private val deviceDark: () -> Boolean,
) : AttachTarget {
  override var showingId: String? = null
    private set

  override var showingStartSequence: Long? = null
    private set

  var runtime: PrototypeRuntime? = null
    set(value) {
      if (value != null && value !== field) {
        showingId = ledger.nextShowingId()
        // Set before the runtime emits: every sequence from here on belongs to this showing.
        showingStartSequence = ledger.lastSequence + 1
      }
      field = value
    }

  override val appInstanceId: String
    get() = ledger.appInstanceId

  // Match CtrlProxy's spec encoding: optional defaults must be absent, not null.
  private val specJson = Json(attachJson) { encodeDefaults = false }

  fun nextSequence(): Long = ledger.nextSequence()

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
          showingId?.let { put("showingId", it) }
          showingStartSequence?.let { put("showingStartSequence", it) }
          put("shown", false)
          put("id", JsonNull)
          put("pages", JsonObject(emptyMap()))
          put("stacks", JsonObject(emptyMap()))
          put("state", JsonObject(emptyMap()))
          put("lastSequence", ledger.lastSequence)
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
            lastSequence = ledger.lastSequence,
            appearance = prototypeResolveAppearance(model.root, snapshot.spec.theme, deviceDark()),
            storage = current.storage?.report(),
            timers = current.timerReports(),
            feedbackLog = current.feedbackLog.snapshot(),
            degradedEffects = prototypeEffectReport(model.root, current.effectHealth),
          )
        JsonObject(
          attachJson.encodeToJsonElement(PrototypeStatusEntry.serializer(), entry).jsonObject +
            ("shown" to JsonPrimitive(true)) +
            ("showingId" to JsonPrimitive(showingId)) +
            ("showingStartSequence" to JsonPrimitive(showingStartSequence)),
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
    when (
      val validation =
        PrototypeSpecValidator.validate(spec.toString(), budget = PrototypeRuntimeBudget.LARGE)
    ) {
      is PrototypeSpecValidation.Success -> validation.spec
      is PrototypeSpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
    }
}
