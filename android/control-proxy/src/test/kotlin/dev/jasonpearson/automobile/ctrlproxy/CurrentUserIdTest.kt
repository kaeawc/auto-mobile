package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowProcess

@RunWith(RobolectricTestRunner::class)
class CurrentUserIdTest {
  @Test
  fun `UID division respects user range boundaries`() {
    assertEquals(0, CurrentUserId.forUid(10123))
    assertEquals(10, CurrentUserId.forUid(1010123))
    assertEquals(0, CurrentUserId.forUid(0))
    assertEquals(0, CurrentUserId.forUid(99999))
    assertEquals(1, CurrentUserId.forUid(100000))
  }

  @Test
  @Config(sdk = [24, 31, 34, 35])
  fun `current user follows the process UID across Android versions`() {
    ShadowProcess.setUid(10123)
    assertEquals(0, CurrentUserId.current())
    ShadowProcess.setUid(1010123)
    assertEquals(10, CurrentUserId.current())
  }
}
