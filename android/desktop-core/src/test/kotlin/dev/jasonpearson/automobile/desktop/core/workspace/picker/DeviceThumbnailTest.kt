package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
class DeviceThumbnailTest {

  private val booted = PickerDevice("p8", "Pixel 8", Platform.Android, DeviceState.Booted)
  private val shutdown = PickerDevice("i15", "iPhone 15", Platform.Ios, DeviceState.Shutdown)

  @Test
  fun `screenshot capture retries with backoff until it yields a still`() = runTest {
    val state = MutableStateFlow<VideoStreamState>(VideoStreamState.Unavailable("no relay"))
    var attempts = 0
    val source =
      object : DeviceThumbnailScreenshotSource {
        override suspend fun latest(deviceId: String): ImageBitmap? {
          attempts++
          return if (attempts >= 3) ImageBitmap(1, 1) else null // fail twice, then succeed
        }
      }
    val delays = mutableListOf<Long>()
    val shot =
      captureScreenshotWithRetry(
        state,
        "d",
        source,
        initialBackoffMs = 1_000L,
        maxBackoffMs = 15_000L,
        delayMs = { delays += it },
      )
    assertNotNull(shot) // recovered rather than sticking on a single failed attempt
    assertEquals(3, attempts)
    assertEquals(listOf(1_000L, 2_000L), delays) // exponential backoff between the failed attempts
  }

  @Test
  fun `placeholder label reflects device state`() {
    assertEquals("Booting", thumbnailPlaceholder(DeviceState.Shutdown, booting = true))
    assertEquals("Shutdown", thumbnailPlaceholder(DeviceState.Shutdown, booting = false))
    assertNull(thumbnailPlaceholder(DeviceState.Booted, booting = false))
  }

  @Test
  fun `a shut-down device shows the Shutdown placeholder`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceThumbnail(
          shutdown,
          booting = false,
          sessionUuidProvider = { null },
          screenshotSource = null,
        )
      }
    }
    onNodeWithText("Shutdown").assertIsDisplayed()
  }

  @Test
  fun `a booting device shows the Booting placeholder`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceThumbnail(
          shutdown,
          booting = true,
          sessionUuidProvider = { null },
          screenshotSource = null,
        )
      }
    }
    onNodeWithText("Booting").assertIsDisplayed()
  }

  @Test
  fun `a booted device renders the live video frame`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent {
      MaterialTheme {
        DeviceThumbnail(
          booted,
          booting = false,
          sessionUuidProvider = { null },
          videoSourceFactory = { source },
          screenshotSource = null,
        )
      }
    }
    waitUntil { source.connectedDeviceId != null }
    source.emitFrame(width = 1, height = 1)
    waitUntil {
      onAllNodesWithContentDescription("Live thumbnail of Pixel 8")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Live thumbnail of Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `a booted iOS device names a pending Screen Recording approval`() = runComposeUiTest {
    val source = FakeVideoStreamSource(screenRecordingRequired = true)
    setContent {
      MaterialTheme {
        DeviceThumbnail(
          PickerDevice("ios-simulator", "iPhone 16", Platform.Ios, DeviceState.Booted),
          booting = false,
          sessionUuidProvider = { null },
          videoSourceFactory = { source },
          screenshotSource = null,
        )
      }
    }

    onNodeWithText("Screen Recording needs approval").assertIsDisplayed()
  }

  @Test
  fun `a booted device falls back to the last screenshot when the relay is unavailable`() =
    runComposeUiTest {
      val screenshot =
        object : DeviceThumbnailScreenshotSource {
          override suspend fun latest(deviceId: String): ImageBitmap? = ImageBitmap(1, 1)
        }
      setContent {
        MaterialTheme {
          DeviceThumbnail(
            booted,
            booting = false,
            sessionUuidProvider = { null },
            videoSourceFactory = { FakeVideoStreamSource(refuseWith = "no relay") },
            screenshotSource = screenshot,
          )
        }
      }
      waitUntil {
        onAllNodesWithContentDescription("Screenshot of Pixel 8").fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithContentDescription("Screenshot of Pixel 8").assertIsDisplayed()
    }

  @Test
  fun `a booted device with no relay and no screenshot shows a no-preview hint`() =
    runComposeUiTest {
      setContent {
        MaterialTheme {
          DeviceThumbnail(
            booted,
            booting = false,
            sessionUuidProvider = { null },
            videoSourceFactory = { FakeVideoStreamSource(refuseWith = "no relay") },
            screenshotSource = null,
          )
        }
      }
      onNodeWithText("No preview").assertIsDisplayed()
    }
}
