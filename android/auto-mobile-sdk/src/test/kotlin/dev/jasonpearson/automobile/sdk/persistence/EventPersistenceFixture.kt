package dev.jasonpearson.automobile.sdk.persistence

import android.content.Context
import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.sdk.events.AckPackageInfoReader
import dev.jasonpearson.automobile.sdk.events.BatchBroadcastSender
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryScheduler
import dev.jasonpearson.automobile.sdk.events.SdkEventAckCapability
import dev.jasonpearson.automobile.sdk.events.SdkEventBroadcaster
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.robolectric.RuntimeEnvironment

internal abstract class EventPersistenceFixture {

  @get:Rule val tempFolder = TemporaryFolder()

  protected fun createPersistence(
    clock: () -> Long = { 1000L },
    uuidProvider: () -> String = { "test-uuid" },
  ): FileEventPersistence =
    FileEventPersistence(
      directory = tempFolder.root,
      clock = clock,
      uuidProvider = uuidProvider,
    )

  protected fun makeLifecycleEvent(name: String, timestamp: Long = 100L) =
    SdkLifecycleEvent(
      timestamp = timestamp,
      applicationId = "com.test.app",
      kind = name,
      details = mapOf("key" to "value"),
    )

  protected fun makeNavEvent(destination: String, timestamp: Long = 200L) =
    SdkNavigationEvent(
      timestamp = timestamp,
      applicationId = "com.test.app",
      destination = destination,
      source = NavigationSourceType.COMPOSE_NAVIGATION,
      arguments = mapOf("id" to "42"),
      metadata = mapOf("screen" to "home"),
    )

  protected class IdentityDeliveryFixture : BatchBroadcastSender, BatchDeliveryScheduler {
    val ids = mutableListOf<String?>()
    var timeout: Runnable? = null
    var lateResult: ((Int) -> Unit)? = null
    var accepted = false
    val context: Context = RuntimeEnvironment.getApplication()

    init {
      SdkEventBroadcaster.reset()
      SdkEventBroadcaster.batchIdProvider = { "stable-id" }
      SdkEventBroadcaster.broadcastSender = this
      SdkEventBroadcaster.deliveryScheduler = this
      SdkEventBroadcaster.capabilityGate =
        SdkEventAckCapability(AckPackageInfoReader { true }, { 0 })
    }

    override fun send(
      context: Context,
      batchJson: String,
      batchId: String?,
      ordered: Boolean,
      onResult: (Int) -> Unit,
    ) {
      assertTrue(ordered)
      ids.add(batchId)
      if (accepted) onResult(1000) else lateResult = onResult
    }

    override fun execute(task: Runnable) = task.run()

    override fun schedule(task: Runnable, delayMs: Long): () -> Unit {
      assertEquals(SdkEventBroadcaster.ACK_TIMEOUT_MS, delayMs)
      timeout = task
      return { timeout = null }
    }

    fun replay(persistence: EventPersistence) {
      EventBatchReplay().replay(persistence, { it.run() }) { events, id, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = id,
        )
      }
    }
  }

  protected class ReplayPersistence(val pending: List<Pair<String, List<SdkEvent>>>) :
    NoOpEventPersistence() {
    val removed = mutableListOf<String>()
    var persistCalls = 0

    override fun persist(events: List<SdkEvent>, deliveryId: String?): String? {
      persistCalls++
      return "duplicate"
    }

    override fun loadPending(): List<PendingEventBatch> = pending.map { (id, events) ->
      PendingEventBatch(id, events)
    }

    override fun removeBatch(batchId: String) {
      removed.add(batchId)
    }
  }

  protected fun writeLegacy(id: String, events: List<SdkEvent>) {
    File(tempFolder.root, "events_$id.json").writeText(createPersistence().serializeEvents(events))
  }
}
