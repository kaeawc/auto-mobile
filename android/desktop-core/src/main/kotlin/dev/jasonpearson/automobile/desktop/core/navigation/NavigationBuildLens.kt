package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.domain.NavigationGraph

/**
 * The build lens over the app-union navigation graph (nav (app,build) Phase 4, #4987).
 *
 * The union graph stays a single graph; a lens only changes how it is presented:
 * - [Union]: Phase 2 provenance opacity against the pane's active context (the default).
 * - [Filter]: a selected build's reachable set at full emphasis, other builds faded or hidden.
 * - [Compare]: a two-build diff of the reachable sets, rendered side by side.
 */
sealed interface BuildLens {
  data object Union : BuildLens

  data class Filter(val build: ProvenanceBuildKey, val hideOtherBuilds: Boolean = false) : BuildLens

  data class Compare(val a: ProvenanceBuildKey, val b: ProvenanceBuildKey) : BuildLens
}

/**
 * How a node/edge relates to a selected build.
 * - [InBuild]: at least one classifiable observation was made on that build.
 * - [OtherBuild]: every classifiable observation came from other builds.
 * - [Unclassified]: no classifiable observation (empty provenance, or only legacy-device records),
 *   so it cannot be attributed to any build. Mirrors Phase 2: unclassifiable stays opaque/visible.
 */
enum class BuildMembership {
  InBuild,
  OtherBuild,
  Unclassified,
}

/** Two-build diff classification for one node/edge, in the shape of the hierarchy diff. */
enum class BuildDiffStatus {
  OnlyInA,
  OnlyInB,
  InBoth,
}

data class BuildDiffEntry<T>(val item: T, val status: BuildDiffStatus)

/**
 * Result of diffing two builds' reachable graphs. Entries keep the union graph's order; nodes and
 * edges reached by neither build (or unclassifiable) are omitted.
 */
data class BuildGraphDiff(
  val a: ProvenanceBuildKey,
  val b: ProvenanceBuildKey,
  val screens: List<BuildDiffEntry<ScreenNode>>,
  val transitions: List<BuildDiffEntry<ScreenTransition>>,
) {
  fun screensWith(status: BuildDiffStatus): List<ScreenNode> =
    screens.filter { it.status == status }.map { it.item }

  fun transitionsWith(status: BuildDiffStatus): List<ScreenTransition> =
    transitions.filter { it.status == status }.map { it.item }

  val hasDifferences: Boolean
    get() =
      screens.any { it.status != BuildDiffStatus.InBoth } ||
        transitions.any { it.status != BuildDiffStatus.InBoth }
}

/**
 * Whether a transition is a verified path for the pane's active build.
 * - [Verified]: not flagged — reached in the active context, reached by the active build on another
 *   device, or unclassifiable (Phase 2 keeps those opaque, so they are not flagged either).
 * - [UnverifiedForActiveBuild]: reached only by another build (or by another device whose build
 *   cannot be matched). A hint, not a verified path: navigating along it is speculative.
 * - [BrowseOnly]: no active context (offline); nothing is navigable, so nothing is flagged.
 */
enum class EdgeVerification {
  Verified,
  UnverifiedForActiveBuild,
  BrowseOnly,
}

object NavigationBuildLens {
  const val UNVERIFIED_LABEL: String = "unverified for the active build"

  /** Content hashes are 64 hex chars in production; labels show a short, still-distinct prefix. */
  const val LABEL_HASH_CHARS: Int = 12

  /**
   * Distinct builds observed anywhere in [graph], newest first (by versionCode, then hash). Legacy
   * device records are excluded: they carry no real build identity.
   */
  fun buildsIn(graph: NavigationGraph): List<ProvenanceBuildKey> =
    (graph.screens.flatMap { it.provenance } + graph.transitions.flatMap { it.provenance })
      .asSequence()
      .filter { it.isClassifiable() }
      .map { it.buildKey }
      .distinct()
      .sortedWith(
        compareByDescending<ProvenanceBuildKey> { it.versionCode }
          .thenBy { it.contentHash }
          .thenBy { it.packageId },
      )
      .toList()

  /** Git's default abbreviation length for the sha in a `branch@shortsha` label (#16954). */
  const val LABEL_SHA_CHARS: Int = 7

  /**
   * Short human label for a build: `branch@shortsha` when the build declared its git revision
   * (#16954), otherwise e.g. `v2 (hashB)` with the hash cut to [LABEL_HASH_CHARS].
   */
  fun label(build: ProvenanceBuildKey, revision: BuildSourceRevision? = null): String =
    if (revision != null) {
      "${revision.gitBranch}@${revision.gitSha.take(LABEL_SHA_CHARS)}"
    } else {
      "v${build.versionCode} (${build.contentHash.take(LABEL_HASH_CHARS).ifEmpty { "no hash" }})"
    }

  /**
   * Labels for every build in [graph], keyed by build key (#16954). A build's revision lives on its
   * build-key row, so every record of one build carries the same value; the first one found is
   * used. Revisions never change which builds exist or how they match.
   */
  fun labelsIn(graph: NavigationGraph): Map<ProvenanceBuildKey, String> {
    val records =
      graph.screens.flatMap { it.provenance } + graph.transitions.flatMap { it.provenance }
    val revisions =
      records
        .mapNotNull { record -> record.sourceRevision?.let { record.buildKey to it } }
        .distinctBy { it.first }
        .toMap()
    return buildsIn(graph).associateWith { label(it, revisions[it]) }
  }

