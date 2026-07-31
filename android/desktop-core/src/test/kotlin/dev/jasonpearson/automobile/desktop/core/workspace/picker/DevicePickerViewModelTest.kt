package dev.jasonpearson.automobile.desktop.core.workspace.picker

import app.cash.turbine.test
import dev.jasonpearson.automobile.desktop.core.mcp.FakeMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DevicePickerViewModelTest {

  private val testScope = TestScope(UnconfinedTestDispatcher())

  private fun fake(): FakeMcpResourceClient =
    FakeMcpResourceClient().apply {
      bootedDevicesResponse =
        """
        {"totalCount":1,"androidCount":1,"iosCount":0,"virtualCount":1,"physicalCount":0,
         "lastUpdated":"x","devices":[
           {"name":"Pixel 8 API 35","platform":"android","deviceId":"emulator-5554",
            "source":"local","isVirtual":true,"status":"booted"}]}
        """
          .trimIndent()
      deviceImagesResponse =
        """
        {"totalCount":3,"androidCount":2,"iosCount":1,"lastUpdated":"x","images":[
          {"name":"Pixel 8 API 35","platform":"android","deviceId":"Pixel_8_API_35","target":"android-35"},
          {"name":"Pixel 6 API 33","platform":"android","deviceId":"Pixel_6_API_33","target":"android-33"},
          {"name":"iPhone 15","platform":"ios","deviceId":"iphone-15","iosVersion":"17.2",
           "architecture":"arm64","state":"Shutdown"}]}
        """
          .trimIndent()
    }

  private fun content(vm: DevicePickerViewModel) = vm.state.value as DevicePickerUiState.Content

  private fun vm(
    resourceClient: FakeMcpResourceClient = fake(),
    bootController: DeviceBootController = FakeDeviceBootController(),
  ) = DevicePickerViewModel(resourceClient, bootController, testScope, UnconfinedTestDispatcher())

  @Test
  fun `loads and unifies booted + images with dedupe and iOS architecture`() = testScope.runTest {
    val vm =
      DevicePickerViewModel(fake(), FakeDeviceBootController(), this, UnconfinedTestDispatcher())
    val c = content(vm)
    assertEquals(listOf("emulator-5554", "Pixel_6_API_33", "iphone-15"), c.devices.map { it.id })
    val pixel8 = c.devices.first { it.id == "emulator-5554" }
    assertEquals(DeviceState.Booted, pixel8.state)
    assertEquals("35", pixel8.osKey) // parsed from the name
    val iphone = c.devices.first { it.id == "iphone-15" }
    assertEquals(DeviceState.Shutdown, iphone.state)
    assertEquals("arm64", iphone.architecture)
    assertEquals("17", iphone.osKey)
  }

  @Test
  fun `toggling a platform updates the filters`() = testScope.runTest {
    val vm =
      DevicePickerViewModel(fake(), FakeDeviceBootController(), this, UnconfinedTestDispatcher())
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Ios))
    assertEquals(setOf(Platform.Ios), content(vm).filters.platforms)
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Ios))
    assertTrue(content(vm).filters.platforms.isEmpty())
  }

  @Test
  fun `only booted devices can be selected`() = testScope.runTest {
    val vm =
      DevicePickerViewModel(fake(), FakeDeviceBootController(), this, UnconfinedTestDispatcher())
    vm.onAction(DevicePickerAction.ToggleSelect("iphone-15")) // shutdown — ignored
    assertTrue(content(vm).selectedIds.isEmpty())
    vm.onAction(DevicePickerAction.ToggleSelect("emulator-5554")) // booted
    assertEquals(setOf("emulator-5554"), content(vm).selectedIds)
  }

  @Test
  fun `observe selected emits one column per selected booted device`() = testScope.runTest {
    val vm =
      DevicePickerViewModel(fake(), FakeDeviceBootController(), this, UnconfinedTestDispatcher())
    vm.effect.test {
      vm.onAction(DevicePickerAction.ToggleSelect("emulator-5554"))
      vm.onAction(DevicePickerAction.ObserveSelected)
      val effect = awaitItem()
      assertTrue(effect is DevicePickerEffect.Observe)
      val columns = (effect as DevicePickerEffect.Observe).columns
      assertEquals(listOf("emulator-5554"), columns.map { it.deviceId })
      assertEquals(Platform.Android, columns.first().platform)
      cancelAndIgnoreRemainingEvents()
    }
  }

  @Test
  fun `clear filter resets that dimension`() = testScope.runTest {
    val vm =
      DevicePickerViewModel(fake(), FakeDeviceBootController(), this, UnconfinedTestDispatcher())
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Android))
    vm.onAction(DevicePickerAction.ToggleOs("35"))
    vm.onAction(DevicePickerAction.ClearFilter(FilterDimension.Platform))
    val f = content(vm).filters
    assertTrue(f.platforms.isEmpty())
    assertTrue(f.osKeys.isEmpty()) // clearing platform also clears the gated OS selection
    assertNull(f.states.firstOrNull())
  }

  @Test
  fun `booting a shut-down card marks it booting until the boot resolves`() = testScope.runTest {
    val boot = FakeDeviceBootController().apply { autoComplete = false }
    val v = vm(bootController = boot)
    v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
    assertEquals(setOf("Pixel_6_API_33"), content(v).bootingIds)
    assertEquals(listOf("Pixel_6_API_33"), boot.bootRequests.map { it.id })
    boot.complete() // let the held boot resolve so runTest can finish
  }

  @Test
  fun `successful boot reloads to booted, auto-selects the new id, and clears booting`() =
    testScope.runTest {
      val resources = fake()
      val boot =
        FakeDeviceBootController().apply {
          // The daemon re-keys a booted device to a runtime serial (emulator-5556), not the AVD id,
          // and returns that exact id from startDevice — auto-select keys on it, not the name.
          result = Result.success("emulator-5556")
          onSuccess = {
            resources.bootedDevicesResponse =
              """
              {"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,
               "lastUpdated":"x","devices":[
                 {"name":"Pixel 8 API 35","platform":"android","deviceId":"emulator-5554",
                  "source":"local","isVirtual":true,"status":"booted"},
                 {"name":"Pixel 6 API 33","platform":"android","deviceId":"emulator-5556",
                  "source":"local","isVirtual":true,"status":"booted"}]}
              """
                .trimIndent()
          }
        }
      val v = vm(resourceClient = resources, bootController = boot)
      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
      val c = content(v)
      assertTrue("emulator-5556" in c.selectedIds)
      assertTrue(c.bootingIds.isEmpty())
      assertTrue(c.devices.any { it.id == "emulator-5556" && it.state == DeviceState.Booted })
      assertTrue(c.devices.none { it.id == "Pixel_6_API_33" }) // shut-down entry replaced by booted
    }

  @Test
  fun `failed boot clears booting and exposes a retryable error`() = testScope.runTest {
    val boot =
      FakeDeviceBootController().apply { result = Result.failure(RuntimeException("boom")) }
    val v = vm(bootController = boot)
    v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
    val c = content(v)
    assertTrue(c.bootingIds.isEmpty())
    assertEquals("boom", c.bootErrors["Pixel_6_API_33"])
  }

  @Test
  fun `booting a device that is already booting is a no-op`() = testScope.runTest {
    val boot = FakeDeviceBootController().apply { autoComplete = false }
    val v = vm(bootController = boot)
    v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
    v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
    assertEquals(1, boot.bootRequests.size)
    boot.complete() // let the held boot resolve so runTest can finish
  }

  @Test
  fun `booting an already-booted device is ignored`() = testScope.runTest {
    val boot = FakeDeviceBootController()
    val v = vm(bootController = boot)
    v.onAction(DevicePickerAction.BootDevice("emulator-5554")) // already booted
    assertTrue(boot.bootRequests.isEmpty())
    assertTrue(content(v).bootingIds.isEmpty())
  }

  @Test
  fun `a refresh mid-boot preserves the guard and cannot issue a second startDevice`() =
    testScope.runTest {
      val boot = FakeDeviceBootController().apply { autoComplete = false } // hold the boot open
      val v = vm(bootController = boot)
      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
      assertEquals(setOf("Pixel_6_API_33"), content(v).bootingIds)
      // Reopen/refresh while the boot is still in flight — load() swaps Content out and back.
      v.onAction(DevicePickerAction.Refresh)
      assertEquals(setOf("Pixel_6_API_33"), content(v).bootingIds) // guard survived the reload
      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33")) // clicking again must not re-boot
      assertEquals(1, boot.bootRequests.size)
      boot.complete() // release; device still shut down on reload -> boot did not complete
    }

  @Test
  fun `a boot completing after a mid-boot refresh still auto-selects the booted device`() =
    testScope.runTest {
      val resources = fake()
      val boot =
        FakeDeviceBootController().apply {
          autoComplete = false
          result = Result.success("emulator-5556")
        }
      val v = vm(resourceClient = resources, bootController = boot)
      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
      v.onAction(DevicePickerAction.Refresh) // state cycled Loading -> Content, guard preserved
      assertEquals(setOf("Pixel_6_API_33"), content(v).bootingIds)
      // The daemon finished the boot; it now reports the device booted under a runtime serial.
      resources.bootedDevicesResponse =
        """
        {"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,
         "lastUpdated":"x","devices":[
           {"name":"Pixel 8 API 35","platform":"android","deviceId":"emulator-5554",
            "source":"local","isVirtual":true,"status":"booted"},
           {"name":"Pixel 6 API 33","platform":"android","deviceId":"emulator-5556",
            "source":"local","isVirtual":true,"status":"booted"}]}
        """
          .trimIndent()
      boot.complete() // reloadAfterBoot fetches -> device booted -> auto-select by runtime id
      val c = content(v)
      assertTrue("emulator-5556" in c.selectedIds)
      assertTrue(c.bootingIds.isEmpty())
      assertTrue(c.devices.any { it.id == "emulator-5556" && it.state == DeviceState.Booted })
    }

  @Test
  fun `concurrent boots of two same-named devices each auto-select their own runtime id`() =
    testScope.runTest {
      // Two shut-down AVDs share a display name; only the exact runtime id disambiguates them.
      val resources =
        FakeMcpResourceClient().apply {
          bootedDevicesResponse = bootedJson()
          deviceImagesResponse =
            """
            {"totalCount":2,"androidCount":2,"iosCount":0,"lastUpdated":"x","images":[
              {"name":"Pixel 8","platform":"android","deviceId":"avd_a","target":"android-34"},
              {"name":"Pixel 8","platform":"android","deviceId":"avd_b","target":"android-34"}]}
            """
              .trimIndent()
        }
      // Runtime ids the "daemon" assigns; a name-based auto-select could not tell these apart.
      val runtimeIds = mapOf("avd_a" to "emu-A", "avd_b" to "emu-B")
      val bootedSoFar = mutableListOf<String>()
      val boot =
        object : DeviceBootController {
          val gates = mutableMapOf<String, CompletableDeferred<Unit>>()
          val requests = mutableListOf<PickerDevice>()

          override suspend fun boot(device: PickerDevice): Result<String> {
            requests += device
            val gate = CompletableDeferred<Unit>()
            gates[device.id] = gate
            gate.await()
            val runtimeId = runtimeIds.getValue(device.id)
            bootedSoFar += runtimeId
            resources.bootedDevicesResponse = bootedJson(*bootedSoFar.toTypedArray())
            return Result.success(runtimeId)
          }
        }
      val v = DevicePickerViewModel(resources, boot, testScope, UnconfinedTestDispatcher())

      v.onAction(DevicePickerAction.BootDevice("avd_a")) // in flight
      v.onAction(DevicePickerAction.BootDevice("avd_b")) // in flight, both booting
      boot.gates.getValue("avd_a").complete(Unit)
      boot.gates.getValue("avd_b").complete(Unit)

      val c = content(v)
      // Each completion selected ITS OWN runtime id — the second did not re-select the first.
      assertEquals(setOf("emu-A", "emu-B"), c.selectedIds)
      assertTrue(c.devices.any { it.id == "emu-A" && it.state == DeviceState.Booted })
      assertTrue(c.devices.any { it.id == "emu-B" && it.state == DeviceState.Booted })
      assertEquals(2, boot.requests.size)
    }

  @Test
  fun `a stale load resuming after a boot completion cannot clobber the fresh state`() =
    testScope.runTest {
      val client =
        GatedResourceClient(
          bootedJson = SINGLE_BOOTED_PIXEL8,
          imagesJson = THREE_IMAGES,
        )
      val boot =
        FakeDeviceBootController().apply {
          autoComplete = false
          result = Result.success("emulator-5556")
          onSuccess = { client.bootedJson = TWO_BOOTED_PIXEL8_AND_6 }
        }
      val v = DevicePickerViewModel(client, boot, testScope, UnconfinedTestDispatcher())
      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33")) // boot in flight (gated)

      // Start a Refresh that reads the OLD booted list, then stalls before it can emit.
      val staleGate = CompletableDeferred<Unit>()
      client.imagesGate = staleGate
      v.onAction(DevicePickerAction.Refresh)
      client.imagesGate = null // the post-boot reload must not be gated

      boot.complete() // reloadAfterBoot fetches fresh, emits + selects the booted device
      assertTrue("emulator-5556" in content(v).selectedIds)

      staleGate.complete(Unit) // stale Refresh resumes with the OLD (shut-down) list — dropped
      val c = content(v)
      assertTrue("emulator-5556" in c.selectedIds) // fresh post-boot state survived
      assertTrue(c.devices.any { it.id == "emulator-5556" && it.state == DeviceState.Booted })
      assertTrue(c.devices.none { it.id == "Pixel_6_API_33" }) // stale shut-down card not restored

      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33")) // gone -> no second startDevice
      assertEquals(1, boot.bootRequests.size)
    }

  @Test
  fun `a booted-read error after boot retains the snapshot instead of fabricating a shutdown card`() =
    testScope.runTest {
      val client = ToggleErrorResourceClient()
      val boot =
        FakeDeviceBootController().apply {
          result = Result.success("emulator-5556")
          onSuccess = { client.failBooted = true } // the post-boot booted read errors transiently
        }
      val v = DevicePickerViewModel(client, boot, testScope, UnconfinedTestDispatcher())
      // Initial load is healthy: Pixel 8 booted, Pixel 6 shut down.
      assertTrue(
        content(v).devices.any { it.id == "emulator-5554" && it.state == DeviceState.Booted }
      )

      v.onAction(DevicePickerAction.BootDevice("Pixel_6_API_33"))
      val c = content(v)
      // The failed booted read did NOT rebuild from the images-only read (which would have shown
      // the
      // still-booted Pixel 8 as shut down). Previous snapshot retained; a retry is surfaced.
      assertTrue(c.devices.any { it.id == "emulator-5554" && it.state == DeviceState.Booted })
      assertTrue(c.bootingIds.isEmpty())
      assertTrue(c.bootErrors.containsKey("Pixel_6_API_33"))
    }

  @Test
  fun `a resource read error surfaces as Error state rather than an empty picker`() =
    testScope.runTest {
      val client = ToggleErrorResourceClient().apply { failBooted = true }
      val v =
        DevicePickerViewModel(
          client,
          FakeDeviceBootController(),
          testScope,
          UnconfinedTestDispatcher(),
        )
      assertTrue(v.state.value is DevicePickerUiState.Error)
    }

  private companion object {
    const val SINGLE_BOOTED_PIXEL8 =
      """{"totalCount":1,"androidCount":1,"iosCount":0,"virtualCount":1,"physicalCount":0,""" +
        """"lastUpdated":"x","devices":[{"name":"Pixel 8 API 35","platform":"android",""" +
        """"deviceId":"emulator-5554","source":"local","isVirtual":true,"status":"booted"}]}"""

    const val TWO_BOOTED_PIXEL8_AND_6 =
      """{"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,""" +
        """"lastUpdated":"x","devices":[""" +
        """{"name":"Pixel 8 API 35","platform":"android","deviceId":"emulator-5554",""" +
        """"source":"local","isVirtual":true,"status":"booted"},""" +
        """{"name":"Pixel 6 API 33","platform":"android","deviceId":"emulator-5556",""" +
        """"source":"local","isVirtual":true,"status":"booted"}]}"""

    const val THREE_IMAGES =
      """{"totalCount":3,"androidCount":2,"iosCount":1,"lastUpdated":"x","images":[""" +
        """{"name":"Pixel 8 API 35","platform":"android","deviceId":"Pixel_8_API_35","target":"android-35"},""" +
        """{"name":"Pixel 6 API 33","platform":"android","deviceId":"Pixel_6_API_33","target":"android-33"},""" +
        """{"name":"iPhone 15","platform":"ios","deviceId":"iphone-15","iosVersion":"17.2"}]}"""

    fun bootedJson(vararg deviceIds: String): String {
      val devices =
        deviceIds.joinToString(",") { id ->
          """{"name":"Pixel 8","platform":"android","deviceId":"$id",""" +
            """"source":"local","isVirtual":true,"status":"booted"}"""
        }
      val n = deviceIds.size
      return """{"totalCount":$n,"androidCount":$n,"iosCount":0,"virtualCount":$n,""" +
        """"physicalCount":0,"lastUpdated":"x","devices":[$devices]}"""
    }
  }
}

