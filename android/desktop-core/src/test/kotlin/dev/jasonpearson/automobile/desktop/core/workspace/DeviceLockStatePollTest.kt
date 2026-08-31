package dev.jasonpearson.automobile.desktop.core.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceLockStatePollTest {

  @Test
  fun `maps devices with a known lock state and omits those whose locked was not read`() {
    // Device 1 reports locked; device 2 (locked field absent) is a state the daemon could not read
    // and must be OMITTED, not coerced to false — otherwise a transient probe gap force-unlocks it.
    val payload =
      """
      {"lastUpdated":"x","lockStates":[
         {"deviceId":"emulator-5554","locked":true},
         {"deviceId":"emulator-5556"}]}
      """
        .trimIndent()
    assertEquals(mapOf("emulator-5554" to true), parseDeviceLockStates(payload))
  }

  @Test
  fun `maps an explicit locked false so a known-unlocked device unlocks its pane`() {
    val payload =
      """
      {"lastUpdated":"x","lockStates":[{"deviceId":"emulator-5554","locked":false}]}
      """
        .trimIndent()
    assertEquals(mapOf("emulator-5554" to false), parseDeviceLockStates(payload))
  }

  @Test
  fun `malformed payload yields an empty map so the poll is a no-op`() {
    assertTrue(parseDeviceLockStates("not json").isEmpty())
    assertTrue(parseDeviceLockStates("").isEmpty())
  }

  @Test
  fun `booted-devices fallback derives lock from the full payload, omitting unread devices`() {
    // Older daemons expose lock only via automobile:devices/booted; the poll's fallback derives the
    // same deviceId -> locked snapshot from its `locked` field, omitting a device that lacks it.
    val payload =
      """
      {"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,
       "lastUpdated":"x","devices":[
         {"name":"P8","platform":"android","deviceId":"emulator-5554","source":"local","isVirtual":true,"status":"booted","locked":true},
         {"name":"P9","platform":"android","deviceId":"emulator-5556","source":"local","isVirtual":true,"status":"booted"}]}
      """
        .trimIndent()
    assertEquals(mapOf("emulator-5554" to true), parseBootedLockStates(payload))
  }

  @Test
  fun `booted-devices fallback yields an empty map for a malformed payload`() {
    assertTrue(parseBootedLockStates("not json").isEmpty())
    assertTrue(parseBootedLockStates("").isEmpty())
  }

  @Test
  fun `extracts only known device session UUIDs from booted devices`() {
    val payload =
      """
      {"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,
       "lastUpdated":"x","devices":[
         {"name":"P8","platform":"android","deviceId":"emulator-5554","source":"local","isVirtual":true,"status":"booted","deviceSessionUuid":"epoch-a"},
         {"name":"P9","platform":"android","deviceId":"emulator-5556","source":"local","isVirtual":true,"status":"booted"}]}
      """
        .trimIndent()

    assertEquals(mapOf("emulator-5554" to "epoch-a"), parseBootedDeviceSessionUuids(payload))
  }

  @Test
  fun `device session UUID extraction is empty for malformed payload`() {
    assertTrue(parseBootedDeviceSessionUuids("not json").isEmpty())
  }
}
