package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.HierarchyStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.layout.parseHierarchyFromJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class TwoDeviceCompareViewTest {

  /** Hands out queued fakes in order so the two sides get distinct, addressable streams. */
  private class QueuedStreamFactory(vararg fakes: FakeObservationStream) : () -> ObservationStream {
    val created = fakes.toList()
    private var index = 0

    override fun invoke(): ObservationStream = created[index++]
  }

  private fun columnA() =
    DeviceColumn(deviceId = "dev-a", name = "Pixel", platform = Platform.Android)

  private fun columnB() = DeviceColumn(deviceId = "dev-b", name = "iPhone", platform = Platform.Ios)

  /**
   * A minimal two-child hierarchy: a shared `title` node plus a second child whose resource-id
   * distinguishes the two devices, yielding one only-in-A and one only-in-B node in the diff.
   */
  private fun hierarchyJson(secondChildResourceId: String): JsonElement {
    val raw =
      """
      {"hierarchy":{"node":{
        "class":"android.widget.FrameLayout","resource-id":"root",
        "bounds":{"left":0,"top":0,"right":100,"bottom":200},
        "node":[
          {"class":"android.widget.TextView","resource-id":"title","text":"Hi",
           "bounds":{"left":0,"top":0,"right":50,"bottom":20}},
          {"class":"android.widget.Button","resource-id":"$secondChildResourceId",
           "bounds":{"left":0,"top":30,"right":50,"bottom":60}}
        ]
      }}}
      """
        .trimIndent()
    return Json.parseToJsonElement(raw)
  }

  private fun emit(fake: FakeObservationStream, deviceId: String, resourceId: String) {
    fake.emitHierarchy(
      HierarchyStreamUpdate(deviceId = deviceId, timestamp = 1L, data = hierarchyJson(resourceId))
    )
  }

  @Test
  fun `each side connects its own stream scoped to its device`() = runComposeUiTest {
    val fakeA = FakeObservationStream()
    val fakeB = FakeObservationStream()
    setContent {
      MaterialTheme {
        TwoDeviceCompareView(
          columnA = columnA(),
          columnB = columnB(),
          observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
          sideContent = { column, _ -> Text(column.name) },
        )
      }
    }
    waitForIdle()
    assertEquals("dev-a", fakeA.lastConnectedDeviceId)
    assertEquals("dev-b", fakeB.lastConnectedDeviceId)
    assertEquals(1, fakeA.connectCallCount)
    assertEquals(1, fakeB.connectCallCount)
  }

  @Test
  fun `waits for both hierarchies before showing a diff`() = runComposeUiTest {
    val fakeA = FakeObservationStream()
    val fakeB = FakeObservationStream()
    setContent {
      MaterialTheme {
        TwoDeviceCompareView(
          columnA = columnA(),
          columnB = columnB(),
          observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
          sideContent = { column, _ -> Text(column.name) },
        )
      }
    }
    // Only one side has reported: the strip stays in its loading state.
    emit(fakeA, "dev-a", "onlyA")
    waitForIdle()
    onNodeWithText("Waiting for both device hierarchies", substring = true).assertExists()
  }

  @Test
  fun `surfaces only-in-A and only-in-B nodes once both hierarchies arrive`() = runComposeUiTest {
    val fakeA = FakeObservationStream()
    val fakeB = FakeObservationStream()
    setContent {
      MaterialTheme {
        TwoDeviceCompareView(
          columnA = columnA(),
          columnB = columnB(),
          observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
          sideContent = { column, _ -> Text(column.name) },
        )
      }
    }
    emit(fakeA, "dev-a", "onlyA")
    emit(fakeB, "dev-b", "onlyB")

    waitUntil {
      onAllNodesWithContentDescription("Only in Pixel: onlyA").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Only in Pixel: onlyA").assertExists()
    onNodeWithContentDescription("Only in iPhone: onlyB").assertExists()
  }

  @Test
  fun `device loss on one side clears its hierarchy so no stale diff persists`() =
    runComposeUiTest {
      val fakeA = FakeObservationStream()
      val fakeB = FakeObservationStream()
      setContent {
        MaterialTheme {
          TwoDeviceCompareView(
            columnA = columnA(),
            columnB = columnB(),
            observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
            sideContent = { column, _ -> Text(column.name) },
          )
        }
      }
      emit(fakeA, "dev-a", "onlyA")
      emit(fakeB, "dev-b", "onlyB")
      waitUntil {
        onAllNodesWithContentDescription("Only in Pixel: onlyA").fetchSemanticsNodes().isNotEmpty()
      }

      // Device loss arrives out-of-band as a deviceEvent, not a null hierarchy update: side A must
      // clear so the diff retires instead of comparing the live device against a stale snapshot.
      runOnIdle {
        fakeA.emitDeviceEvent(
          DeviceStreamEvent.DeviceConnectionLost("dev-a", 2L, "connection lost")
        )
      }
      waitUntil {
        onAllNodesWithText("Waiting for both device hierarchies", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      onNodeWithContentDescription("Only in Pixel: onlyA").assertDoesNotExist()
    }

  @Test
  fun `device loss during an in-flight parse does not restore the stale hierarchy`() =
    runComposeUiTest {
      val fakeA = FakeObservationStream()
      val fakeB = FakeObservationStream()
      // Gates ONLY side A's parse so it is suspended in flight when the device is lost.
      val gate = CompletableDeferred<Unit>()
      setContent {
        MaterialTheme {
          TwoDeviceCompareView(
            columnA = columnA(),
            columnB = columnB(),
            observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
            sideContent = { column, _ -> Text(column.name) },
            parseHierarchy = { json ->
              if (json.toString().contains("gated")) gate.await()
              parseHierarchyFromJson(json)
            },
          )
        }
      }
      // B parses immediately; A's parse suspends on the gate.
      emit(fakeB, "dev-b", "onlyB")
      emit(fakeA, "dev-a", "gated")
      waitForIdle()

      // Device A is lost while its parse is still suspended: the clear bumps A's generation.
      runOnIdle {
        fakeA.emitDeviceEvent(
          DeviceStreamEvent.DeviceConnectionLost("dev-a", 2L, "connection lost")
        )
      }
      waitForIdle()

      // Let the stale parse complete; its result must be discarded (generation changed), so A's
      // snapshot is never restored and the diff stays in the waiting state.
      runOnIdle { gate.complete(Unit) }
      waitForIdle()

      onNodeWithText("Waiting for both device hierarchies", substring = true).assertExists()
      onNodeWithContentDescription("Only in Pixel: gated").assertDoesNotExist()
    }
}
