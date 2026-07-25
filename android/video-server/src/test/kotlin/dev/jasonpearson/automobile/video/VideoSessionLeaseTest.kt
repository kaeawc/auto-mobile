package dev.jasonpearson.automobile.video

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VideoSessionLeaseTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @Test
  fun writesHeartbeatInDeviceElapsedRealtimeDomainAndRemovesLeaseOnStop() {
    val leaseDirectory = File(temporaryFolder.root, "leases")
    var writtenRecord: VideoSessionLeaseRecord? = null
    val lease =
      VideoSessionLease(
        options =
          VideoSessionOptions(
            socketName = "automobile_video_session",
            token = "session-0001",
            ownerPid = 456,
            deviceSerial = "emulator-5554",
            forwardPort = 61234,
          ),
        processId = 123,
        nowMs = { 1_000L },
        elapsedRealtimeMs = { 42_000L },
        leaseDirectory = leaseDirectory,
        serializer =
          VideoSessionLeaseSerializer { record ->
            writtenRecord = record
            "{}"
          },
      )

    lease.start()

    val leaseFile = File(leaseDirectory, "session-0001.json")
    assertTrue(leaseFile.exists())
    assertEquals(42_000L, writtenRecord?.heartbeatElapsedRealtimeMs)
    assertEquals(1_000L, writtenRecord?.heartbeatAtMs)

    lease.stop()
    assertFalse(leaseFile.exists())
  }
}
