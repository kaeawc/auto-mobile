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
}
