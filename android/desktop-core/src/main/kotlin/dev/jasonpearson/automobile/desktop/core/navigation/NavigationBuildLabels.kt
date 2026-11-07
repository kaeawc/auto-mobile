package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.domain.NavigationGraph

/** Per-build display labels for the build lens (#16954). */
object NavigationBuildLabels {
  /**
   * Labels for every build in [graph], keyed by build key. A build's revision lives on its
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
    return NavigationBuildLens.buildsIn(graph).associateWith {
      NavigationBuildLens.label(it, revisions[it])
    }
  }
}
