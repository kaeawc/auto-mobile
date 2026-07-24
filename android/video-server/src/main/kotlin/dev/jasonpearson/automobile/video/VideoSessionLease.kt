package dev.jasonpearson.automobile.video

import android.os.SystemClock
import java.io.File
import org.json.JSONObject

/**
 * Device-side record of one host-owned video-server process.
 *
 * The host uses these records only after their heartbeat expires. The token is included in both
 * this file and the process command line so a reused PID can never make stale cleanup terminate an
 * unrelated process.
 */
data class VideoSessionOptions(
  val socketName: String,
  val token: String?,
  val ownerPid: Long?,
  val deviceSerial: String?,
  val forwardPort: Int?,
)

data class VideoSessionLeaseRecord(
  val socketName: String,
  val sessionToken: String,
  val pid: Int,
  val ownerPid: Long?,
  val deviceSerial: String?,
  val forwardPort: Int?,
  val startedAtMs: Long,
  val heartbeatAtMs: Long,
  val heartbeatElapsedRealtimeMs: Long,
)

fun interface VideoSessionLeaseSerializer {
  fun serialize(record: VideoSessionLeaseRecord): String
}

private object JsonVideoSessionLeaseSerializer : VideoSessionLeaseSerializer {
  override fun serialize(record: VideoSessionLeaseRecord): String =
    JSONObject()
      .put("version", 1)
      .put("socketName", record.socketName)
      .put("sessionToken", record.sessionToken)
      .put("pid", record.pid)
      .put("ownerPid", record.ownerPid)
      .put("deviceSerial", record.deviceSerial)
      .put("forwardPort", record.forwardPort)
      .put("startedAtMs", record.startedAtMs)
      .put("heartbeatAtMs", record.heartbeatAtMs)
      .put("heartbeatElapsedRealtimeMs", record.heartbeatElapsedRealtimeMs)
      .toString()
}

object VideoSessionArguments {
  private const val DEFAULT_SOCKET_NAME = "automobile_video"
  private val SAFE_SOCKET_NAME = Regex("[A-Za-z0-9_.-]{1,100}")
  private val SAFE_TOKEN = Regex("[A-Za-z0-9-]{8,80}")

  fun parse(args: Array<String>): VideoSessionOptions {
    val socketName = valueAfter(args, "--socket-name") ?: DEFAULT_SOCKET_NAME
    require(SAFE_SOCKET_NAME.matches(socketName)) { "Invalid --socket-name" }

    val token = valueAfter(args, "--session-token")
    require(token == null || SAFE_TOKEN.matches(token)) { "Invalid --session-token" }

    return VideoSessionOptions(
      socketName = socketName,
      token = token,
      ownerPid = valueAfter(args, "--owner-pid")?.toLongOrNull()?.takeIf { it > 0 },
      deviceSerial = valueAfter(args, "--device-serial"),
      forwardPort = valueAfter(args, "--forward-port")?.toIntOrNull()?.takeIf { it > 0 },
    )
  }

  private fun valueAfter(args: Array<String>, flag: String): String? {
    val index = args.indexOf(flag)
    return if (index >= 0 && index + 1 < args.size) args[index + 1] else null
  }
}

class VideoSessionLease(
  private val options: VideoSessionOptions,
  private val processId: Int,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val elapsedRealtimeMs: () -> Long = SystemClock::elapsedRealtime,
  private val leaseDirectory: File = File(LEASE_DIRECTORY),
  private val serializer: VideoSessionLeaseSerializer = JsonVideoSessionLeaseSerializer,
) {
  private val token = requireNotNull(options.token)
  private val leaseFile = File(leaseDirectory, "$token.json")
  private val startedAtMs = nowMs()

  @Volatile private var running = false
  private var heartbeatThread: Thread? = null

  fun start() {
    if (running) return
    if (!leaseDirectory.exists() && !leaseDirectory.mkdirs()) {
      throw IllegalStateException("Unable to create video session lease directory")
    }

    running = true
    writeHeartbeat()
    heartbeatThread =
      Thread(
          {
            while (running) {
              try {
                Thread.sleep(HEARTBEAT_INTERVAL_MS)
              } catch (_: InterruptedException) {
                break
              }
              if (running) writeHeartbeat()
            }
          },
          "automobile-video-session-heartbeat",
        )
        .also {
          it.isDaemon = true
          it.start()
        }
  }

  fun stop() {
    running = false
    heartbeatThread?.interrupt()
    try {
      heartbeatThread?.join(1_000)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    heartbeatThread = null
    leaseFile.delete()
  }

  private fun writeHeartbeat() {
    try {
      val payload =
        serializer.serialize(
          VideoSessionLeaseRecord(
            socketName = options.socketName,
            sessionToken = token,
            pid = processId,
            ownerPid = options.ownerPid,
            deviceSerial = options.deviceSerial,
            forwardPort = options.forwardPort,
            startedAtMs = startedAtMs,
            heartbeatAtMs = nowMs(),
            heartbeatElapsedRealtimeMs = elapsedRealtimeMs(),
          )
        )
      val temporary = File(leaseFile.parentFile, "${leaseFile.name}.tmp")
      temporary.writeText(payload)
      if (!temporary.renameTo(leaseFile)) {
        temporary.copyTo(leaseFile, overwrite = true)
        temporary.delete()
      }
    } catch (error: Exception) {
      System.err.println("VIDEO_SESSION_HEARTBEAT_FAILED token=$token error=${error.message}")
    }
  }

  companion object {
    const val LEASE_DIRECTORY = "/data/local/tmp/automobile-video-sessions"
    private const val HEARTBEAT_INTERVAL_MS = 5_000L

    /**
     * Describes a lease that owns [socketName], if one exists for another token. This is
     * diagnostic-only: collision handling never kills a process.
     */
    fun collisionDiagnostic(socketName: String, requestedToken: String?): String? {
      val record =
        File(LEASE_DIRECTORY)
          .listFiles { file -> file.extension == "json" }
          ?.asSequence()
          ?.mapNotNull { file ->
            try {
              JSONObject(file.readText())
            } catch (_: Exception) {
              null
            }
          }
          ?.firstOrNull {
            it.optString("socketName") == socketName &&
              it.optString("sessionToken") != requestedToken
          } ?: return null

      val heartbeatAtMs = record.optLong("heartbeatAtMs", 0)
      val ageMs = (System.currentTimeMillis() - heartbeatAtMs).coerceAtLeast(0)
      return ("VIDEO_SESSION_COLLISION socket=$socketName " +
        "existingOwnerPid=${record.optLong("ownerPid", -1)} " +
        "existingToken=${record.optString("sessionToken")} " +
        "requestedToken=$requestedToken tokenMismatch=true ageMs=$ageMs")
    }
  }
}
