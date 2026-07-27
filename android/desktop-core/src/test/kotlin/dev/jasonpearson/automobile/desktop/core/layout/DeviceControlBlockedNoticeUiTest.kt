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

    mainClock.advanceTimeBy(holdMs / 2)
    onNodeWithText(text).assertDoesNotExist()

    mainClock.advanceTimeBy(holdMs)
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
    mainClock.advanceTimeBy(holdMs / 2 + 1)
    // Neither reason held for the full window yet: the first was replaced, the second is young.
    onNodeWithText(staleText).assertDoesNotExist()
    onNodeWithText(unpairedText).assertDoesNotExist()

    mainClock.advanceTimeBy(holdMs)
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
