package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceControlBlockedNoticeUiTest {

  private val holdMs = DEVICE_CONTROL_BLOCK_NOTICE_HOLD_MS

  @Test
  fun `host configuration reasons map to no text`() {
    // NotEnabled is the IDE plugin's permanent state; NotRealDeviceMode is a mode the user chose.
    // A notice for either would be a constant fixture, not information.
    assertNull(deviceControlBlockReasonText(DeviceControlBlockReason.NotEnabled))
    assertNull(deviceControlBlockReasonText(DeviceControlBlockReason.NotRealDeviceMode))
  }

  @Test
  fun `every observable reason maps to distinct text`() {
    val observable =
      DeviceControlBlockReason.entries.filterNot {
        it == DeviceControlBlockReason.NotEnabled ||
          it == DeviceControlBlockReason.NotRealDeviceMode
      }
    val texts = observable.map { assertNotNull(deviceControlBlockReasonText(it), it.name) }
    assertEquals(texts.size, texts.toSet().size, "block reason texts must be distinct")
  }

  @Test
  fun `notice appears only after the reason has held`() = runComposeUiTest {
    mainClock.autoAdvance = false
    setContent {
      MaterialTheme { DeviceControlBlockedNotice(reason = DeviceControlBlockReason.StaleFrame) }
    }
    val text = deviceControlBlockReasonText(DeviceControlBlockReason.StaleFrame)!!

    // Exact boundary: absent through holdMs - 1, present at exactly holdMs. ignoreFrameDuration
    // keeps advanceTimeBy from rounding up to a frame multiple, which would overshoot the bound.
    mainClock.advanceTimeBy(holdMs - 1, ignoreFrameDuration = true)
    onNodeWithText(text).assertDoesNotExist()

    mainClock.advanceTimeBy(1, ignoreFrameDuration = true)
    mainClock
      .advanceTimeByFrame() // dispatch the resumed hold coroutine; the deadline already passed
    onNodeWithText(text).assertIsDisplayed()
  }

  @Test
  fun `a reason change restarts the hold`() = runComposeUiTest {
    mainClock.autoAdvance = false
    var reason by mutableStateOf<DeviceControlBlockReason?>(DeviceControlBlockReason.StaleFrame)
    setContent { MaterialTheme { DeviceControlBlockedNotice(reason = reason) } }
    val staleText = deviceControlBlockReasonText(DeviceControlBlockReason.StaleFrame)!!
    val unpairedText = deviceControlBlockReasonText(DeviceControlBlockReason.UnpairedHierarchy)!!

    mainClock.advanceTimeBy(holdMs / 2)
    reason = DeviceControlBlockReason.UnpairedHierarchy
    // Pump one frame so the recomposition applies and the restarted hold anchors HERE — with a
    // frozen clock, recomposition waits for a frame, and letting it happen inside the next
    // advance would shift the anchor and blur the exact boundary below.
    mainClock.advanceTimeByFrame()

    mainClock.advanceTimeBy(holdMs - 1, ignoreFrameDuration = true)
    // Neither reason held for the full window yet: the first was replaced, the second is 1ms shy.
    onNodeWithText(staleText).assertDoesNotExist()
    onNodeWithText(unpairedText).assertDoesNotExist()

    mainClock.advanceTimeBy(1, ignoreFrameDuration = true)
    mainClock
      .advanceTimeByFrame() // dispatch the resumed hold coroutine; the deadline already passed
    onNodeWithText(unpairedText).assertIsDisplayed()
  }

  @Test
  fun `a reason change after the notice is visible re-debounces the new reason`() =
    runComposeUiTest {
      mainClock.autoAdvance = false
      var reason by mutableStateOf<DeviceControlBlockReason?>(DeviceControlBlockReason.StaleFrame)
      setContent { MaterialTheme { DeviceControlBlockedNotice(reason = reason) } }
      val staleText = deviceControlBlockReasonText(DeviceControlBlockReason.StaleFrame)!!
      val unpairedText = deviceControlBlockReasonText(DeviceControlBlockReason.UnpairedHierarchy)!!

      mainClock.advanceTimeBy(holdMs * 2)
      onNodeWithText(staleText).assertIsDisplayed()

      // The replacement must not inherit the shown reason's completed hold: only text the hold
      // effect committed is rendered, so the new reason waits out its own full, exact hold.
      reason = DeviceControlBlockReason.UnpairedHierarchy
      mainClock.advanceTimeByFrame() // apply the recomposition so the fresh hold anchors here

      mainClock.advanceTimeBy(holdMs - 1, ignoreFrameDuration = true)
      onNodeWithText(staleText).assertDoesNotExist()
      onNodeWithText(unpairedText).assertDoesNotExist()

      mainClock.advanceTimeBy(1, ignoreFrameDuration = true)
      mainClock
        .advanceTimeByFrame() // dispatch the resumed hold coroutine; the deadline already passed
      onNodeWithText(unpairedText).assertIsDisplayed()
    }

  @Test
  fun `notice hides as soon as the reason clears`() = runComposeUiTest {
    mainClock.autoAdvance = false
    var reason by mutableStateOf<DeviceControlBlockReason?>(DeviceControlBlockReason.StaleFrame)
    setContent { MaterialTheme { DeviceControlBlockedNotice(reason = reason) } }
    val text = deviceControlBlockReasonText(DeviceControlBlockReason.StaleFrame)!!

    mainClock.advanceTimeBy(holdMs * 2)
    onNodeWithText(text).assertIsDisplayed()

    reason = null
    mainClock.advanceTimeBy(1)
    onNodeWithText(text).assertDoesNotExist()
  }

  @Test
  fun `renders nothing for NotEnabled no matter how long it holds`() = runComposeUiTest {
    mainClock.autoAdvance = false
    setContent {
      MaterialTheme { DeviceControlBlockedNotice(reason = DeviceControlBlockReason.NotEnabled) }
    }
    mainClock.advanceTimeBy(holdMs * 10)
    onNodeWithText("Device control", substring = true).assertDoesNotExist()
  }

  @Test
  fun `renders nothing for a null reason`() = runComposeUiTest {
    mainClock.autoAdvance = false
    setContent { MaterialTheme { DeviceControlBlockedNotice(reason = null) } }
    mainClock.advanceTimeBy(holdMs * 10)
    onNodeWithText("Device control", substring = true).assertDoesNotExist()
  }
}
