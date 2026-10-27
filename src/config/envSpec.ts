export type EnvVarKind = "path" | "string" | "bool" | "int" | "number" | "enum" | "list";

export interface EnvVarSpec {
  /** Canonical variable name. */
  readonly name: string;
  /** Deprecated `AUTO_MOBILE_` spelling, consulted only when `name` is unset. */
  readonly legacyName?: string;
  readonly kind: EnvVarKind;
  /** Human-readable default (documentation only; resolution stays at the call site). */
  readonly default: string;
  readonly doc: string;
  /** `int` / `number`: smallest accepted value (inclusive unless `minExclusive`). */
  readonly min?: number;
  readonly minExclusive?: boolean;
  /** `int`: value used when the variable is unset or unusable. */
  readonly fallback?: number;
  /** `enum`: accepted lowercase values. */
  readonly values?: readonly string[];
  /** Test, acceptance or manager-injected hook: registered but deliberately not in the public docs. */
  readonly internal?: boolean;
}
