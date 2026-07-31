package dev.jasonpearson.automobile.video

import android.os.SystemClock
import android.system.Os
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Device-side record of one host-owned video-server process.
 *
 * The host uses these records only after their heartbeat expires. To identify the process for
 * targeted cleanup a reused PID can never spoof, the lease records the opaque per-session
 * `socketName` (also the on-disk filename and a `--socket-name` argv token) rather than the raw
 * session token: the token is now the on-wire auth secret (issue #4729), so it is never written to
 * disk in cleartext (issue #4731). Only its SHA-256 hash is persisted, which a lease owner can
 * re-derive from the token it holds to confirm ownership without the file ever disclosing the
 * secret.
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
  val sessionTokenHash: String,
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
      // Bumped from 1: the record now carries `sessionTokenHash` in place of the raw
      // `sessionToken` (issue #4731). Older-shape leases lack `sessionTokenHash`; the host
      // validator rejects them and its `*.json` sweep reclaims them.
      .put("version", 2)
      .put("socketName", record.socketName)
      .put("sessionTokenHash", record.sessionTokenHash)
      .put("pid", record.pid)
      .put("ownerPid", record.ownerPid)
      .put("deviceSerial", record.deviceSerial)
      .put("forwardPort", record.forwardPort)
      .put("startedAtMs", record.startedAtMs)
      .put("heartbeatAtMs", record.heartbeatAtMs)
      .put("heartbeatElapsedRealtimeMs", record.heartbeatElapsedRealtimeMs)
      .toString()
}

/**
 * SHA-256 hex of a session token, the only token-derived value ever written to a lease file
 * (issue #4731). `MessageDigest` is the JDK's canonical digest primitive (the same one
 * [VideoHandshake] uses for its constant-time compare); the host mirrors this with
 * `createHash("sha256")` over the ASCII bytes so both ends agree on the hash a lease owner
 * re-derives to prove ownership.
 */
internal fun sessionTokenSha256Hex(token: String): String =
  MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.US_ASCII)).joinToString(
    ""
  ) {
    "%02x".format(it.toInt() and 0xFF)
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
  // Injected so JVM unit tests (where `android.system.Os` is only a compile stub) can supply a
  // recording fake. On device the default delegates to the real syscall.
  private val chmod: (path: String, mode: Int) -> Unit = { path, mode -> Os.chmod(path, mode) },
) {
  private val token = requireNotNull(options.token)
  private val sessionTokenHash = sessionTokenSha256Hex(token)
  // The filename is the opaque, non-secret socket name (issue #4731), never the token. It is
  // world-readable via `/proc/net/unix` already, so it discloses nothing the token did not, and it
  // is the stable id the host reconcile/sweep matches a lease to its session and forward on.
  private val leaseFile = File(leaseDirectory, "${options.socketName}.json")
  private val startedAtMs = nowMs()

  @Volatile private var running = false
  private var heartbeatThread: Thread? = null

  fun start() {
    if (running) return
    if (!leaseDirectory.mkdirs() && !leaseDirectory.isDirectory) {
      throw IllegalStateException("Unable to create video session lease directory")
    }
    // Tighten the directory to owner-only so a peer process cannot even enumerate lease files.
    restrictPermissions(leaseDirectory, DIRECTORY_MODE)

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
            sessionTokenHash = sessionTokenHash,
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
      // Restrict the temp file to owner-only BEFORE the atomic rename so the lease is never visible
      // to another process, not even for the instant between create and rename (issue #4731).
      restrictPermissions(temporary, FILE_MODE)
      if (!temporary.renameTo(leaseFile)) {
        temporary.copyTo(leaseFile, overwrite = true)
        // copyTo creates a fresh destination inode with default perms; re-tighten it.
        restrictPermissions(leaseFile, FILE_MODE)
        temporary.delete()
      }
    } catch (error: Exception) {
      // The socket name (not the secret token) identifies the failing session in logs.
      System.err.println(
        "VIDEO_SESSION_HEARTBEAT_FAILED socket=${options.socketName} error=${error.message}"
      )
    }
  }

  /**
   * Best-effort `chmod` to [mode]. A failure here (e.g. an exotic ROM where `/data/local/tmp`
   * denies the syscall) must not sink the heartbeat, whose liveness value outweighs the hardening:
   * it is logged and swallowed so the lease still lands. The `.tmp` file is created by this same
   * owner-only process, so even without the chmod the exposure window is narrow.
   */
  private fun restrictPermissions(file: File, mode: Int) {
    try {
      chmod(file.absolutePath, mode)
    } catch (error: Exception) {
      System.err.println(
        "VIDEO_SESSION_CHMOD_FAILED socket=${options.socketName} path=${file.absolutePath} " +
          "mode=$mode error=${error.message}"
      )
    }
  }

  companion object {
    const val LEASE_DIRECTORY = "/data/local/tmp/automobile-video-sessions"
    private const val HEARTBEAT_INTERVAL_MS = 5_000L

    /** `0700`: owner-only rwx on the lease directory (issue #4731). */
    private const val DIRECTORY_MODE = 448

    /** `0600`: owner-only rw on each lease file (issue #4731). */
    private const val FILE_MODE = 384

    /**
     * Describes a lease that owns [socketName], if one exists for another token. This is
     * diagnostic-only: collision handling never kills a process.
     */
    fun collisionDiagnostic(socketName: String, requestedToken: String?): String? {
      // Compare hashes, never the raw token: the lease stores only `sessionTokenHash` (issue
      // #4731), so a mismatch is detected by hashing the requested token and comparing digests.
      val requestedTokenHash = requestedToken?.let(::sessionTokenSha256Hex)
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
              it.optString("sessionTokenHash") != requestedTokenHash
          } ?: return null

      val heartbeatAtMs = record.optLong("heartbeatAtMs", 0)
      val ageMs = (System.currentTimeMillis() - heartbeatAtMs).coerceAtLeast(0)
      return ("VIDEO_SESSION_COLLISION socket=$socketName " +
        "existingOwnerPid=${record.optLong("ownerPid", -1)} " +
        "existingTokenHash=${record.optString("sessionTokenHash")} " +
        "tokenMismatch=true ageMs=$ageMs")
    }
  }
}
