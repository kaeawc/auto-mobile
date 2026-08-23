package dev.jasonpearson.automobile.desktop.domain

/**
 * Build-key identity for a navigation provenance observation (nav (app,build) Phase 2, #4985).
 * `packageId` is the application package id (the daemon's `navigation_build_keys.app_id`); the
 * dimension is (packageId, versionCode, contentHash). `versionCode = 0` / `contentHash = ""` is the
 * legacy/default build.
 */
public data class ProvenanceBuildKey(
  val packageId: String,
  val versionCode: Int,
  val contentHash: String,
)

/**
 * A single provenance observation attached to a screen node or transition in the app-union graph
 * (#4985): which build/device/session reached it and when it was last seen there. `deviceId` /
 * `sessionUuid` are `"legacy"` for rows backfilled from pre-provenance graphs; `lastSeen` is epoch
 * ms.
 */
public data class ScreenProvenance(
  val buildKey: ProvenanceBuildKey,
  val deviceId: String,
  val sessionUuid: String,
  val lastSeen: Long,
)

/**
 * The active context a navigation pane resolves provenance against (#4985). A node/edge reached in
 * this context renders at full opacity; one reached only historically / by another build or device
 * fades. `buildKey` is null until the build discriminator is threaded through the navigation stream
 * (deferred #4837); while null, matching is scoped to (deviceId, packageId).
 */
public data class NavigationActiveContext(
  val deviceId: String,
  val packageId: String,
  val buildKey: ProvenanceBuildKey? = null,
)

public data class ScreenNode(
  val id: String,
  val name: String,
  val type: String,
  val packageName: String,
  val transitionCount: Int,
  val discoveredAt: Long,
  val screenshotUri: String? = null,
  val provenance: List<ScreenProvenance> = emptyList(),
  /**
   * Desktop-side liveness token for this node's screenshot (#5088). The daemon keeps a node's
   * screenshot at the same stable [screenshotUri] when it re-captures a newer image, so a URI-keyed
   * thumbnail cache would keep serving the stale bitmap. The Navigation facet bumps this counter
   * for the node whose screenshot was just re-captured (the screen the device navigated to on a
   * same-app graph refresh); the canvas keys its screenshot load on it and invalidates the cache
   * entry when it changes, forcing a re-fetch for exactly that node. Additive: `0` means "no
   * re-capture observed this session" and every non-facet producer leaves it at the default.
   */
  val screenshotVersion: Int = 0,
)

public data class ScreenTransition(
  val id: String,
  val fromScreen: String,
  val toScreen: String,
  val trigger: String,
  val element: String?,
  val avgLatencyMs: Int,
  val failureRate: Float,
  val traversalCount: Int = 1,
  val provenance: List<ScreenProvenance> = emptyList(),
)

public data class NavigationGraph(
  val screens: List<ScreenNode>,
  val transitions: List<ScreenTransition>,
)
