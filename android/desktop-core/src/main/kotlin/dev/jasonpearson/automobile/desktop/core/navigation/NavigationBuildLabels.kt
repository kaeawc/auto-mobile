package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.domain.NavigationGraph

/** Per-build display labels for the build lens (#16954). */
object NavigationBuildLabels {
  /**
   * Labels for every build in [graph], keyed by build key. A build's revision lives on its
   * build-key row, so every record of one build carries the same value; the first one found is
   * used. Revisions never change which builds exist or how they match. When several builds declare
   * the same revision (for example two variants built from one commit), each colliding label also
   * carries its version/hash label so every chip stays distinguishable.
   */
  fun labelsIn(graph: NavigationGraph): Map<ProvenanceBuildKey, String> {
    val records =
      graph.screens.flatMap { it.provenance } + graph.transitions.flatMap { it.provenance }
    val revisions =
      records
        .mapNotNull { record -> record.sourceRevision?.let { record.buildKey to it } }
        .distinctBy { it.first }
        .toMap()
    val labels =
      NavigationBuildLens.buildsIn(graph).associateWith {
        NavigationBuildLens.label(it, revisions[it])
      }
    val collisions = labels.values.groupingBy { it }.eachCount().filterValues { it > 1 }.keys
    return labels.mapValues { (build, label) ->
      if (label in collisions && revisions[build] != null) {
        "$label · ${NavigationBuildLens.label(build)}"
      } else {
        label
      }
    }
  }
}