/** Resource fake whose device-images read can be gated to reorder a load against a boot. */
private class GatedResourceClient(var bootedJson: String, private val imagesJson: String) :
  McpResourceClient {
  var imagesGate: CompletableDeferred<Unit>? = null

  override suspend fun readResource(uri: String): ResourceReadResult =
    when (uri) {
      "automobile:devices/booted" -> ResourceReadResult.Success(bootedJson, "application/json")
      "automobile:devices/images" -> {
        imagesGate?.await()
        ResourceReadResult.Success(imagesJson, "application/json")
      }
      else -> ResourceReadResult.Error("unknown resource: $uri")
    }

  override suspend fun listResources(): List<ResourceInfo> = emptyList()

  override fun close() {}
}

/** Resource fake whose booted read can be flipped to an error to exercise partial-read handling. */
private class ToggleErrorResourceClient : McpResourceClient {
  var failBooted: Boolean = false

  private val bootedJson =
    """{"totalCount":1,"androidCount":1,"iosCount":0,"virtualCount":1,"physicalCount":0,""" +
      """"lastUpdated":"x","devices":[{"name":"Pixel 8 API 35","platform":"android",""" +
      """"deviceId":"emulator-5554","source":"local","isVirtual":true,"status":"booted"}]}"""

  private val imagesJson =
    """{"totalCount":2,"androidCount":2,"iosCount":0,"lastUpdated":"x","images":[""" +
      """{"name":"Pixel 8 API 35","platform":"android","deviceId":"Pixel_8_API_35","target":"android-35"},""" +
      """{"name":"Pixel 6 API 33","platform":"android","deviceId":"Pixel_6_API_33","target":"android-33"}]}"""

  override suspend fun readResource(uri: String): ResourceReadResult =
    when (uri) {
      "automobile:devices/booted" ->
        if (failBooted) ResourceReadResult.Error("transient booted-read failure")
        else ResourceReadResult.Success(bootedJson, "application/json")
      "automobile:devices/images" -> ResourceReadResult.Success(imagesJson, "application/json")
      else -> ResourceReadResult.Error("unknown resource: $uri")
    }

  override suspend fun listResources(): List<ResourceInfo> = emptyList()

  override fun close() {}
}
