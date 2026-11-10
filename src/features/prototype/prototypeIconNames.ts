import contract from "../../../schemas/prototype-spec-contract.json";

export const iconNames: ReadonlySet<string> = new Set(contract.definitions.iconName.values);

/** Bounded substring suggestions cover removed compound names and common extra-letter typos. */
export function prototypeIconNameError(value: unknown): string {
  const query = typeof value === "string" ? value.toLowerCase().slice(0, 128) : "";
  const suggestions = query
    ? [...iconNames]
        .filter((name) => query.includes(name) || name.includes(query))
        .sort(
          (a, b) =>
            Math.abs(a.length - query.length) - Math.abs(b.length - query.length) ||
            a.localeCompare(b),
        )
        .slice(0, 3)
    : [];
  const hint = suggestions.length
    ? ` Did you mean ${suggestions.map((name) => JSON.stringify(name)).join(", ")}?`
    : " Choose an allowed icon name.";
  return `Invalid enum value: Unknown prototype icon name ${JSON.stringify(value)}.${hint} Browse automobile:prototype/icons?query=<substring> for allowed names.`;
}
