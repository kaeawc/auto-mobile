import contract from "../../../schemas/prototype-spec-contract.json";
import { parsePrototypeHex, type Rgba } from "./prototypeContrast";
import { record } from "./prototypeTemplate";

/**
 * Theme tokens for `automobile:prototype/eject` (#14129): the spec's color roles as a Material 3
 * `ColorScheme` (Compose) or dynamic `Color` constants (SwiftUI). The role names are the
 * contract's `themeModeColors` fields, which are exactly Material 3's `ColorScheme` parameters.
 */

const ROLES = Object.keys(contract.definitions.themeModeColors.fields);

export interface EjectThemeColors {
  readonly mode?: "light" | "dark";
  readonly light: ReadonlyMap<string, string>;
  readonly dark: ReadonlyMap<string, string>;
  /** True when the spec seeds its scheme from a color or the device, which is not exported. */
  readonly seeded: boolean;
}

function roleColors(...sources: unknown[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const source of sources) {
    const values = record(source) ?? {};
    for (const role of ROLES) {
      const value = values[role];
      if (typeof value === "string" && parsePrototypeHex(value)) {
        colors.set(role, value);
      }
    }
  }
  return colors;
}

/** Flat roles apply to both modes; a `light`/`dark` block overrides them for its mode. */
export function ejectThemeColors(theme: unknown): EjectThemeColors {
  const values = record(theme);
  const colors = record(values?.colors);
  const mode = values?.mode === "light" || values?.mode === "dark" ? values.mode : undefined;
  return {
    ...(mode ? { mode } : {}),
    light: roleColors(colors, colors?.light),
    dark: roleColors(colors, colors?.dark),
    seeded: colors?.seed !== undefined || colors?.source !== undefined,
  };
}

/** Contract colors are `#RRGGBB` or alpha-first `#AARRGGBB`, as the renderers read them. */
function rgba(hex: string): Rgba {
  return parsePrototypeHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
}

function hexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0").toUpperCase();
}

function composeColor(hex: string): string {
  const { r, g, b, a } = rgba(hex);
  return `Color(0x${hexByte(a * 255)}${hexByte(r)}${hexByte(g)}${hexByte(b)})`;
}

function schemeLines(name: string, factory: string, colors: ReadonlyMap<string, string>): string[] {
  const args = [...colors].map(([role, hex]) => `    ${role} = ${composeColor(hex)},`);
  return args.length === 0
    ? [`private val ${name} = ${factory}()`]
    : [`private val ${name} = ${factory}(`, ...args, ")"];
}

function composeDarkExpression(mode: EjectThemeColors["mode"]): string {
  if (mode === "dark") {
    return "true";
  }
  return mode === "light" ? "false" : "isSystemInDarkTheme()";
}

/** `<theme>` composable wrapping MaterialTheme, plus the light and dark color schemes. */
export function composeThemeLines(theme: EjectThemeColors, name: string): string[] {
  const head = [
    "@Composable",
    `fun ${name}(content: @Composable () -> Unit) {`,
    `    val dark = ${composeDarkExpression(theme.mode)}`,
    `    MaterialTheme(colorScheme = if (dark) ${name}Dark else ${name}Light, content = content)`,
    "}",
    "",
  ];
  return [
    ...head,
    ...schemeLines(`${name}Light`, "lightColorScheme", theme.light),
    ...schemeLines(`${name}Dark`, "darkColorScheme", theme.dark),
  ];
}

function uiColor(hex: string): string {
  const { r, g, b, a } = rgba(hex);
  const unit = (value: number): string => (value / 255).toFixed(3);
  return `UIColor(red: ${unit(r)}, green: ${unit(g)}, blue: ${unit(b)}, alpha: ${a.toFixed(3)})`;
}

/** Roles present in either mode; a role set for only one mode uses that value in both. */
export function swiftThemeLines(theme: EjectThemeColors, name: string): string[] {
  const roles = ROLES.filter((role) => theme.light.has(role) || theme.dark.has(role));
  const constants = roles.map((role) => {
    const light = theme.light.get(role) ?? theme.dark.get(role) ?? "#000000";
    const dark = theme.dark.get(role) ?? light;
    return `    static let ${role} = Color(UIColor { $0.userInterfaceStyle == .dark ? ${uiColor(dark)} : ${uiColor(light)} })`;
  });
  return [`enum ${name} {`, ...constants, "}"];
}
