import type {
  NavigationBuildDiffPresence,
  NavigationBuildDiffSummary,
  NavigationBuildFilterSummary,
  NavigationGraphSummary,
  NavigationProvenanceBuildKey,
  NavigationProvenanceRecord,
} from "../../utils/interfaces/NavigationGraph";

export function buildKeysEqual(
  a: NavigationProvenanceBuildKey,
  b: NavigationProvenanceBuildKey,
): boolean {
  return (
    a.packageId === b.packageId &&
    a.versionCode === b.versionCode &&
    a.contentHash === b.contentHash
  );
}

function observedInBuild(
  provenance: NavigationProvenanceRecord[] | undefined,
  buildKey: NavigationProvenanceBuildKey,
): boolean {
  return provenance?.some((record) => buildKeysEqual(record.buildKey, buildKey)) ?? false;
}

export function filterGraphSummaryByBuild(
  summary: NavigationGraphSummary,
  buildKey: NavigationProvenanceBuildKey,
): NavigationBuildFilterSummary {
  return {
    appId: summary.appId,
    buildKey,
    currentScreen: summary.currentScreen,
    nodes: summary.nodes.map((node) => ({
      ...node,
      inFilterBuild: observedInBuild(node.provenance, buildKey),
    })),
    edges: summary.edges.map((edge) => {
      const inFilterBuild = observedInBuild(edge.provenance, buildKey);
      return {
        ...edge,
        inFilterBuild,
        unverifiedForFilterBuild: (edge.provenance?.length ?? 0) > 0 && !inFilterBuild,
      };
    }),
  };
}

function buildPresence(
  provenance: NavigationProvenanceRecord[] | undefined,
  buildA: NavigationProvenanceBuildKey,
  buildB: NavigationProvenanceBuildKey,
): NavigationBuildDiffPresence | null {
  const inA = observedInBuild(provenance, buildA);
  const inB = observedInBuild(provenance, buildB);
  return inA ? (inB ? "both" : "onlyA") : inB ? "onlyB" : null;
}

export function diffGraphSummaryByBuild(
  summary: NavigationGraphSummary,
  buildA: NavigationProvenanceBuildKey,
  buildB: NavigationProvenanceBuildKey,
): NavigationBuildDiffSummary {
  return {
    appId: summary.appId,
    buildA,
    buildB,
    nodes: summary.nodes.flatMap((node) => {
      const presence = buildPresence(node.provenance, buildA, buildB);
      return presence ? [{ ...node, presence }] : [];
    }),
    edges: summary.edges.flatMap((edge) => {
      const presence = buildPresence(edge.provenance, buildA, buildB);
      return presence ? [{ ...edge, presence }] : [];
    }),
  };
}
