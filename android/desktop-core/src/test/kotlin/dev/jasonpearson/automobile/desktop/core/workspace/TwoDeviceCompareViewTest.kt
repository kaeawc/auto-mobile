package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
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
   * The Android side's minimal hierarchy: a shared `title` label plus a **Button** whose
   * resource-id distinguishes it. Paired against [iosHierarchyJson], whose second child is a
   * different structural role, so the compare's cross-platform role diff (issue #4872) surfaces the
   * button as only-in-A.
   */
  private fun androidHierarchyJson(secondChildResourceId: String): JsonElement {
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

  /**
   * The iOS side's counterpart, emitting the **UIKit** class names the runner actually reports
   * (`ElementLocator.mapElementType` → `XCUIApplication`, `UILabel`, `UIImageView`, …), not the
   * fabricated `XCUIElementType*` forms — so this exercises the live cross-platform path. Its
   * `title` (`UILabel`) maps to the same `Text` role as Android's `TextView` (so those pair and
   * stay Equal), while its second child is an **Image** (`UIImageView`, a different role than
   * Android's Button) so the role diff reports it as only-in-B rather than pairing it against the
   * button. The `XCUIApplication` root maps to the same `Container` role as Android's
   * `FrameLayout`, so the roots pair instead of leaving the whole tree disjoint (issue #4872).
   */
  private fun iosHierarchyJson(secondChildResourceId: String): JsonElement {
    val raw =
      """
      {"hierarchy":{"node":{
        "class":"XCUIApplication","resource-id":"root",
        "bounds":{"left":0,"top":0,"right":100,"bottom":200},
        "node":[
          {"class":"UILabel","resource-id":"title","text":"Hi",
           "bounds":{"left":0,"top":0,"right":50,"bottom":20}},
          {"class":"UIImageView","resource-id":"$secondChildResourceId",
           "bounds":{"left":0,"top":30,"right":50,"bottom":60}}
        ]
      }}}
      """
        .trimIndent()
    return Json.parseToJsonElement(raw)
  }

  // dev-b is the iOS column ([columnB]); every other device emits the Android hierarchy.
  private fun emit(fake: FakeObservationStream, deviceId: String, resourceId: String) {
    val data =
      if (deviceId == "dev-b") iosHierarchyJson(resourceId) else androidHierarchyJson(resourceId)
    fake.emitHierarchy(HierarchyStreamUpdate(deviceId = deviceId, timestamp = 1L, data = data))
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
  fun `a side reconnects after a mid-session drop instead of staying disconnected`() =
    runComposeUiTest {
      val fakeA = FakeObservationStream()
      val fakeB = FakeObservationStream()
      // Only side A drops; side B stays healthy and never touches the shared backoff gate.
      val backoff = CompletableDeferred<Unit>()
      setContent {
        MaterialTheme {
          TwoDeviceCompareView(
            columnA = columnA(),
            columnB = columnB(),
            observationStreamFactory = QueuedStreamFactory(fakeA, fakeB),
            backoffDelay = { backoff.await() },
            socketAvailable = { true },
            sideContent = { column, _ -> Text(column.name) },
          )
        }
      }
      waitForIdle()
      assertEquals(1, fakeA.connectCallCount)

      runOnIdle { fakeA.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
      waitForIdle()
      runOnIdle { backoff.complete(Unit) }
      waitForIdle()
      assertEquals("expected side A to reconnect after a drop", 2, fakeA.connectCallCount)
      assertEquals("side B must not reconnect", 1, fakeB.connectCallCount)
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
