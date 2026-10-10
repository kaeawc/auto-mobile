import Foundation

/// Arbitrary JSON, used for state values and emit payloads.
enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    var displayString: String {
        switch self {
        case let .string(value): return value
        case let .bool(value): return String(value)
        case let .number(value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        default: return ""
        }
    }

    /// Nil, rather than a trap, for a value outside `Int`'s range.
    var intValue: Int? {
        if case let .number(value) = self { return Int(exactly: value.rounded(.towardZero)) }
        return nil
    }

    var numberValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }
}

struct PrototypeSpec: Decodable {
    let id: String
    let window: WindowSpec
    let state: [String: JSONValue]?
    let theme: PrototypeTheme?
    /// `none` keeps every visibility and page change instant; `standard` (the default) animates them
    /// unless the system reduces motion (#10442). See `PrototypeMotion`.
    let motion: String?
    /// The node tree with every `repeat` list template already expanded (see `PrototypeRepeat`).
    let root: PrototypeNode

    private enum CodingKeys: String, CodingKey {
        case id, window, state, theme, motion, root
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        window = try container.decode(WindowSpec.self, forKey: .window)
        state = try container.decodeIfPresent([String: JSONValue].self, forKey: .state)
        theme = try container.decodeIfPresent(PrototypeTheme.self, forKey: .theme)
        motion = try container.decodeIfPresent(String.self, forKey: .motion)
        let raw = try container.decode(JSONValue.self, forKey: .root)
        try PrototypeLimits.guardTree(raw)
        root = try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(PrototypeRepeat.expand(raw)))
    }
}

/// A colour or image-asset slot that can differ by appearance (#11218): one value used in both
/// modes, or a `{light, dark}` pair. A colour slot holds a hex value or a Material role name, an
/// asset slot an opaque asset id; the host validator checks the contents.
enum PrototypeModeValue: Decodable, Equatable, ExpressibleByStringLiteral {
    case single(String)
    case modes(light: String, dark: String)

    private struct Modes: Decodable {
        let light: String
        let dark: String
    }

    init(stringLiteral value: String) {
        self = .single(value)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .single(value)
        } else {
            let modes = try container.decode(Modes.self)
            self = .modes(light: modes.light, dark: modes.dark)
        }
    }

    /// Seam for #11220: the one place a per-mode value becomes the single value the renderer
    /// draws. It returns the `light` side of a pair, which keeps every existing spec drawing as
    /// before: the agent does not advertise `prototype_theme_modes_v1` yet, so the host refuses a
    /// spec that carries a pair. #11220 replaces this with resolution against the resolved mode.
    var rendered: String {
        switch self {
        case let .single(value): value
        case let .modes(light, _): light
        }
    }

    /// Every distinct value the slot names, light first.
    var values: [String] {
        switch self {
        case let .single(value): [value]
        case let .modes(light, dark): light == dark ? [light] : [light, dark]
        }
    }
}

struct WindowSpec: Decodable {
    let placement: Placement
    let opacity: Int?
}

struct Placement: Decodable {
    let type: String
    let scrim: PrototypeModeValue?
    let edge: String?
    let height: Double?
    let gravity: String?
    let offset: Offset?
}

struct Offset: Decodable {
    let x: Double
    let y: Double
}

enum Dimension: Decodable {
    case fill
    case wrap
    case points(Double)

    private struct Fixed: Decodable { let dp: Double }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "fill" ? .fill : .wrap
        } else {
            self = try .points(container.decode(Fixed.self).dp)
        }
    }
}

struct Padding: Decodable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}

struct Border: Decodable {
    let width: Double
    let color: PrototypeModeValue
}

/// `cornerRadius`: dp number, Material 3 shape token, or per-corner dp radii.
enum CornerRadius: Decodable, Equatable {
    case uniform(Double)
    /// A Material 3 shape step, resolved against the theme's `shapes` by `PrototypeShapes`.
    case token(String)
    case corners(topStart: Double, topEnd: Double, bottomEnd: Double, bottomStart: Double)

