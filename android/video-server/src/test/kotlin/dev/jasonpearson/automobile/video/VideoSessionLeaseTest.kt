package dev.jasonpearson.automobile.video

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VideoSessionLeaseTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  private val chmodCalls = mutableListOf<Pair<String, Int>>()
  private val recordingChmod: (String, Int) -> Unit = { path, mode -> chmodCalls.add(path to mode) }

  // The production serializer uses `org.json.JSONObject`, which is only an android.jar compile stub
  // and unavailable on the JVM test runtime. Inject a capturing serializer so tests exercise the
  // real record shape and file lifecycle without loading org.json.
  private var capturedRecord: VideoSessionLeaseRecord? = null
  private val capturingSerializer = VideoSessionLeaseSerializer { record ->
    capturedRecord = record
    // A minimal but valid stand-in payload; the record itself is asserted, not these bytes.
    "{\"sessionTokenHash\":\"${record.sessionTokenHash}\",\"socketName\":\"${record.socketName}\"}"
  }

  private fun leaseWith(
    leaseDirectory: File,
    chmod: (String, Int) -> Unit = recordingChmod,
    socketName: String = "automobile_video_session",
    token: String = "session-0001",
  ): VideoSessionLease =
    VideoSessionLease(
      options =
        VideoSessionOptions(
          socketName = socketName,
          token = token,
          ownerPid = 456,
          deviceSerial = "emulator-5554",
          forwardPort = 61234,
        ),
      processId = 123,
      nowMs = { 1_000L },
      elapsedRealtimeMs = { 42_000L },
      leaseDirectory = leaseDirectory,
      serializer = capturingSerializer,
      chmod = chmod,
    )

  private fun expectedHash(token: String): String =
    MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.US_ASCII)).joinToString(
      ""
    ) {
      "%02x".format(it.toInt() and 0xFF)
    }

  @Test
  fun writesHeartbeatInDeviceElapsedRealtimeDomainAndRemovesLeaseOnStop() {
    val leaseDirectory = File(temporaryFolder.root, "leases")
    val lease = leaseWith(leaseDirectory)

    lease.start()

    // The on-disk filename is derived from the non-secret socket name, never the token (#4731).
    val leaseFile = File(leaseDirectory, "automobile_video_session.json")
    assertTrue(leaseFile.exists())
    assertEquals(42_000L, capturedRecord?.heartbeatElapsedRealtimeMs)
    assertEquals(1_000L, capturedRecord?.heartbeatAtMs)

    lease.stop()
    assertFalse(leaseFile.exists())
  }

  @Test
  fun persistsOnlyTheTokenHashNeverTheRawToken() {
    val leaseDirectory = File(temporaryFolder.root, "leases")
    val token = "session-0001"
    val lease = leaseWith(leaseDirectory, token = token)

    lease.start()

    // The record carries the SHA-256 hash, never the raw token (issue #4731).
    val record = requireNotNull(capturedRecord)
    assertEquals(expectedHash(token), record.sessionTokenHash)
    assertFalse(record.sessionTokenHash == token)

    // Nothing written to disk (filename or contents) discloses the raw token.
    val leaseFile = File(leaseDirectory, "automobile_video_session.json")
    val contents = leaseFile.readText()
    assertFalse(contents.contains(token))
    assertFalse(leaseFile.absolutePath.contains(token))
    assertTrue(contents.contains(expectedHash(token)))

    lease.stop()
  }

  @Test
  fun restrictsDirectoryAndFilePermissionsWithTheTempFileTightenedBeforeRename() {
    val leaseDirectory = File(temporaryFolder.root, "leases")
    val lease = leaseWith(leaseDirectory)

    lease.start()

    val dirPath = leaseDirectory.absolutePath
    val tmpPath = File(leaseDirectory, "automobile_video_session.json.tmp").absolutePath
    // Directory tightened to 0700 (448).
    assertTrue(chmodCalls.contains(dirPath to 448))
    // The temp file is tightened to 0600 (384) BEFORE it is renamed into place: there is no
    // world-readable window on the final lease file (issue #4731).
    assertTrue(chmodCalls.contains(tmpPath to 384))
    val dirIndex = chmodCalls.indexOf(dirPath to 448)
    val tmpIndex = chmodCalls.indexOf(tmpPath to 384)
    assertTrue("directory chmod precedes the file chmod", dirIndex < tmpIndex)

    lease.stop()
  }

  @Test
  fun heartbeatSurvivesAChmodFailure() {
    val leaseDirectory = File(temporaryFolder.root, "leases")
    val lease =
      leaseWith(leaseDirectory, chmod = { _, _ -> throw RuntimeException("chmod denied") })

    lease.start()

    // A chmod failure is swallowed; the lease still lands so liveness is preserved.
    val leaseFile = File(leaseDirectory, "automobile_video_session.json")
    assertTrue(leaseFile.exists())

    lease.stop()
    assertFalse(leaseFile.exists())
  }
}
