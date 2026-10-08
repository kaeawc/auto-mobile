package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.loadDeviceFilter
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImage
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.saveDeviceFilter
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalTestApi::class)
class AvailableDeviceImagesSectionUiTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  private fun image(
    name: String,
    platform: String = "android",
    api: Int? = null,
    version: String? = null,
    google: Boolean = false,
  ) =
    DeviceImageInfo(
      name = name,
      platform = platform,
      identity = DeviceIdentity("image-$name"),
      apiLevel = api,
      osVersion = version,
      image = DeviceImage(target = if (google) "google_apis" else "default"),
      runtime = DeviceRuntime(lifecycle = DeviceLifecycle("shutdown", true)),
    )

  @Test
  fun `available images exclude booted identities and preserve Android filters and boot callback`() =
    runComposeUiTest {
      val filterFile = temporaryFolder.root.resolve("device-filter.json")
      val googleImage = image("Pixel Google", api = 35, google = true)
      val plainImage = image("Pixel Plain", api = 34)
      val bootedImage = image("Pixel Running", api = 35)
      val oldImage = image("Fallback_api27")
      var booted: DeviceImageInfo? = null
      setContent {
        MaterialTheme {
          Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
            AvailableDeviceImagesSection(
              images = listOf(googleImage, plainImage, bootedImage, oldImage),
              bootedDevices =
                listOf(
                  BootedDevice(
                    "runtime",
                    "Renamed running device",
                    DeviceType.AndroidEmulator,
                    connectedAt = 0,
                    stableId = bootedImage.identity.stableId,
                  ),
                ),
              onBootDevice = { booted = it },
              filterFile = filterFile,
            )
          }
        }
      }
      onNodeWithText("Pixel Google").assertDoesNotExist()
      onNodeWithText("Available Devices").performClick()
      onNodeWithText("Pixel Google").assertIsDisplayed()
      onNodeWithText("Pixel Running").assertDoesNotExist()
      onNodeWithText("Fallback_api27").assertDoesNotExist()
      onNodeWithText("Google APIs").performClick()
      onNodeWithText("Pixel Plain").assertDoesNotExist()
      assertEquals(true, loadDeviceFilter(filterFile).googleApisOnly)
      onNodeWithContentDescription("Boot Pixel Google").performClick()
      assertEquals(googleImage, booted)
      onNodeWithText("Google APIs").performClick()
      onNodeWithText("Pixel Plain").assertIsDisplayed()
      onNodeWithContentDescription("Minimum Android API").performSemanticsAction(
        SemanticsActions.SetProgress,
      ) {
        it(35f)
      }
      onNodeWithText("Pixel Plain").assertDoesNotExist()
      assertEquals(35, loadDeviceFilter(filterFile).minApi)
    }

  @Test
  fun `persisted platform filters restore and chips save without user home writes`() =
    runComposeUiTest {
      val filterFile = temporaryFolder.root.resolve("device-filter.json")
      saveDeviceFilter(filterFile, 34, 35, true, 16, 26, true, false)
      setContent {
        MaterialTheme {
          Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
            AvailableDeviceImagesSection(
              images =
                listOf(
                  image("Android API33", api = 33, google = true),
                  image("Android Plain", api = 35),
                  image("iPhone One", "ios", version = "17.2"),
                  image("iPad One", "ios", version = "17.2"),
                ),
              bootedDevices = emptyList(),
              onBootDevice = {},
              filterFile = filterFile,
            )
          }
        }
      }
      onNodeWithText("Available Devices").performClick()
      onNodeWithText("No matching images").assertIsDisplayed()
      onNodeWithText("iPhone One").performScrollTo().assertIsDisplayed()
      onNodeWithText("iPad One").assertDoesNotExist()
      onNodeWithText("iPhone", substring = false).performScrollTo().performClick()
      onNodeWithText("iPhone One").assertDoesNotExist()
      onNodeWithText("No matching simulators").performScrollTo().assertIsDisplayed()
      assertFalse(loadDeviceFilter(filterFile).showIphone)
      assertFalse(loadDeviceFilter(filterFile).showIpad)
    }

  @Test
  fun `iOS version endpoints restore and save exact versions across collapse`() = runComposeUiTest {
    val filterFile = temporaryFolder.root.resolve("device-filter.json")
    saveDeviceFilter(filterFile, 28, 35, false, 16, 26, true, true, "17.2", "26.0")
    setContent {
      MaterialTheme {
        Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
          AvailableDeviceImagesSection(
            images =
              listOf(
                image("iPhone Old", "ios", version = "16.0"),
                image("iPhone Mid", "ios", version = "17.2"),
                image("iPhone New", "ios", version = "26.0"),
              ),
            bootedDevices = emptyList(),
            onBootDevice = {},
            filterFile = filterFile,
          )
        }
      }
    }
    onNodeWithText("Available Devices").performClick()
    onNodeWithText("iPhone Old").assertDoesNotExist()
    onNodeWithText("iPhone Mid").assertIsDisplayed()
    onNodeWithContentDescription("Minimum iOS version").performSemanticsAction(
      SemanticsActions.SetProgress,
    ) {
      it(2f)
    }
    onNodeWithText("iPhone Mid").assertDoesNotExist()
    onNodeWithText("iPhone New").assertIsDisplayed()
    assertEquals("26.0", loadDeviceFilter(filterFile).minIosVersion)
    onNodeWithText("Available Devices").performClick()
    onNodeWithText("Available Devices").performClick()
    onNodeWithText("iPhone Mid").assertDoesNotExist()
    onNodeWithText("26.0–26.0").assertIsDisplayed()
  }
}
