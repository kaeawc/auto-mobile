package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeResult
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.*

/** One sequence epoch per process launch, shared by every Activity-side runtime. */
internal interface AttachEventLedger {
  val appInstanceId: String
  val lastSequence: Long

  fun nextSequence(): Long
}

/** Retains delivery independently of the UI; tests inject scope, identity and listener startup. */
internal class AppAttachProcess(
  token: String?,
  scope: CoroutineScope,
  override val appInstanceId: String = UUID.randomUUID().toString(),
  clock: () -> Long = System::currentTimeMillis,
  log: (String) -> Unit,
  private val startListener: (AppAttachAgent) -> Unit = {},
) : AttachEventLedger, AttachTarget {
  override var lastSequence = 0L
    private set

  private var target: AttachTarget? = null
  private var listenerStarted = false
  val agent = AppAttachAgent(token, this, scope, clock = clock, log = log)

  override fun nextSequence(): Long = ++lastSequence

  fun bind(target: AttachTarget): () -> Unit {
    this.target = target
    if (!listenerStarted) {
      listenerStarted = true
      startListener(agent)
    }
    return { if (this.target === target) this.target = null }
  }

  override suspend fun patch(id: String, baseRevision: Long?, ops: JsonArray): PrototypeResult =
    target?.patch(id, baseRevision, ops)
      ?: PrototypeResult(0, success = false, error = "Prototype Activity is not attached")

  override suspend fun status(): JsonObject =
    target?.status()
      ?: buildJsonObject {
        put("shown", false)
        put("id", JsonNull)
        put("pages", JsonObject(emptyMap()))
        put("stacks", JsonObject(emptyMap()))
        put("state", JsonObject(emptyMap()))
        put("lastSequence", lastSequence)
      }
}
