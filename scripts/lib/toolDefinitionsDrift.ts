import { isDeepStrictEqual } from "node:util";

export interface ToolDefinitionsDrift {
  added: string[];
  removed: string[];
  changed: string[];
  invalidCommittedDefinitions: boolean;
}

function definitionsByName(definitions: unknown[]): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const definition of definitions) {
    if (typeof definition === "object" && definition !== null && "name" in definition) {
      const name = definition.name;
      if (typeof name === "string") {
        byName.set(name, definition);
      }
    }
  }
  return byName;
}

export function findToolDefinitionsDrift(
  committed: unknown,
  live: unknown[],
): ToolDefinitionsDrift {
  if (!Array.isArray(committed)) {
    return { added: [], removed: [], changed: [], invalidCommittedDefinitions: true };
  }

  const committedByName = definitionsByName(committed);
  const liveByName = definitionsByName(live);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, liveDefinition] of liveByName) {
    const committedDefinition = committedByName.get(name);
    if (!committedByName.has(name)) {
      added.push(name);
    } else if (!isDeepStrictEqual(committedDefinition, liveDefinition)) {
      changed.push(name);
    }
  }

  for (const name of committedByName.keys()) {
    if (!liveByName.has(name)) {
      removed.push(name);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    invalidCommittedDefinitions: false,
  };
}
