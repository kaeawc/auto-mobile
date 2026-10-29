package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class AutoMobilePrototypeCapabilitiesTest {
  companion object {
    private lateinit var requiredCapabilities: Set<String>

    @JvmStatic
    @BeforeClass
    fun loadFixture() {
      val fixture =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-capabilities/spec-capabilities.json") }
          .first { it.isFile }
      requiredCapabilities =
        Json.parseToJsonElement(fixture.readText())
          .jsonArray
          .map { it.jsonPrimitive.content }
          .toSet()
    }
  }

  /**
   * The test module is a placeholder no production runtime advertises. `window.backdrop` (#15126)
   * is a window-level blur only CtrlProxy's overlay window can draw (the embedded renderer has no
   * window). CtrlProxy registers the haptics and sound platform modules (#14329); the embedded
   * renderer leaves them to the app. `imageAsset.data` (#14192) has a validated contract and no
   * media store yet.
   */
  // Routes are contract-only until navigation and restore semantics ship.
  private val exclusions =
    setOf(
      "prototype_glass_v1", // Real backdrop blur is deferred to PR 2; never simulate glass.
      "prototype_scroll_edge_effect_v1", // Contract only until Android edge rendering in PR 2.
      "prototype_network_upload_v1", // Contract only until upload execution ships.
      // Realtime transport, routing and lifecycle remain owed by the runtime slices.
      "prototype_platform_realtime_v1",
      "prototype_platform_realtime_device_v1",
      "prototype_routes_v1",
      "prototype_platform_test_v1",
      "prototype_platform_share_v1", // Contract only; system share sheet runtime is owed.
      "prototype_backdrop_v1",
      "prototype_platform_haptics_v1",
      "prototype_platform_sound_v1",
      "prototype_platform_media_items_v1",
      // Contract only; the device status readers are owed (#14322).
      "prototype_platform_battery_v1",
      "prototype_platform_power_v1",
      "prototype_platform_audio_v1",
      // CtrlProxy registers connectivity (#14273); the embedded renderer leaves it to the app.
      "prototype_platform_connectivity_v1",
      // Contract only; the biometric prompt runtime is owed (#14328).
      "prototype_platform_biometric_v1",
      // Contract only; the settings launcher runtime is owed (#14320).
      "prototype_platform_settings_v1",
      // CtrlProxy registers the URL opener (#14238); the embedded renderer leaves it to the app.
      "prototype_platform_links_v1",
      // Contract only; the system picker runtimes are owed (#14318).
      "prototype_platform_contacts_v1",
      "prototype_platform_calendar_v1",
      // Contract only; the motion and sensor runtimes are owed (#14327).
      "prototype_platform_sensors_v1",
      // Contract only; the location runtimes are owed (#14325, #14326).
      "prototype_platform_location_v1",
      // Contract only; the system media picker and camera runtimes are owed (#14197).
      "prototype_platform_mediaLibrary_v1",
      "prototype_platform_camera_v1",
      // Contract only; the fake store runtime is owed (#14314).
      "prototype_platform_commerce_v1",
      // Contract only; the window controls runtime is owed (#14320).
      "prototype_platform_window_controls_v1",
      // Contract only; the keyboard dismiss runtime is owed (#14320).
      "prototype_hide_keyboard_v1",
      // Contract only; the fake identity provider runtime is owed (#14303).
      "prototype_platform_auth_v1",
      // Contract only; the Keystore-backed secure storage runtime is owed (#14321).
      "prototype_platform_secureStorage_v1",
      // Contract only; the voice-note recorder runtimes are owed (#14194).
      "prototype_platform_audioRecorder_v1",
      // Contract only; the local notification runtime is owed (#14281).
      "prototype_platform_notifications_v1",
      // Contract only; the media players and video renderers are owed (#14255, #14256).
      "prototype_platform_media_v1",
      "prototype_platform_camera_capture_v1",
      // Contract only; the live camera runtime is owed (#14203, #14204).
      "prototype_platform_camera_video_v1",
      // Contract only; the cast sender and route runtimes are owed (#14240, #14241, #14242).
      "prototype_platform_cast_v1",
      // Contract only; the media queue runtime is owed (#14249).
      "prototype_platform_media_queue_v1",
      // Contract only; the photo library runtime is owed (#14195).
      "prototype_platform_mediaLibrary_query_v1",
      "prototype_platform_mediaLibrary_save_v1",
    )

  @Test
  fun `shared spec capabilities are supported`() {
    assertTrue(
      "Exclusions must name current spec gates",
      requiredCapabilities.containsAll(exclusions),
    )
    assertTrue(
      "Remove exclusions once supported",
      exclusions.none { it in AutoMobilePrototype.capabilities },
    )
    val missing = requiredCapabilities - AutoMobilePrototype.capabilitiesForSdk(33) - exclusions
    assertTrue("Renderer is missing spec capabilities: $missing", missing.isEmpty())
  }

  @Test
  fun `production getter delegates to the sdk gated capabilities set`() {
    assertEquals(
      AutoMobilePrototype.capabilitiesForSdk(android.os.Build.VERSION.SDK_INT),
      AutoMobilePrototype.capabilities,
    )
    assertTrue("prototype_custom_shaders_v1" !in AutoMobilePrototype.capabilitiesForSdk(32))
    assertTrue("prototype_custom_shaders_v1" in AutoMobilePrototype.capabilitiesForSdk(33))
  }

  @Test
  fun `embedded renderer supports fullscreen window chrome on every sdk`() {
    assertTrue("prototype_window_chrome_v1" in AutoMobilePrototype.capabilitiesForSdk(32))
    assertTrue("prototype_window_chrome_v1" in AutoMobilePrototype.capabilitiesForSdk(33))
    assertTrue("prototype_window_chrome_v1" in AutoMobilePrototype.capabilities)
  }

  @Test
  fun `capabilities are sorted`() {
    val capabilities = AutoMobilePrototype.capabilities.toList()
    assertEquals(capabilities.sorted(), capabilities)
  }
}
