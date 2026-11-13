import type { SearchableEntry } from "./SearchableNode";

/** A node's pre-order interval over bounded nodes of one root group (see `ElementProvenance`). */
export interface SiblingLabelPosition {
  group: number;
  enter: number;
  exit: number;
}

/** What the sibling-label rule reads from a toggle or text candidate. */
export interface SiblingLabelCandidate {
  position: SiblingLabelPosition;
  /** Element coordinate space; window-space nodes leave it unset. */
  space?: string;
  /** XR bounds space, when the producer knows it. */
  boundsSpace?: string;
  /** Whether the toggle already carries a label of its own or from an owner row. */
  labelled: boolean;
}

/**
 * The one preceding-sibling label rule shared by the skeleton and searchable projections
 * (#17955, #18227, #18286), so a toggle's skeleton label and its resolver `displayedLabel`
 * agree and duplicate indexes line up.
 *
 * Toggles are walked in tree order. A still-unlabelled toggle takes the outermost text
 * whose subtree ends right before the toggle starts in the same root group and the same
 * coordinate space (`exit === enter - 1`). A toggle with no label and no preceding text is
 * a label-after row (`Row { Switch(); Text("Wi-Fi") }`): the text right after it in the
 * same group and coordinate space, directly or inside `followsInWrapper`, is its trailing
 * label and never labels a later toggle. A labelled toggle, or one with a preceding text,
 * claims nothing. A text in another coordinate space (window vs ornament) is never a
 * candidate in either direction, even when its tree position is adjacent.
 *
 * Returns each labelled-by-sibling toggle mapped to its text; callers apply the label.
 */
export function precedingSiblingLabelSources<T>(
  toggles: readonly T[],
  texts: readonly T[],
  read: (node: T) => SiblingLabelCandidate,
  followsInWrapper?: (toggle: T, text: T) => boolean,
): Map<T, T> {
  const sameSpace = (a: SiblingLabelCandidate, b: SiblingLabelCandidate) =>
    a.space === b.space && a.boundsSpace === b.boundsSpace && a.position.group === b.position.group;
  const trailing = new Set<T>();
  const labels = new Map<T, T>();
  const ordered = [...toggles].sort((a, b) => read(a).position.enter - read(b).position.enter);
  for (const toggle of ordered) {
    const own = read(toggle);
    const preceding = texts
      .filter((text) => {
        const candidate = read(text);
        return (
          !trailing.has(text) &&
          sameSpace(candidate, own) &&
          candidate.position.exit === own.position.enter - 1
        );
      })
      .sort((a, b) => read(a).position.enter - read(b).position.enter)[0];
    if (own.labelled) {
      continue;
    }
    if (preceding) {
      labels.set(toggle, preceding);
      continue;
    }
    for (const text of texts) {
      const candidate = read(text);
      if (
        sameSpace(candidate, own) &&
        (candidate.position.enter === own.position.exit + 1 || followsInWrapper?.(toggle, text))
      ) {
        trailing.add(text);
      }
    }
  }
  return labels;
}

/**
 * Pre-order intervals over bounded entries, the nodes the collector parses, numbered as
 * the collector numbers `ElementProvenance`: bounds-less wrappers are skipped but still
 * end a preceding sibling's subtree.
 */
export function boundedEntryPositions(
  entries: readonly SearchableEntry[],
): Map<SearchableEntry, SiblingLabelPosition> {
  const positions = new Map<SearchableEntry, SiblingLabelPosition>();
  const open: { depth: number; position: SiblingLabelPosition }[] = [];
  let enter = 0;
  for (const entry of entries) {
    while (
      open.length > 0 &&
      (open.at(-1)!.depth >= entry.depth || open.at(-1)!.position.group !== entry.rootGroup)
    ) {
      open.pop();
    }
    if (!entry.element) {
      continue;
    }
    const position = { group: entry.rootGroup, enter, exit: enter };
    for (const ancestor of open) {
      ancestor.position.exit = enter;
    }
    enter++;
    positions.set(entry, position);
    open.push({ depth: entry.depth, position });
  }
  return positions;
}

/**
 * Whether `text` sits inside the non-actionable, toggle-free wrapper that is `toggle`'s
 * next sibling (`Switch, LinearLayout { Text("Wi-Fi") }`). A wrapper holding a toggle is
 * that toggle's row, so its leading text labels that toggle instead. A bare next-sibling
 * text is the interval case in {@link precedingSiblingLabelSources}.
 */
export function followsToggleInPlainWrapper(
  entries: readonly SearchableEntry[],
  toggle: SearchableEntry,
  text: SearchableEntry,
): boolean {
  const wrapper = nextSibling(entries, toggle);
  if (!wrapper || wrapper === text || !isPlainWrapper(entries, wrapper)) {
    return false;
  }
  let cursor: SearchableEntry | undefined = text;
  while (cursor && cursor.index > wrapper.index) {
    cursor = cursor.parentIndex === undefined ? undefined : entries[cursor.parentIndex];
    if (cursor && cursor !== wrapper && cursor.affordances.length > 0) {
      return false;
    }
  }
  return cursor === wrapper;
}

// Entries are pre-order, so the first later entry no deeper than `node` is the node right
// after its subtree; it is a sibling when it shares the parent.
function nextSibling(
  entries: readonly SearchableEntry[],
  node: SearchableEntry,
): SearchableEntry | undefined {
  const next = entries.slice(node.index + 1).find((entry) => entry.depth <= node.depth);
  return next?.parentIndex === node.parentIndex && next?.rootGroup === node.rootGroup
    ? next
    : undefined;
}

function isPlainWrapper(entries: readonly SearchableEntry[], node: SearchableEntry): boolean {
  if (node.affordances.length > 0) {
    return false;
  }
  for (let i = node.index + 1; i < entries.length && entries[i].depth > node.depth; i++) {
    if (entries[i].affordances.includes("toggle")) {
      return false;
    }
  }
  return true;
}
