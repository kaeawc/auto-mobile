package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.BuildContextStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.StreamBuildKey
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceBuildKey
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

class NavigationBuildKeyTrackerTest {
  private val app = "com.example.app"
  private val key = StreamBuildKey(app, 20260102123L, null, "hashB")

  private fun update(
    packageId: String = app,
    buildKey: StreamBuildKey? = key,
    deviceId: String = "dev-1",
    sessionUuid: String? = "epoch-1",
  ) = BuildContextStreamUpdate(deviceId, sessionUuid, 42L, packageId, buildKey)

  @Test
  fun `unknown key keeps device and package fallback`() {
    val context = NavigationBuildKeyTracker("dev-1").activeContext(app)
    assertEquals("dev-1", context.deviceId)
    assertEquals(app, context.packageId)
    assertNull(context.buildKey)
  }

  @Test
  fun `keys are kept per package and only applied to the matching app`() {
    val other = key.copy(packageId = "com.example.other")
    val tracker =
      NavigationBuildKeyTracker("dev-1")
        .updated(update())
        .updated(update(packageId = other.packageId, buildKey = other))
    assertEquals(
      ProvenanceBuildKey(app, key.versionCode, key.contentHash),
      tracker.activeContext(app).buildKey,
    )
    assertEquals(other.packageId, tracker.activeContext(other.packageId).buildKey?.packageId)
    assertNull(tracker.activeContext("com.unknown").buildKey)
    assertNull(
      tracker.updated(update(buildKey = key.copy(packageId = "wrong"))).activeContext(app).buildKey,
    )
  }

  @Test
  fun `null clears only the named package key`() {
    val other = key.copy(packageId = "com.example.other")
    val tracker =
      NavigationBuildKeyTracker("dev-1")
        .updated(update())
        .updated(update(packageId = other.packageId, buildKey = other))
        .updated(update(buildKey = null))
    assertNull(tracker.activeContext(app).buildKey)
    assertEquals(other.versionCode, tracker.activeContext(other.packageId).buildKey?.versionCode)
  }

  @Test
  fun `another device cannot apply clear or change the tracked session`() {
    val tracker = NavigationBuildKeyTracker("dev-1").updated(update())
    assertEquals(tracker, tracker.updated(update(deviceId = "dev-2", sessionUuid = "epoch-2")))
    assertEquals(tracker, tracker.updated(update(deviceId = "dev-2", buildKey = null)))
  }

  @Test
  fun `reconnect reset rejects stale replay but accepts a fresh daemon replay`() {
    val old = update()
    val tracker = NavigationBuildKeyTracker("dev-1").updated(old).reset(old)
    assertNull(tracker.activeContext(app).buildKey)
    assertNull(tracker.updated(old).activeContext(app).buildKey)
    assertEquals(
      key.versionCode,
      tracker.updated(old.copy()).activeContext(app).buildKey?.versionCode,
    )
  }

  @Test
  fun `new device session clears every old package before applying its key`() {
    val other = key.copy(packageId = "com.example.other")
    val tracker =
      NavigationBuildKeyTracker("dev-1")
        .updated(update())
        .updated(update(packageId = other.packageId, buildKey = other))
        .updated(update(sessionUuid = "epoch-2", buildKey = key.copy(contentHash = "new")))
    assertEquals("new", tracker.activeContext(app).buildKey?.contentHash)
    assertNull(tracker.activeContext(other.packageId).buildKey)
  }

  @Test
  fun `nullable session changes also clear previous keys`() {
    val tracker = NavigationBuildKeyTracker("dev-1").updated(update())
    val other = key.copy(packageId = "com.example.other")
    val unbound = tracker.updated(update(other.packageId, other, sessionUuid = null))
    assertNull(unbound.activeContext(app).buildKey)
    assertNull(unbound.updated(update()).activeContext(other.packageId).buildKey)
  }

  @Test
  fun `superseded event clears this device but ignores another device`() {
    val old = update()
    val tracker = NavigationBuildKeyTracker("dev-1").updated(old)
    val event = DeviceStreamEvent.DeviceSessionSuperseded("dev-1", "epoch-1", "epoch-2", 43L)
    assertEquals(tracker, tracker.onDeviceEvent(event.copy(deviceId = "dev-2"), old))
    val reset = tracker.onDeviceEvent(event, old)
    assertNull(reset.activeContext(app).buildKey)
    assertNull(reset.updated(old.copy()).activeContext(app).buildKey)
    assertEquals(
      key.versionCode,
      reset.updated(update(sessionUuid = "epoch-2")).activeContext(app).buildKey?.versionCode,
    )
  }

  @Test
  fun `late retirement event preserves a key already received for the successor`() {
    val tracker = NavigationBuildKeyTracker("dev-1").updated(update(sessionUuid = "epoch-2"))
    val event = DeviceStreamEvent.DeviceSessionSuperseded("dev-1", "epoch-1", "epoch-2", 43L)
    val successor = tracker.onDeviceEvent(event)
    assertEquals(key.versionCode, successor.activeContext(app).buildKey?.versionCode)
    assertEquals(successor, successor.updated(update()))
  }

  @Test
  fun `retirement does not reject a queued fresh successor frame`() {
    val tracker = NavigationBuildKeyTracker("dev-1").updated(update())
    val successor = update(sessionUuid = "epoch-2")
    val event = DeviceStreamEvent.DeviceSessionSuperseded("dev-1", "epoch-1", "epoch-2", 43L)
    val reset = tracker.onDeviceEvent(event, successor)
    assertNull(reset.activeContext(app).buildKey)
    assertEquals(key.versionCode, reset.updated(successor).activeContext(app).buildKey?.versionCode)
  }

  @Test
  fun `versionKey is carried by wire data but excluded from provenance equality`() {
    val tracker =
      NavigationBuildKeyTracker("dev-1")
        .updated(update(buildKey = key.copy(versionCode = 0L, versionKey = "1.2.3.4")))
    assertEquals(ProvenanceBuildKey(app, 0L, "hashB"), tracker.activeContext(app).buildKey)
  }
}
