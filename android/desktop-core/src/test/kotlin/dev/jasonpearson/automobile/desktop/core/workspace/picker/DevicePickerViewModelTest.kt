package dev.jasonpearson.automobile.desktop.core.workspace.picker

import app.cash.turbine.test
import dev.jasonpearson.automobile.desktop.core.mcp.FakeMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
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

  @Test
  fun `loads and unifies booted + images with dedupe and iOS architecture`() = testScope.runTest {
    val vm = DevicePickerViewModel(fake(), this)
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
    val vm = DevicePickerViewModel(fake(), this)
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Ios))
    assertEquals(setOf(Platform.Ios), content(vm).filters.platforms)
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Ios))
    assertTrue(content(vm).filters.platforms.isEmpty())
  }

  @Test
  fun `only booted devices can be selected`() = testScope.runTest {
    val vm = DevicePickerViewModel(fake(), this)
    vm.onAction(DevicePickerAction.ToggleSelect("iphone-15")) // shutdown — ignored
    assertTrue(content(vm).selectedIds.isEmpty())
    vm.onAction(DevicePickerAction.ToggleSelect("emulator-5554")) // booted
    assertEquals(setOf("emulator-5554"), content(vm).selectedIds)
  }

  @Test
  fun `observe selected emits one column per selected booted device`() = testScope.runTest {
    val vm = DevicePickerViewModel(fake(), this)
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
    val vm = DevicePickerViewModel(fake(), this)
    vm.onAction(DevicePickerAction.TogglePlatform(Platform.Android))
    vm.onAction(DevicePickerAction.ToggleOs("35"))
    vm.onAction(DevicePickerAction.ClearFilter(FilterDimension.Platform))
    val f = content(vm).filters
    assertTrue(f.platforms.isEmpty())
    assertTrue(f.osKeys.isEmpty()) // clearing platform also clears the gated OS selection
    assertNull(f.states.firstOrNull())
  }
}