    private struct Corners: Decodable {
        let topStart: Double?
        let topEnd: Double?
        let bottomEnd: Double?
        let bottomStart: Double?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Double.self) {
            self = .uniform(value)
        } else if let token = try? container.decode(String.self) {
            // Material 3 Shapes steps; an unknown token is square rather than a decode failure.
            self = PrototypeShapes.stepNames.contains(token) ? .token(token) : .uniform(0)
        } else {
            let corners = try container.decode(Corners.self)
            self = .corners(
                topStart: corners.topStart ?? 0,
                topEnd: corners.topEnd ?? 0,
                bottomEnd: corners.bottomEnd ?? 0,
                bottomStart: corners.bottomStart ?? 0
            )
        }
    }
}

/// `fontFamily`: a keyword, or `{asset: id}` naming an uploaded font.
enum FontFamily: Decodable, Equatable {
    case keyword(String)
    case asset(String)

    private struct Asset: Decodable { let asset: String }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = .keyword(keyword)
        } else {
            self = try .asset(container.decode(Asset.self).asset)
        }
    }
}

struct Style: Decodable {
    let width: Dimension?
    let height: Dimension?
    let padding: Padding?
    let background: PrototypeModeValue?
    let cornerRadius: CornerRadius?
    let border: Border?
    let alpha: Double?
    /// Scale (0.5-1) a tappable node shrinks to while pressed.
    let pressScale: Double?
    let alignment: String?
    let arrangement: String?
    let spacing: Double?
    let textSize: Double?
    let fontWeight: Int?
    let color: PrototypeModeValue?
    let textAlign: String?
    let maxLines: Int?
    let fontFamily: FontFamily?
    let elevation: Double?
    let shadowColor: PrototypeModeValue?
    let offset: Offset?
    let lineHeight: Double?
    let letterSpacing: Double?
    let textDecoration: String?
    let fontStyle: String?
    let overflow: String?
    /// A Material 3 type role (`titleLarge`...) supplying size, weight, line height and spacing.
    let textStyle: String?

    /// Android's `mergedOver`: properties set on `prototype` win, unset ones keep this style's value.
    /// A present property replaces the base value as a whole (`padding` and `border` included).
    func merged(with prototype: Style) -> Style {
        Style(
            width: prototype.width ?? width,
            height: prototype.height ?? height,
            padding: prototype.padding ?? padding,
            background: prototype.background ?? background,
            cornerRadius: prototype.cornerRadius ?? cornerRadius,
            border: prototype.border ?? border,
            alpha: prototype.alpha ?? alpha,
            pressScale: prototype.pressScale ?? pressScale,
            alignment: prototype.alignment ?? alignment,
            arrangement: prototype.arrangement ?? arrangement,
            spacing: prototype.spacing ?? spacing,
            textSize: prototype.textSize ?? textSize,
            fontWeight: prototype.fontWeight ?? fontWeight,
            color: prototype.color ?? color,
            textAlign: prototype.textAlign ?? textAlign,
            maxLines: prototype.maxLines ?? maxLines,
            fontFamily: prototype.fontFamily ?? fontFamily,
            elevation: prototype.elevation ?? elevation,
            shadowColor: prototype.shadowColor ?? shadowColor,
            offset: prototype.offset ?? offset,
            lineHeight: prototype.lineHeight ?? lineHeight,
            letterSpacing: prototype.letterSpacing ?? letterSpacing,
            textDecoration: prototype.textDecoration ?? textDecoration,
            fontStyle: prototype.fontStyle ?? fontStyle,
            overflow: prototype.overflow ?? overflow,
            textStyle: prototype.textStyle ?? textStyle
        )
    }

    /// The scale a tappable node draws at: `pressScale` while pressed, 1 otherwise.
    func scale(pressed: Bool) -> Double {
        pressed ? pressScale ?? 1 : 1
    }
}

/// One `styleWhen` entry: `style` is merged over the node's own style while `when` holds.
struct StyleWhen: Decodable {
    let when: Condition
    let style: Style
}

struct PrototypeAction: Decodable {
    let type: String
    let name: String?
    let payload: JSONValue?
    let pager: String?
    let page: JSONValue?
    let key: String?
    let value: JSONValue?
    /// `increment`/`decrement` step; 1 when omitted.
    let by: Double?
}

