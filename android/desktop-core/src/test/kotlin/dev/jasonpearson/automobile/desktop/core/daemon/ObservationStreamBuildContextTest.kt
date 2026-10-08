package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import org.junit.Test

class ObservationStreamBuildContextTest {
  @Test
  fun `build context frame emits its device session and package identity`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.handleMessage(frame())
      assertEquals(
        BuildContextStreamUpdate(
          deviceId = "dev-1",
          deviceSessionUuid = "epoch-1",
          timestamp = 42L,
          packageId = "com.example.app",
          buildKey = StreamBuildKey("com.example.app", 2L, null, "hashB"),
        ),
        client.buildContextUpdates.replayCache.single(),
      )
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `null build key emits a package scoped clear`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.handleMessage(frame(buildKey = "null", deviceSessionUuid = "null"))
      val update = client.buildContextUpdates.replayCache.single()
      assertEquals("dev-1", update.deviceId)
      assertEquals("com.example.app", update.packageId)
      assertNull(update.deviceSessionUuid)
      assertNull(update.buildKey)
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `large iOS integer build version parses and round trips exactly`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.handleMessage(frame(buildKey = key(versionCode = 20260102123L)))
      val buildKey = client.buildContextUpdates.replayCache.single().buildKey!!
      assertEquals(20260102123L, buildKey.versionCode)
      val encoded = DaemonJson.encodeToString(StreamBuildKey.serializer(), buildKey)
      assertEquals(buildKey, DaemonJson.decodeFromString(StreamBuildKey.serializer(), encoded))
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `dotted iOS build key retains versionKey and ignores additive fields`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.handleMessage(
        frame(
          buildKey =
            """{"packageId":"com.example.app","versionCode":0,"versionKey":"1.2.3.4","contentHash":"hashB","futureKey":true}""",
        ),
      )
      assertEquals(
        StreamBuildKey("com.example.app", 0L, "1.2.3.4", "hashB"),
        client.buildContextUpdates.replayCache.single().buildKey,
      )
    } finally {
      client.dispose()
    }
  }

  private fun key(versionCode: Long = 2L): String =
    """{"packageId":"com.example.app","versionCode":$versionCode,"contentHash":"hashB"}"""

  private fun frame(
    buildKey: String = key(),
    deviceSessionUuid: String = "\"epoch-1\"",
  ): String =
    """{"type":"device_build_context","deviceId":"dev-1","deviceSessionUuid":$deviceSessionUuid,"timestamp":42,"packageId":"com.example.app","buildKey":$buildKey,"futureFrame":{"ignored":true}}"""
}