  fun membership(provenance: List<ScreenProvenance>, build: ProvenanceBuildKey): BuildMembership {
    val classifiable = provenance.filter { it.isClassifiable() }
    return when {
      classifiable.isEmpty() -> BuildMembership.Unclassified
      classifiable.any { it.buildKey == build } -> BuildMembership.InBuild
      else -> BuildMembership.OtherBuild
    }
  }

  /**
   * Apply a hiding [BuildLens.Filter] to [graph]: nodes reached only by other builds are removed,
   * as are edges reached only by other builds or touching a removed node. Fade filters and other
   * lenses return [graph] unchanged (the canvas fades per element instead).
   */
  fun visibleGraph(graph: NavigationGraph, lens: BuildLens): NavigationGraph {
    if (lens !is BuildLens.Filter || !lens.hideOtherBuilds) return graph
    val screens =
      graph.screens.filter { membership(it.provenance, lens.build) != BuildMembership.OtherBuild }
    val names = screens.mapTo(HashSet()) { it.name }
    val transitions =
      graph.transitions.filter {
        it.fromScreen in names &&
          it.toScreen in names &&
          membership(it.provenance, lens.build) != BuildMembership.OtherBuild
      }
    return NavigationGraph(screens = screens, transitions = transitions)
  }

  /**
   * Opacity for a node/edge under [lens] as of [nowMs]; [BuildLens.Union] defers to Phase 2's
   * opacity. Faded elements are graded by the recency of their other-build records (#16952).
   */
  fun alphaFor(
    provenance: List<ScreenProvenance>,
    context: NavigationActiveContext?,
    lens: BuildLens,
    nowMs: Long,
  ): Float =
    when (lens) {
      is BuildLens.Filter ->
        if (membership(provenance, lens.build) == BuildMembership.OtherBuild) {
          ProvenanceRecency.fadedAlphaFor(provenance.filter { it.isClassifiable() }, nowMs)
        } else {
          ProvenanceOpacity.ACTIVE_ALPHA
        }
      else -> ProvenanceOpacity.alphaFor(provenance, context, nowMs)
    }

  /** Accessible description for a node/edge under [lens]; [buildLabels] come from [labelsIn]. */
  fun contentDescription(
    label: String,
    provenance: List<ScreenProvenance>,
    context: NavigationActiveContext?,
    lens: BuildLens,
    buildLabels: Map<ProvenanceBuildKey, String> = emptyMap(),
  ): String =
    when (lens) {
      is BuildLens.Filter -> {
        val build = buildLabels[lens.build] ?: label(lens.build)
        when (membership(provenance, lens.build)) {
          BuildMembership.InBuild -> "$label — in build $build"
          BuildMembership.OtherBuild ->
            "$label — not in build $build, last seen ${newestLastSeen(provenance)}"
          BuildMembership.Unclassified -> "$label — no build recorded"
        }
      }
      else -> ProvenanceOpacity.contentDescription(label, provenance, context)
    }

  /** Diff the reachable graphs of builds [a] and [b] within the app-union [graph]. */
  fun diff(graph: NavigationGraph, a: ProvenanceBuildKey, b: ProvenanceBuildKey): BuildGraphDiff =
    BuildGraphDiff(
      a = a,
      b = b,
      screens = graph.screens.mapNotNull { diffEntry(it, it.provenance, a, b) },
      transitions = graph.transitions.mapNotNull { diffEntry(it, it.provenance, a, b) },
    )

  /** Whether [transition] is a verified path for the active build of [context]. */
  fun verification(
    transition: ScreenTransition,
    context: NavigationActiveContext?,
  ): EdgeVerification {
    if (context == null) return EdgeVerification.BrowseOnly
    if (!ProvenanceOpacity.isFaded(transition.provenance, context)) return EdgeVerification.Verified
    val activeBuild = context.buildKey
    val reachedByActiveBuild =
      activeBuild != null && transition.provenance.any { it.buildKey == activeBuild }
    return if (reachedByActiveBuild) {
      EdgeVerification.Verified
    } else {
      EdgeVerification.UnverifiedForActiveBuild
    }
  }

  private fun <T> diffEntry(
    item: T,
    provenance: List<ScreenProvenance>,
    a: ProvenanceBuildKey,
    b: ProvenanceBuildKey,
  ): BuildDiffEntry<T>? {
    val inA = membership(provenance, a) == BuildMembership.InBuild
    val inB = membership(provenance, b) == BuildMembership.InBuild
    val status =
      when {
        inA && inB -> BuildDiffStatus.InBoth
        inA -> BuildDiffStatus.OnlyInA
        inB -> BuildDiffStatus.OnlyInB
        else -> return null
      }
    return BuildDiffEntry(item, status)
  }

  private fun newestLastSeen(provenance: List<ScreenProvenance>): Long =
    provenance.filter { it.isClassifiable() }.maxOf { it.lastSeen }

  private fun ScreenProvenance.isClassifiable(): Boolean =
    deviceId != ProvenanceOpacity.LEGACY_DEVICE_SENTINEL
}