/// The shared validator's condition vocabulary (`visibleWhen`, `openWhen`): exactly one form per
/// object, recursive through `all`/`any`/`not`. Mirrors Android's `PrototypeCondition.holds`.
indirect enum Condition: Decodable, Equatable {
    case equals(key: String, value: JSONValue)
    case notEquals(key: String, value: JSONValue)
    case greaterThan(key: String, value: Double)
    case lessThan(key: String, value: Double)
    case all([Condition])
    case any([Condition])
    case not(Condition)

    private enum CodingKeys: String, CodingKey {
        case key, equals, notEquals, gt, lt, all, any, not
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let all = try container.decodeIfPresent([Condition].self, forKey: .all) {
            self = .all(all)
        } else if let any = try container.decodeIfPresent([Condition].self, forKey: .any) {
            self = .any(any)
        } else if let not = try container.decodeIfPresent(Condition.self, forKey: .not) {
            self = .not(not)
        } else {
            let key = try container.decode(String.self, forKey: .key)
            if let value = try container.decodeIfPresent(JSONValue.self, forKey: .equals) {
                self = .equals(key: key, value: value)
            } else if let value = try container.decodeIfPresent(JSONValue.self, forKey: .notEquals) {
                self = .notEquals(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Double.self, forKey: .gt) {
                self = .greaterThan(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Double.self, forKey: .lt) {
                self = .lessThan(key: key, value: value)
            } else {
                throw DecodingError.dataCorruptedError(
                    forKey: .key,
                    in: container,
                    debugDescription: "Condition needs one of equals, notEquals, gt or lt"
                )
            }
        }
    }

    /// A missing key fails `equals`, `gt` and `lt` and satisfies `notEquals`; a non-numeric value
    /// fails the numeric comparisons instead of throwing.
    func holds(_ state: [String: JSONValue]) -> Bool {
        switch self {
        case let .equals(key, value): state[key] == value
        case let .notEquals(key, value): state[key] != value
        case let .greaterThan(key, value): state[key]?.numberValue.map { $0 > value } ?? false
        case let .lessThan(key, value): state[key]?.numberValue.map { $0 < value } ?? false
        case let .all(conditions): conditions.allSatisfy { $0.holds(state) }
        case let .any(conditions): conditions.contains { $0.holds(state) }
        case let .not(condition): !condition.holds(state)
        }
    }
}

/// A `bottomSheet` height stop: half or all of the sheet's container, or a fixed size in points.
enum Detent: Decodable, Equatable {
    case half
    case full
    case points(Double)

    private struct Fixed: Decodable { let dp: Double }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "full" ? .full : .half
        } else {
            self = try .points(container.decode(Fixed.self).dp)
        }
    }

    /// Android's `prototypeSheetHeights`: a fixed detent never exceeds its container.
    func height(in container: Double) -> Double {
        switch self {
        case .half: container / 2
        case .full: container
        case let .points(value): min(value, container)
        }
    }
}

struct SafeAreaPadding: Decodable {
    let edges: [String]
    let types: [String]
}

struct NavItem: Decodable {
    let label: String
    let icon: String?
    /// An uploaded image asset id, or a `{light, dark}` pair of ids (#11218).
    let image: PrototypeModeValue?
}

/// One `radioGroup` or `segmentedButton` choice.
struct PrototypeOption: Decodable, Equatable {
    let value: String
    let label: String
}

/// A `topAppBar` navigation icon or action: an icon-only button with its accessible label.
struct PrototypeAppBarAction: Decodable {
    let icon: String
    let label: String
    let onTap: [PrototypeAction]?
}

/// A `dialog` or `snackbar` button: a tap closes its container, then runs `onTap`.
struct PrototypeDialogButton: Decodable {
    let label: String
    let onTap: [PrototypeAction]?
}

/// The control at the end of a `listItem`: a bound `switch` or `checkbox`, or a decorative `icon`.
struct PrototypeListItemTrailing: Decodable {
    let type: String
    let stateKey: String?
    let name: String?
}

