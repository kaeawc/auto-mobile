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
      {"totalCount":2,"androidCount":2,"iosCount":0,"virtualCount":2,"physicalCount":0,
       "lastUpdated":"x","devices":[
         {"name":"Pixel 8","platform":"android","deviceId":"emulator-5554",
          "source":"local","isVirtual":true,"status":"booted","locked":true},
         {"name":"Pixel 7","platform":"android","deviceId":"emulator-5556",
          "source":"local","isVirtual":true,"status":"booted"}]}
      """
        .trimIndent()
    assertEquals(mapOf("emulator-5554" to true), parseDeviceLockStates(payload))
  }

  @Test
  fun `maps an explicit locked false so a known-unlocked device unlocks its pane`() {
    val payload =
      """
      {"totalCount":1,"androidCount":1,"iosCount":0,"virtualCount":1,"physicalCount":0,
       "lastUpdated":"x","devices":[
         {"name":"Pixel 8","platform":"android","deviceId":"emulator-5554",
          "source":"local","isVirtual":true,"status":"booted","locked":false}]}
      """
        .trimIndent()
    assertEquals(mapOf("emulator-5554" to false), parseDeviceLockStates(payload))
  }

  @Test
  fun `malformed payload yields an empty map so the poll is a no-op`() {
    assertTrue(parseDeviceLockStates("not json").isEmpty())
    assertTrue(parseDeviceLockStates("").isEmpty())
  }
}