/// One spec node. A class so `child` can recurse; the renderer reads only the fields its type uses.
final class PrototypeNode: Decodable {
    let type: String
    let id: String?
    let testTag: String?
    let onTap: [PrototypeAction]?
    let style: Style?
    let styleWhen: [StyleWhen]?
    let visibleWhen: Condition?
    /// The `visibleWhen` enter/exit: `none`, `fade`, `expand` or `slide`; absent is fade + expand.
    let transition: String?
    let safeAreaPadding: SafeAreaPadding?
    /// Screen placement resolved by the host (#9316); see `PrototypeAnchor`.
    let anchor: PrototypeAnchor?
    let children: [PrototypeNode]?
    let child: PrototypeNode?
    let text: String?
    /// Authored accessible label (#10446); wins over the label derived from text or icon.
    let contentDescription: String?
    /// An uploaded image asset id, or a `{light, dark}` pair of ids (#11218).
    let asset: PrototypeModeValue?
    let contentScale: String?
    let name: String?
    /// `button`/`chip`/extended `fab` text, and the optional `switch`/`checkbox`/`slider` label.
    let label: String?
    /// Per-type style: `button` filled (default), tonal, elevated, outlined or text; `chip` assist,
    /// filter, input or suggestion; `card` filled, elevated or outlined; `iconButton` standard,
    /// filled, tonal or outlined; `topAppBar` small, centerAligned, medium or large; `progress`
    /// linear or circular.
    let variant: String?
    let stateKey: String?
    let placeholder: String?
    let axis: String?
    let items: [NavItem]?
    let pager: String?
    let scrollable: Bool?
    let openWhen: Condition?
    let detents: [Detent]?
    let scrim: PrototypeModeValue?
    let dragHandle: Bool?
    /// `radioGroup` and `segmentedButton` choices.
    let options: [PrototypeOption]?
    /// Built-in icon name of a `button`, `iconButton`, `fab` or `dialog`.
    let icon: String?
    /// `fab` size: small, regular (default) or large.
    let size: String?
    /// `divider` orientation: horizontal (default) or vertical.
    let orientation: String?
    /// `slider` range and `progress` maximum. Inside this class use `Swift.min`/`Swift.max`.
    let min: Double?
    let max: Double?
    let step: Double?
    /// `topAppBar` and `dialog` title.
    let title: String?
    let navigationIcon: PrototypeAppBarAction?
    let actions: [PrototypeAppBarAction]?
    /// `dialog` buttons and the `snackbar` action.
    let confirm: PrototypeDialogButton?
    let dismiss: PrototypeDialogButton?
    let action: PrototypeDialogButton?
    /// `snackbar` only: closes itself this many milliseconds after opening (1 to 600000); absent
    /// stays until closed.
    let durationMs: Int?
    /// `timePicker` integer keys and clock style; nil `is24Hour` follows the device setting.
    let hourKey: String?
    let minuteKey: String?
    let is24Hour: Bool?
    /// `listItem` content.
    let headline: String?
    let supporting: String?
    let leadingIcon: String?
    let trailing: PrototypeListItemTrailing?

    /// Android's `resolvePrototypeStyle`: every `styleWhen` entry whose condition holds is merged over
    /// `style` in authored order, so a later matching entry wins per property. Nil when the node has
    /// no style at all and no entry matches.
    func resolvedStyle(state: [String: JSONValue]) -> Style? {
        (styleWhen ?? []).filter { $0.when.holds(state) }.reduce(style) { resolved, entry in
            resolved.map { $0.merged(with: entry.style) } ?? entry.style
        }
    }

    /// Pager ids and their page counts, so `setPage` can clamp without consulting the view tree.
    func collectPagers(into counts: inout [String: Int]) {
        if type == "pager", let id {
            counts[id] = children?.count ?? 0
        }
        children?.forEach { $0.collectPagers(into: &counts) }
        child?.collectPagers(into: &counts)
    }

    /// `fontFamily: {asset}` ids on this node's own style and its `styleWhen` entries.
    func fontAssetIds() -> Set<String> {
        let styles = [style].compactMap { $0 } + (styleWhen ?? []).map(\.style)
        return Set(styles.compactMap { style -> String? in
            if case let .asset(id) = style.fontFamily { id } else { nil }
        })
    }

    /// Every font asset id in this subtree.
    func collectFontAssets(into ids: inout Set<String>) {
        ids.formUnion(fontAssetIds())
        children?.forEach { $0.collectFontAssets(into: &ids) }
        child?.collectFontAssets(into: &ids)
    }

    /// Asset ids the spec references, for the `missingAssets` warning.
    func collectAssets(into ids: inout Set<String>) {
        // A {light, dark} pair references both ids, whichever mode is drawn.
        ids.formUnion(asset?.values ?? [])
        ids.formUnion(fontAssetIds())
        items?.compactMap(\.image).forEach { ids.formUnion($0.values) }
        children?.forEach { $0.collectAssets(into: &ids) }
        child?.collectAssets(into: &ids)
    }
}
