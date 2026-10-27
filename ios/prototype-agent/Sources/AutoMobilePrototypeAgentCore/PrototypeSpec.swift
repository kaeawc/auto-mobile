import Foundation

/// Arbitrary JSON, used for state values and emit payloads.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
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

    public func encode(to encoder: Encoder) throws {
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
        case let .number(value): return PrototypeScalarText.render(value)
        default: return ""
        }
    }

    /// A string, number or boolean: the only state values the contract allows.
    var isScalar: Bool {
        switch self {
        case .string, .bool, .number: true
        case .null, .array, .object: false
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

    var objectFields: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }
}

struct PrototypeSpec: Decodable {
    let id: String
    let window: WindowSpec
    let state: [String: JSONValue]?
    let data: [String: JSONValue]?
    let derive: [String: PrototypeDerivedEntry]?
    let theme: PrototypeTheme?
    /// `none` keeps every visibility and page change instant; `standard` (the default) animates them
    /// with spatial effects reduced by the spec or system setting (#10442). See `PrototypeMotion`.
    let motion: String?
    /// The keys the device keeps across shows of this id (#12522); nil without a usable block.
    let storage: PrototypeStorageBlock?
    /// The node tree with every `repeat` list template already expanded (see `PrototypeRepeat`).
    let root: PrototypeNode
    let strings: JSONValue?
    private(set) var locales: [String] = []
    /// The authored `root` before data resolution and repeat expansion, kept so a device data write
    /// (#12519) can rebuild `root` from the changed data without the host re-sending the spec.
    let authoredRoot: JSONValue
    let platformHandlers: [String: JSONValue]
    private(set) var platformState: [String: JSONValue] = [:]

    private enum CodingKeys: String, CodingKey {
        case id, window, state, data, theme, motion, root, storage, requires, platform, strings, derive
    }

    // Keep the root prefix in coding paths when decoding the resolved/expanded tree.
    private struct DecodedRoot: Decodable {
        let root: PrototypeNode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Match the host/Kotlin top-level UTF-16 key order: data, id, motion, root,
        // state, theme, window. Each size walk stays at its member's turn.
        // Within root/window, sizes still precede structural decoding, whose nested
        // field order is not sorted; mixed nested errors can therefore differ from
        // the host/Kotlin's single traversal. Root decoding also uses the resolved,
        // expanded tree, so its structural paths refer to that tree.
        if container.contains(.data) {
            data = try container.decode([String: JSONValue].self, forKey: .data)
        } else {
            data = nil
        }
        try PrototypeLazyList.validateLimits(root: container.decode(JSONValue.self, forKey: .root), data: data)
        if let data { try PrototypeLimits.guardData(data) }
        derive = try container.decodeIfPresent([String: PrototypeDerivedEntry].self, forKey: .derive)
        id = try container.decode(String.self, forKey: .id)
        motion = try container.decodeIfPresent(String.self, forKey: .motion)
        // The host validator owns the strict shape; a malformed block means "no storage" here.
        storage = (try? container.decodeIfPresent(PrototypeStorageBlock.self, forKey: .storage))
        let raw = try container.decode(JSONValue.self, forKey: .root)
        authoredRoot = raw
        platformHandlers = try container.decodeIfPresent(JSONValue.self, forKey: .platform)?.objectFields?["on"]?
            .objectFields ?? [:]
        strings = container.contains(.strings) ? try container.decode(JSONValue.self, forKey: .strings) : nil
        if let strings { try PrototypeStrings.validateTables(strings) }
        // Menus validate against state, but state is decoded (and checked) after root to keep the
        // key order; a state that does not decode is reported at its own turn below.
        let menuState = (try? container.decodeIfPresent([String: JSONValue].self, forKey: .state))
        // Validate platform vocabulary before resolving device-owned reads.
        try PrototypePlatformValidator.validate(
            requires: container.decodeIfPresent(JSONValue.self, forKey: .requires),
            handlers: container.decodeIfPresent(JSONValue.self, forKey: .platform),
            root: raw,
            state: menuState ?? [:]
        )
        root = try Self.buildRoot(
            raw, data: data, menuState: menuState ?? [:], strings: strings, locales: locales, derive: derive
        )
        state = try container.decodeIfPresent([String: JSONValue].self, forKey: .state)
        // Android's `PrototypeScalarSerializer` and the host schema accept only string, number and
        // boolean state values, so a null, array or object fails the show everywhere.
        if let offending = state?.first(where: { !$0.value.isScalar })?.key {
            throw DecodingError.dataCorruptedError(
                forKey: .state,
                in: container,
                debugDescription: "State value for \"\(offending)\" must be a string, number or boolean"
            )
        }
        theme = try container.decodeIfPresent(PrototypeTheme.self, forKey: .theme)
        try PrototypeSizeBounds.validate(.object(["window": container.decode(JSONValue.self, forKey: .window)]))
        window = try container.decode(WindowSpec.self, forKey: .window)
        // There is no Swift twin of the host validator, so the forms `prototype_theme_modes_v1`
        // added are checked here: a malformed one fails the show instead of drawing a fallback.
        try PrototypeStacks.validate(root: root)
        try PrototypeThemeModes.validate(placement: window.placement, root: root)
    }

    /// Everything between the authored root and the drawn one, in the order the host reports
    /// errors. It depends on `data` and the initial state only, so a data write reruns it.
    private static func buildRoot(
        _ raw: JSONValue, data: [String: JSONValue]?, menuState: [String: JSONValue],
        strings: JSONValue?, locales: [String], platform: [String: JSONValue] = [:],
        derive: [String: PrototypeDerivedEntry]? = nil
    )
        throws -> PrototypeNode
    {
        try PrototypeStrings.validate(
            spec: ["root": raw].merging(strings.map { ["strings": $0] } ?? [:]) { $1 },
            nodes: stringNodes(raw)
        )
        try PrototypeLazyList.validate(root: raw, data: data, state: menuState)
        let rawDerive = try derive.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) }
        try PrototypeDerivedValidator.validate(derive: rawDerive, root: raw, data: data)
        try PrototypePagerOptions.validateStateKeys(raw, state: menuState)
        try PrototypeCustomShaders.refuse(["root": raw])
        try PrototypeSizeBounds.validate(.object(["root": raw]))
        try PrototypeLimits.guardAuthoredTree(raw)
        try PrototypeScrollMotion.validate(raw, data: data)
        try PrototypeRequestValidator.validate(raw, state: menuState)
        try PrototypeLimits.guardRepeatPathCells(raw, data: data)
        try PrototypeMenus.validateAuthoredText(raw)
        try PrototypeLoadingStates.validate(raw)
        try PrototypeRepeat.validateEmitContexts(raw, data: data)
        let formatContext = PrototypeDerivedContext(entries: derive ?? [:], data: data)
        try PrototypeLimits.guardSubstitutedText(raw, data: data, derived: formatContext, state: menuState)
        let bound = PrototypeDataResolver.resolveRoot(raw, data: data, platform: platform)
        let resolved = strings
            .map { PrototypeStrings.resolve(bound, strings: $0, locales: locales, data: data) } ?? bound
        try PrototypeLimits.guardTree(resolved)
        try PrototypeRepeat.validateDerivedRows(
            resolved, formatter: formatContext.formatter, environment: formatContext.environment
        )
        let expanded = PrototypeRepeat.expand(
            resolved,
            formatter: formatContext.formatter,
            environment: formatContext.environment
        )
        try PrototypeBarScroll.validate(expanded)
        try PrototypePagerOptions.validate(expanded)
        try PrototypeSwipe.validate(expanded)
        try PrototypeCarousel.validate(expanded)
        try PrototypeRefresh.validate(expanded)
        try PrototypeMenus.validate(expanded, state: menuState)
        try PrototypeTooltips.validate(expanded)
        let root = try JSONDecoder().decode(
            DecodedRoot.self,
            from: JSONEncoder().encode(JSONValue.object(["root": expanded]))
        ).root
        root.bindValidity(PrototypeChecks.bindings(root: root))
        return root
    }

    private init(
        replacing spec: PrototypeSpec, data: [String: JSONValue]?, root: PrototypeNode,
        authoredRoot: JSONValue? = nil, state: [String: JSONValue]? = nil
    ) {
        platformHandlers = spec.platformHandlers
        platformState = spec.platformState
        id = spec.id
        strings = spec.strings
        locales = spec.locales
        window = spec.window
        self.state = state ?? spec.state
        self.data = data
        derive = spec.derive
        theme = spec.theme
        motion = spec.motion
        storage = spec.storage
        self.root = root
        self.authoredRoot = authoredRoot ?? spec.authoredRoot
    }

    func replacingPlatform(_ platform: [String: JSONValue]) throws -> PrototypeSpec {
        guard try JSONEncoder().encode(platform).count <= PrototypeContractValidator
            .limit("MAX_PROTOTYPE_PLATFORM_STATE_BYTES")
        else {
            throw PrototypeLimits.violation("platform", "Platform state exceeds limit")
        }
        let rebuilt = try Self.buildRoot(
            authoredRoot, data: data, menuState: state ?? [:], strings: strings, locales: locales,
            platform: platform, derive: derive
        )
        var next = PrototypeSpec(replacing: self, data: data, root: rebuilt)
        next.platformState = platform
        return next
    }

    /// This spec after a host patch (#11675): the authored root, data and state replaced, and the drawn
    /// tree rebuilt and re-validated the way a show would. Id, window and theme are carried over, as
    /// the patch grammar cannot address them. Throws what a show of the same content would.
    func patched(
        authoredRoot raw: JSONValue, data: [String: JSONValue]?, state: [String: JSONValue]?
    )
        throws -> PrototypeSpec
    {
        try PrototypeLazyList.validateLimits(root: raw, data: data)
        if let data { try PrototypeLimits.guardData(data) }
        let rebuilt = try Self.buildRoot(
            raw, data: data, menuState: state ?? [:], strings: strings, locales: locales,
            platform: platformState, derive: derive
        )
        try PrototypeStacks.validate(root: rebuilt)
        try PrototypeThemeModes.validate(placement: window.placement, root: rebuilt)
        return PrototypeSpec(replacing: self, data: data, root: rebuilt, authoredRoot: raw, state: state)
    }

    private static func stringNodes(_ raw: JSONValue, path: String = "root") -> [PrototypeLocatedValue] {
        guard let fields = raw.objectFields else { return [] }
        return [.init(value: fields, path: path)] + PrototypeStrictRepeats.children(fields, path: path).flatMap {
            stringNodes(.object($0.value), path: $0.path)
        }
    }

    func replacingLocale(_ locales: [String]) throws -> PrototypeSpec {
        let root = try Self.buildRoot(
            authoredRoot,
            data: data,
            menuState: state ?? [:],
            strings: strings,
            locales: locales,
            platform: platformState,
            derive: derive
        )
        var result = PrototypeSpec(replacing: self, data: data, root: root)
        result.locales = locales
        return result
    }

    /// This spec with `data` replaced and the drawn tree rebuilt from the authored one, so text
    /// bindings, `repeat` rows and data conditions follow the write. Throws when the changed data
    /// breaks a limit the show enforces (for example more repeat cells than the tree allows).
    func replacingData(_ data: [String: JSONValue]) throws -> PrototypeSpec {
        let rebuilt = try Self.buildRoot(
            authoredRoot,
            data: data,
            menuState: state ?? [:],
            strings: strings,
            locales: locales,
            platform: platformState,
            derive: derive
        )
        try PrototypeStacks.validate(root: rebuilt)
        try PrototypeThemeModes.validate(placement: window.placement, root: rebuilt)
        return PrototypeSpec(replacing: self, data: data, root: rebuilt)
    }
}

/// A colour or image-asset slot that can differ by appearance (#11218): one value used in both
/// modes, or a `{light, dark}` pair. A colour slot holds a hex value or a Material role name, an
/// asset slot an opaque asset id; `PrototypeThemeModes.validate` checks the contents.
enum PrototypeModeValue: Decodable, Equatable, Sendable, ExpressibleByStringLiteral {
    case single(String)
    case modes(light: String, dark: String)
    /// `{data: "/pointer"}` on an image slot (#14192): the id of a device media item held in `/data`.
    /// The shared contract accepts it only there, and it names no uploaded asset.
    case data(String)

    init(stringLiteral value: String) {
        self = .single(value)
    }

    /// A string, or an object holding exactly `light` and `dark` strings: a missing mode, an extra
    /// key or a nested pair does not decode.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .single(value)
            return
        }
        let fields = try container.decode([String: String].self)
        if fields.count == 1, let pointer = fields["data"] {
            self = .data(pointer)
            return
        }
        guard fields.count == 2, let light = fields["light"], let dark = fields["dark"] else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "A per-mode value needs exactly the keys light and dark"
            )
        }
        self = .modes(light: light, dark: dark)
    }

    /// The value drawn in the resolved mode (#11220): a single value in both, else that mode's side
    /// of the pair. The renderer takes `dark` from `PrototypePalette.dark`.
    func value(dark: Bool) -> String {
        switch self {
        case let .single(value): value
        case let .modes(light, darkValue): dark ? darkValue : light
        // Resolved by the media runtime; until then the slot is empty and draws the placeholder.
        case .data: ""
        }
    }

    /// Every distinct value the slot names, light first.
    var values: [String] {
        switch self {
        case let .single(value): [value]
        case let .modes(light, dark): light == dark ? [light] : [light, dark]
        case .data: []
        }
    }
}

struct WindowSpec: Decodable {
    let placement: Placement
    let opacity: Int?
    let chrome: String?
    let deadTaps: Bool?
    let backdrop: BackdropSpec?

    private enum CodingKeys: String, CodingKey { case placement, opacity, chrome, deadTaps, backdrop }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        placement = try container.decode(Placement.self, forKey: .placement)
        opacity = try container.decodeIfPresent(Int.self, forKey: .opacity)
        deadTaps = try container.decodeIfPresent(Bool.self, forKey: .deadTaps)
        chrome = try container.decodeIfPresent(String.self, forKey: .chrome)
        backdrop = try container.decodeIfPresent(BackdropSpec.self, forKey: .backdrop)
        if let chrome, chrome != "none", chrome != "bar" {
            throw DecodingError.dataCorruptedError(
                forKey: .chrome,
                in: container,
                debugDescription: "window.chrome must be none or bar"
            )
        }
    }
}

enum Dimension: Decodable, Equatable {
    case fill
    case wrap
    case points(Double)

    private struct Fixed: Decodable {
        let points: Double
        private enum CodingKeys: String, CodingKey { case points = "dp" }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "fill" ? .fill : .wrap
        } else {
            self = try .points(container.decode(Fixed.self).points)
        }
    }
}

/// Fixed columns or adaptive equal-width slots. Positivity is enforced by the host;
/// placement clamps direct-client values defensively without duplicating its validator.
enum PrototypeGridColumns: Decodable, Equatable {
    case fixed(Int)
    case adaptive(minWidth: Double)

    private struct Adaptive: Decodable { let minWidth: Double }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let count = try? container.decode(Int.self) {
            self = .fixed(count)
        } else {
            self = try .adaptive(minWidth: container.decode(Adaptive.self).minWidth)
        }
    }
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
enum FontFamily: Decodable, Equatable, Sendable {
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
    /// A `row`/`column` child's share of the main-axis space left after its unweighted siblings
    /// (ignored elsewhere). Positive.
    let weight: Double?
    /// Nonnegative dp bounds that clamp `width`/`height`, `fill` and `{dp}` included.
    let minWidth: Double?
    let maxWidth: Double?
    let minHeight: Double?
    let maxHeight: Double?
    /// Positive width / height, applied after the size bounds.
    let aspectRatio: Double?
    let padding: Padding?
    let background: PrototypeModeValue?
    /// Painted over `background` and under the content, inside the corner shape.
    let gradient: PrototypeGradient?
    let cornerRadius: CornerRadius?
    let border: Border?
    let alpha: Double?
    /// Scale (0.5-1) a tappable node shrinks to while pressed.
    let pressScale: Double?
    let alignment: String?
    let arrangement: String?
    let spacing: Double?
    let runSpacing: Double?
    let textSize: Double?
    let fontWeight: Int?
    let color: PrototypeModeValue?
    let textAlign: String?
    let maxLines: Int?
    let fontFamily: FontFamily?
    let elevation: Double?
    let shadowColor: PrototypeModeValue?
    var shadows: [Shadow]? = nil
    var cornerStyle: String? = nil
    let offset: Offset?
    let lineHeight: Double?
    let letterSpacing: Double?
    let textDecoration: String?
    let fontStyle: String?
    let overflow: String?
    /// A Material 3 type role (`titleLarge`...) supplying size, weight, line height and spacing.
    let textStyle: String?
    /// A box, row, column or card placeholder whose background a highlight sweeps (#14207).
    let shimmer: Bool?
    /// Paint-only looks applied in order (#15128): objects the structural contract has already
    /// validated, kept raw until a renderer draws them. Gated by `prototype_effects_v1`.
    var effects: [JSONValue]?

    /// Android's `mergedOver`: properties set on `prototype` win, unset ones keep this style's value.
    /// A present property replaces the base value as a whole (`padding` and `border` included).
    func merged(with prototype: Style) -> Style {
        Style(
            width: prototype.width ?? width,
            height: prototype.height ?? height,
            weight: prototype.weight ?? weight,
            minWidth: prototype.minWidth ?? minWidth,
            maxWidth: prototype.maxWidth ?? maxWidth,
            minHeight: prototype.minHeight ?? minHeight,
            maxHeight: prototype.maxHeight ?? maxHeight,
            aspectRatio: prototype.aspectRatio ?? aspectRatio,
            padding: prototype.padding ?? padding,
            background: prototype.background ?? background,
            gradient: prototype.gradient ?? gradient,
            cornerRadius: prototype.cornerRadius ?? cornerRadius,
            border: prototype.border ?? border,
            alpha: prototype.alpha ?? alpha,
            pressScale: prototype.pressScale ?? pressScale,
            alignment: prototype.alignment ?? alignment,
            arrangement: prototype.arrangement ?? arrangement,
            spacing: prototype.spacing ?? spacing,
            runSpacing: prototype.runSpacing ?? runSpacing,
            textSize: prototype.textSize ?? textSize,
            fontWeight: prototype.fontWeight ?? fontWeight,
            color: prototype.color ?? color,
            textAlign: prototype.textAlign ?? textAlign,
            maxLines: prototype.maxLines ?? maxLines,
            fontFamily: prototype.fontFamily ?? fontFamily,
            elevation: prototype.elevation ?? elevation,
            shadowColor: prototype.shadowColor ?? shadowColor,
            shadows: prototype.shadows ?? shadows,
            cornerStyle: prototype.cornerStyle ?? cornerStyle,
            offset: prototype.offset ?? offset,
            lineHeight: prototype.lineHeight ?? lineHeight,
            letterSpacing: prototype.letterSpacing ?? letterSpacing,
            textDecoration: prototype.textDecoration ?? textDecoration,
            fontStyle: prototype.fontStyle ?? fontStyle,
            overflow: prototype.overflow ?? overflow,
            textStyle: prototype.textStyle ?? textStyle,
            shimmer: prototype.shimmer ?? shimmer,
            effects: prototype.effects ?? effects
        )
    }

    /// Whether the author painted the node, so a component's default container must not cover it
    /// (Android's `authoredFill`).
    var hasAuthoredFill: Bool {
        background != nil || gradient != nil
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

struct PrototypeRouteEntry: Decodable, Sendable {
    let screen: String
    let params: [String: JSONValue]?
}

struct PrototypeRoute: Decodable, Sendable {
    let params: [String: String]?
    let onEnter: [PrototypeAction]?
    let onBack: [PrototypeAction]?
}

struct PrototypeAction: Decodable, Sendable {
    let type: String
    let name: String?
    let payload: JSONValue?
    let context: PrototypeEmitContext?
    let scroll: String?
    let to: JSONValue?
    let animated: Bool?
    let pager: String?
    let page: JSONValue?
    let stack: String?
    let screen: String?
    let params: [String: JSONValue]?
    let force: Bool?
    /// Contract-only setStack path; data actions retain their existing string path.
    let stackPath: [PrototypeRouteEntry]?
    let transition: PrototypeStackTransition?
    /// `setData`/`appendData`/`prependData`/`removeData`: `/data/<pointer>`, a whole `{index}` segment bound per
    /// repeat row at expansion (#12519).
    let path: String?
    let key: String?
    /// `setState`'s literal; for `setData`/`appendData`/`prependData` the binding object (`{value}`, `{state}`,
    /// `{data}`), with `item`/`index` already bound to `{value}` by repeat expansion.
    let value: JSONValue?
    /// `increment`/`decrement` step; 1 when omitted.
    let incrementAmount: Double?
    let requireValid: [String]?
    // `request` (#12529): method defaults to GET and `via` to host. `headers` and `query` entries
    // are a literal string or a binding object; `body` is a binding; `url`, `statusKey` and `into`
    // are bound per repeat row at expansion like the data actions' paths.
    let call: String?
    let args: [String: JSONValue]?
    let method: String?
    let url: String?
    let headers: [String: JSONValue]?
    let query: [String: JSONValue]?
    let body: JSONValue?
    let into: String?
    let append: PrototypeRequestAppend?
    let statusKey: String?
    let via: String?
    let timeoutMs: Double?
    let id: String?
    let afterMs: Int?
    let everyMs: Int?
    let maxRuns: Int?
    let actions: [PrototypeAction]?
    let onSuccess: [PrototypeAction]?
    let onError: [PrototypeAction]?

    private enum CodingKeys: String, CodingKey {
        case type, name, payload, context, pager, page, stack, screen, transition, path, key, value, scroll, to,
             animated, call, args, params, force
        case id, afterMs, everyMs, maxRuns, actions
        case incrementAmount = "by"
        case requireValid, method, url, headers, query, body, into, append, statusKey, via, timeoutMs, onSuccess,
             onError
    }

    init(
        type: String, name: String?, payload: JSONValue?, context: PrototypeEmitContext?, pager: String?,
        page: JSONValue?, stack: String?, screen: String?, path: String?, key: String?, value: JSONValue?,
        by incrementAmount: Double?, requireValid: [String]?, method: String? = nil, url: String? = nil,
        headers: [String: JSONValue]? = nil, query: [String: JSONValue]? = nil, body: JSONValue? = nil,
        into: String? = nil, append: PrototypeRequestAppend? = nil, statusKey: String? = nil, via: String? = nil,
        timeoutMs: Double? = nil,
        onSuccess: [PrototypeAction]? = nil, onError: [PrototypeAction]? = nil,
        id: String? = nil, afterMs: Int? = nil, everyMs: Int? = nil, maxRuns: Int? = nil,
        actions: [PrototypeAction]? = nil, transition: PrototypeStackTransition? = nil,
        scroll: String? = nil, to: JSONValue? = nil, animated: Bool? = nil,
        call: String? = nil, args: [String: JSONValue]? = nil,
        params: [String: JSONValue]? = nil, force: Bool? = nil, stackPath: [PrototypeRouteEntry]? = nil
    ) {
        self.scroll = scroll
        self.to = to
        self.animated = animated
        self.call = call
        self.args = args
        self.id = id
        self.afterMs = afterMs
        self.everyMs = everyMs
        self.maxRuns = maxRuns
        self.actions = actions
        self.type = type
        self.name = name
        self.payload = payload
        self.context = context
        self.pager = pager
        self.page = page
        self.stack = stack
        self.screen = screen
        self.params = params
        self.force = force
        self.stackPath = stackPath
        self.transition = transition
        self.path = path
        self.key = key
        self.value = value
        self.incrementAmount = incrementAmount
        self.requireValid = requireValid
        self.method = method
        self.url = url
        self.headers = headers
        self.query = query
        self.body = body
        self.into = into
        self.append = append
        self.statusKey = statusKey
        self.via = via
        self.timeoutMs = timeoutMs
        self.onSuccess = onSuccess
        self.onError = onError
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        try self.init(
            type: type,
            name: container.decodeIfPresent(String.self, forKey: .name),
            payload: container.decodeIfPresent(JSONValue.self, forKey: .payload),
            context: container.decodeIfPresent(PrototypeEmitContext.self, forKey: .context),
            pager: container.decodeIfPresent(String.self, forKey: .pager),
            page: container.decodeIfPresent(JSONValue.self, forKey: .page),
            stack: container.decodeIfPresent(String.self, forKey: .stack),
            screen: container.decodeIfPresent(String.self, forKey: .screen),
            path: type == "setStack" ? nil : container.decodeIfPresent(String.self, forKey: .path),
            key: container.decodeIfPresent(String.self, forKey: .key),
            value: container.decodeIfPresent(JSONValue.self, forKey: .value),
            by: container.decodeIfPresent(Double.self, forKey: .incrementAmount),
            requireValid: container.decodeIfPresent([String].self, forKey: .requireValid),
            method: container.decodeIfPresent(String.self, forKey: .method),
            url: container.decodeIfPresent(String.self, forKey: .url),
            headers: container.decodeIfPresent([String: JSONValue].self, forKey: .headers),
            query: container.decodeIfPresent([String: JSONValue].self, forKey: .query),
            body: container.decodeIfPresent(JSONValue.self, forKey: .body),
            into: container.decodeIfPresent(String.self, forKey: .into),
            append: container.decodeIfPresent(PrototypeRequestAppend.self, forKey: .append),
            statusKey: container.decodeIfPresent(String.self, forKey: .statusKey),
            via: container.decodeIfPresent(String.self, forKey: .via),
            timeoutMs: container.decodeIfPresent(Double.self, forKey: .timeoutMs),
            onSuccess: container.decodeIfPresent([PrototypeAction].self, forKey: .onSuccess),
            onError: container.decodeIfPresent([PrototypeAction].self, forKey: .onError),
            id: container.decodeIfPresent(String.self, forKey: .id),
            afterMs: container.decodeIfPresent(Int.self, forKey: .afterMs),
            everyMs: container.decodeIfPresent(Int.self, forKey: .everyMs),
            maxRuns: container.decodeIfPresent(Int.self, forKey: .maxRuns),
            actions: container.decodeIfPresent([PrototypeAction].self, forKey: .actions),
            transition: container.decodeIfPresent(PrototypeStackTransition.self, forKey: .transition),
            scroll: container.decodeIfPresent(String.self, forKey: .scroll),
            to: container.decodeIfPresent(JSONValue.self, forKey: .to),
            animated: container.decodeIfPresent(Bool.self, forKey: .animated),
            call: container.decodeIfPresent(String.self, forKey: .call),
            args: container.decodeIfPresent([String: JSONValue].self, forKey: .args),
            params: container.decodeIfPresent([String: JSONValue].self, forKey: .params),
            force: container.decodeIfPresent(Bool.self, forKey: .force),
            stackPath: type == "setStack" ? container.decode([PrototypeRouteEntry].self, forKey: .path) : nil
        )
    }

    /// This action and every action nested in its `onSuccess` / `onError` lists, depth first.
    var flattened: [PrototypeAction] {
        [self] + ((onSuccess ?? []) + (onError ?? []) + (actions ?? [])).flatMap(\.flattened)
    }
}

/// The shared validator's condition vocabulary (`visibleWhen`, `openWhen`): exactly one form per
/// object, recursive through `all`/`any`/`not`. Mirrors Android's `PrototypeCondition.holds`.
indirect enum Condition: Decodable, Equatable {
    case equals(key: String, value: JSONValue)
    case notEquals(key: String, value: JSONValue)
    case contains(key: String, value: JSONValue)
    case startsWith(key: String, value: JSONValue)
    case lengthGt(key: String, value: Int)
    case lengthLt(key: String, value: Int)
    case greaterThan(key: String, value: Double)
    case lessThan(key: String, value: Double)
    case all([Condition])
    case any([Condition])
    case not(Condition)
    case valid([String], PrototypeValidityContext)

    private enum CodingKeys: String, CodingKey {
        case key, equals, notEquals, contains, startsWith, lengthGt, lengthLt, all, any, not, valid
        case greaterThan = "gt"
        case lessThan = "lt"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.valid) {
            let keys: [String]
            if let key = try? container.decode(String.self, forKey: .valid) {
                keys = [key]
            } else {
                keys = try container.decode([String].self, forKey: .valid)
            }
            self = .valid(keys, PrototypeValidityContext())
        } else if let all = try container.decodeIfPresent([Condition].self, forKey: .all) {
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
            } else if let value = try container.decodeIfPresent(JSONValue.self, forKey: .contains) {
                self = .contains(key: key, value: value)
            } else if let value = try container.decodeIfPresent(JSONValue.self, forKey: .startsWith) {
                self = .startsWith(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Int.self, forKey: .lengthGt) {
                self = .lengthGt(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Int.self, forKey: .lengthLt) {
                self = .lengthLt(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Double.self, forKey: .greaterThan) {
                self = .greaterThan(key: key, value: value)
            } else if let value = try container.decodeIfPresent(Double.self, forKey: .lessThan) {
                self = .lessThan(key: key, value: value)
            } else {
                throw DecodingError.dataCorruptedError(
                    forKey: .key,
                    in: container,
                    debugDescription: "Exactly one of equals, notEquals, gt, lt, empty, contains, startsWith, lengthGt, lengthLt is required"
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
        case let .contains(key, value): state[key]?.stringValue.map { text in
                guard let value = value.stringValue else { return false }
                let units = Array(text.utf16)
                let operand = Array(value.utf16)
                return operand
                    .isEmpty || (operand.count <= units.count && (0 ... (units.count - operand.count)).contains {
                        units[$0 ..< ($0 + operand.count)].elementsEqual(operand)
                    })
            } ?? false
        case let .startsWith(key, value): state[key]?.stringValue.map { text in
                value.stringValue.map { Array(text.utf16).starts(with: Array($0.utf16)) } ?? false
            } ?? false
        case let .lengthGt(key, value): state[key]?.stringValue.map { $0.utf16.count > value } ?? false
        case let .lengthLt(key, value): state[key]?.stringValue.map { $0.utf16.count < value } ?? false
        case let .greaterThan(key, value): state[key]?.numberValue.map { $0 > value } ?? false
        case let .lessThan(key, value): state[key]?.numberValue.map { $0 < value } ?? false
        case let .all(conditions): conditions.allSatisfy { $0.holds(state) }
        case let .any(conditions): conditions.contains { $0.holds(state) }
        case let .not(condition): !condition.holds(state)
        case let .valid(keys, context): context.holds(keys, state: state)
        }
    }
}

/// A `bottomSheet` height stop: half or all of the sheet's container, or a fixed size in points.
enum Detent: Decodable, Equatable {
    case half
    case full
    case points(Double)

    private struct Fixed: Decodable {
        let points: Double
        private enum CodingKeys: String, CodingKey { case points = "dp" }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "full" ? .full : .half
        } else {
            self = try .points(container.decode(Fixed.self).points)
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

/// One `radioGroup` or `segmentedButton` choice.
struct PrototypeOption: Decodable, Equatable {
    let value: String
    let label: String
}

/// One spec node. A class so `child` can recurse; the renderer reads only the fields its type uses.
final class PrototypeNode: Decodable {
    /// Structural identity retained across data-driven tree rebuilds.
    let nodePath: String
    let type: String
    let id: String?
    let testTag: String?
    let onAppear: [PrototypeAction]?
    let onTap: [PrototypeAction]?
    let onLongPress: [PrototypeAction]?
    let onDoubleTap: [PrototypeAction]?
    let style: Style?
    let styleWhen: [StyleWhen]?
    let visibleWhen: Condition?
    let shared: Shared?
    var resolvedSharedKey: String? { shared?.key ?? sharedKey }
    let sharedKey: String?
    let enabledWhen: Condition?
    let checks: [PrototypeCheck]?
    let validateOn: PrototypeValidateOn?
    /// Stack navigation, or other nodes' `visibleWhen` enter/exit (`none`, `fade`, `expand`, `slide`).
    /// Absent visibility transitions use fade + expand; stacks always use that visibility default.
    let transition: String?
    let scrollTransition: ScrollTransition?
    let scrollLinked: ScrollLinked?
    let safeAreaPadding: SafeAreaPadding?
    /// Screen placement resolved by the host (#9316); see `PrototypeAnchor`.
    let anchor: PrototypeAnchor?
    let children: [PrototypeNode]?
    /// Flow line cap (clipped overflow children remain in the hierarchy) and textField maximum lines.
    let maxLines: Int?
    let columns: PrototypeGridColumns?
    /// A direct grid child's requested column span, on every node shape.
    let span: Int?
    let child: PrototypeNode?
    let start: String?
    let screens: [String: PrototypeNode]?
    let routes: [String: PrototypeRoute]?
    /// Structured screen definitions distinguish content edits from an unchanged navigation rebuild.
    let screenDefinitions: JSONValue?
    let text: String?
    let spans: [PrototypeTextSpan]?
    /// Mentions, hashtags and URLs in `text` as links (#14233).
    let linkify: PrototypeLinkifyOptions?
    /// Authored accessible label (#10446); wins over the label derived from text or icon.
    let semantics: PrototypeSemantics?
    let contentDescription: String?
    /// An uploaded image asset id, or a `{light, dark}` pair of ids (#11218).
    let asset: PrototypeModeValue?
    let filter: ImageFilter?
    let fadeEdges: FadeEdges?
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
    /// Search results are shown only while this boolean state key is true.
    let activeKey: String?
    let trailingActions: [PrototypeAppBarAction]?
    let onSubmit: [PrototypeAction]?
    let axis: String?
    /// Pager-only layout options; absent fields retain the legacy horizontal pager.
    let pageSpacing: Double?
    let peek: PrototypePagerPeek?
    let pageSize: PrototypePagerPageSize?
    /// Pager page dots (`none` or `dots`, #12071) and the `carousel` node's item sizing.
    let indicator: String?
    let itemWidth: Double?
    let itemSpacing: Double?
    let items: [NavItem]?
    let anchorTo: String?
    let caret: PrototypeCaret?
    let spotlight: TooltipSpotlight?
    let onDismiss: [PrototypeAction]?
    let edge: String?
    /// Menu entries decoded from the same `items` JSON key, preserving navigation items.
    let menuItems: [PrototypeMenuItem]?
    let pager: String?
    let onScroll: String?
    let scroll: String?
    let scrollable: Bool?
    let openWhen: Condition?
    /// Pull-to-refresh on a vertical `scroll` (`prototype_refresh_v1`).
    let refresh: PrototypeScrollRefresh?
    let listRepeat: PrototypeListRepeat?
    let listRowTemplate: JSONValue?
    let header: PrototypeNode?
    let footer: PrototypeNode?
    let spacing: Double?
    let contentPadding: Double?
    let onEndReached: [PrototypeAction]?
    let endThreshold: Int?
    let maxItems: Int?
    let reverse: Bool?
    let stickToEnd: Bool?
    let atEndKey: String?
    let onStartReached: [PrototypeAction]?
    /// Internal identity stamped after authored-spec validation.
    let repeatKey: String?
    let detents: [Detent]?
    let scrim: PrototypeModeValue?
    let dragHandle: Bool?
    /// Swipe dismissal is enabled when omitted, as on Android.
    let dismissOnSwipe: Bool?
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
    /// Swipe-revealed actions on a row or listItem (`prototype_swipe_actions_v1`).
    let swipeActions: PrototypeSwipeActions?
    /// Text field trailing icon button and keyboard action key (`prototype_text_field_actions_v1`).
    let trailingIcon: PrototypeAppBarAction?
    let imeAction: String?
    /// Text field input and supporting-line options (#12066); cross-field rules belong to the host.
    let supportingText: String?
    let errorWhen: Condition?
    let errorText: String?
    let keyboardType: String?
    let secure: Bool?
    let multiline: Bool?
    let minLines: Int?
    let maxLength: Int?
    /// `chart` series, fixed y axis, x label mode and goal line (#14209), read through `/data`.
    let chartSeries: [PrototypeChartSeries]?
    let yRange: PrototypeChartRange?
    let xLabels: String?
    let goal: Double?

    /// Gesture-only nodes have the same touch target and accessibility semantics as tap nodes.
    var isInteractive: Bool {
        onTap != nil || onLongPress != nil || onDoubleTap != nil
    }

    private enum CodingKeys: String, CodingKey {
        case scrollTransition, scrollLinked
        case type, id, testTag, onAppear, onTap, style, styleWhen, visibleWhen, shared, sharedKey, transition
        case safeAreaPadding, anchor, children, child, text, contentDescription, asset, contentScale, semantics
        case name, label, variant, stateKey, placeholder, axis, items, pager
        case anchorTo, caret, spotlight, onDismiss, edge
        case onScroll, scroll
        case scrollable, openWhen, detents, scrim, dragHandle, options, icon, size
        case orientation, min, max, step, title, navigationIcon, actions, confirm
        case dismiss, action, durationMs, hourKey, minuteKey, is24Hour, headline, supporting
        case leadingIcon, trailing, swipeActions
        case refresh, header, footer, spacing, contentPadding, onEndReached, endThreshold, maxItems
        case listRepeat = "repeat"
        case reverse, stickToEnd, atEndKey, onStartReached
        case repeatKey = "_repeatKey"
        case onLongPress, onDoubleTap, enabledWhen, checks, validateOn, maxLines, columns, span, start, screens, spans,
             routes,
             linkify,
             activeKey, trailingActions, onSubmit, pageSpacing, peek, pageSize, indicator, itemWidth, itemSpacing,
             dismissOnSwipe, supportingText, errorWhen, errorText, keyboardType, secure, multiline, minLines, maxLength,
             trailingIcon,
             imeAction, yRange, xLabels, goal
        case filter, fadeEdges
        case chartSeries = "series"
    }

    init(from decoder: Decoder) throws {
        nodePath = decoder.codingPath.reduce(into: "") { path, key in
            if let index = key.intValue { path += "[\(index)]" }
            else { path += (path.isEmpty ? "" : ".") + key.stringValue }
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedType = try container.decode(String.self, forKey: .type)
        type = decodedType
        id = try container.decodeIfPresent(String.self, forKey: .id)
        testTag = try container.decodeIfPresent(String.self, forKey: .testTag)
        onAppear = try container.decodeIfPresent([PrototypeAction].self, forKey: .onAppear)
        onTap = try container.decodeIfPresent([PrototypeAction].self, forKey: .onTap)
        style = try container.decodeIfPresent(Style.self, forKey: .style)
        styleWhen = try container.decodeIfPresent([StyleWhen].self, forKey: .styleWhen)
        visibleWhen = try container.decodeIfPresent(Condition.self, forKey: .visibleWhen)
        shared = try container.decodeIfPresent(Shared.self, forKey: .shared)
        sharedKey = try container.decodeIfPresent(String.self, forKey: .sharedKey)
        transition = try container.decodeIfPresent(PrototypeTransitionForm.self, forKey: .transition)?.type
        scrollTransition = try container.decodeIfPresent(ScrollTransition.self, forKey: .scrollTransition)
        scrollLinked = try container.decodeIfPresent(ScrollLinked.self, forKey: .scrollLinked)
        safeAreaPadding = try container.decodeIfPresent(SafeAreaPadding.self, forKey: .safeAreaPadding)
        anchor = try container.decodeIfPresent(PrototypeAnchor.self, forKey: .anchor)
        children = try container.decodeIfPresent([PrototypeNode].self, forKey: .children)
        child = try container.decodeIfPresent(PrototypeNode.self, forKey: .child)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        semantics = try container.decodeIfPresent(PrototypeSemantics.self, forKey: .semantics)
        contentDescription = try container.decodeIfPresent(String.self, forKey: .contentDescription)
        asset = try container.decodeIfPresent(PrototypeModeValue.self, forKey: .asset)
        filter = try container.decodeIfPresent(ImageFilter.self, forKey: .filter)
        fadeEdges = try container.decodeIfPresent(FadeEdges.self, forKey: .fadeEdges)
        contentScale = try container.decodeIfPresent(String.self, forKey: .contentScale)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        variant = try container.decodeIfPresent(String.self, forKey: .variant)
        stateKey = try container.decodeIfPresent(String.self, forKey: .stateKey)
        placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        reverse = try container.decodeIfPresent(Bool.self, forKey: .reverse)
        stickToEnd = try container.decodeIfPresent(Bool.self, forKey: .stickToEnd)
        atEndKey = try container.decodeIfPresent(String.self, forKey: .atEndKey)
        onStartReached = try container.decodeIfPresent([PrototypeAction].self, forKey: .onStartReached)
        repeatKey = try container.decodeIfPresent(String.self, forKey: .repeatKey)
        axis = try container.decodeIfPresent(String.self, forKey: .axis)
        if decodedType == "menu" {
            items = nil
            menuItems = try container.decode([PrototypeMenuItem].self, forKey: .items)
        } else {
            items = try container.decodeIfPresent([NavItem].self, forKey: .items)
            menuItems = nil
        }
        pager = try container.decodeIfPresent(String.self, forKey: .pager)
        onScroll = try container.decodeIfPresent(String.self, forKey: .onScroll)
        scroll = try container.decodeIfPresent(String.self, forKey: .scroll)
        scrollable = try container.decodeIfPresent(Bool.self, forKey: .scrollable)
        anchorTo = try container.decodeIfPresent(String.self, forKey: .anchorTo)
        caret = try container.decodeIfPresent(PrototypeCaret.self, forKey: .caret)
        spotlight = try container.decodeIfPresent(TooltipSpotlight.self, forKey: .spotlight)
        onDismiss = try container.decodeIfPresent([PrototypeAction].self, forKey: .onDismiss)
        edge = try container.decodeIfPresent(String.self, forKey: .edge)
        openWhen = try container.decodeIfPresent(Condition.self, forKey: .openWhen)
        refresh = try container.decodeIfPresent(PrototypeScrollRefresh.self, forKey: .refresh)
        listRowTemplate = decodedType == "list" ? try container.decodeIfPresent([JSONValue].self, forKey: .children)?
            .first : nil
        listRepeat = decodedType == "list" ? try container
            .decodeIfPresent(PrototypeListRepeat.self, forKey: .listRepeat) : nil
        header = try container.decodeIfPresent(PrototypeNode.self, forKey: .header)
        footer = try container.decodeIfPresent(PrototypeNode.self, forKey: .footer)
        spacing = try container.decodeIfPresent(Double.self, forKey: .spacing)
        contentPadding = try container.decodeIfPresent(Double.self, forKey: .contentPadding)
        onEndReached = try container.decodeIfPresent([PrototypeAction].self, forKey: .onEndReached)
        endThreshold = try container.decodeIfPresent(Int.self, forKey: .endThreshold)
        maxItems = try container.decodeIfPresent(Int.self, forKey: .maxItems)
        detents = try container.decodeIfPresent([Detent].self, forKey: .detents)
        scrim = try container.decodeIfPresent(PrototypeModeValue.self, forKey: .scrim)
        dragHandle = try container.decodeIfPresent(Bool.self, forKey: .dragHandle)
        options = try container.decodeIfPresent([PrototypeOption].self, forKey: .options)
        icon = try container.decodeIfPresent(String.self, forKey: .icon)
        size = try container.decodeIfPresent(String.self, forKey: .size)
        orientation = try container.decodeIfPresent(String.self, forKey: .orientation)
        min = try container.decodeIfPresent(Double.self, forKey: .min)
        max = try container.decodeIfPresent(Double.self, forKey: .max)
        step = try container.decodeIfPresent(Double.self, forKey: .step)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        navigationIcon = try container.decodeIfPresent(PrototypeAppBarAction.self, forKey: .navigationIcon)
        actions = try container.decodeIfPresent([PrototypeAppBarAction].self, forKey: .actions)
        confirm = try container.decodeIfPresent(PrototypeDialogButton.self, forKey: .confirm)
        dismiss = try container.decodeIfPresent(PrototypeDialogButton.self, forKey: .dismiss)
        action = try container.decodeIfPresent(PrototypeDialogButton.self, forKey: .action)
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
        hourKey = try container.decodeIfPresent(String.self, forKey: .hourKey)
        minuteKey = try container.decodeIfPresent(String.self, forKey: .minuteKey)
        is24Hour = try container.decodeIfPresent(Bool.self, forKey: .is24Hour)
        headline = try container.decodeIfPresent(String.self, forKey: .headline)
        supporting = try container.decodeIfPresent(String.self, forKey: .supporting)
        leadingIcon = try container.decodeIfPresent(String.self, forKey: .leadingIcon)
        trailing = try container.decodeIfPresent(PrototypeListItemTrailing.self, forKey: .trailing)
        swipeActions = try container.decodeIfPresent(PrototypeSwipeActions.self, forKey: .swipeActions)
        onLongPress = try container.decodeIfPresent([PrototypeAction].self, forKey: .onLongPress)
        onDoubleTap = try container.decodeIfPresent([PrototypeAction].self, forKey: .onDoubleTap)
        enabledWhen = try container.decodeIfPresent(Condition.self, forKey: .enabledWhen)
        checks = try container.decodeIfPresent([PrototypeCheck].self, forKey: .checks)
        validateOn = try container.decodeIfPresent(PrototypeValidateOn.self, forKey: .validateOn)
        maxLines = try container.decodeIfPresent(Int.self, forKey: .maxLines)
        columns = try container.decodeIfPresent(PrototypeGridColumns.self, forKey: .columns)
        span = try container.decodeIfPresent(Int.self, forKey: .span)
        start = try container.decodeIfPresent(String.self, forKey: .start)
        screens = try container.decodeIfPresent([String: PrototypeNode].self, forKey: .screens)
        screenDefinitions = try container.decodeIfPresent(JSONValue.self, forKey: .screens)
        routes = try container.decodeIfPresent([String: PrototypeRoute].self, forKey: .routes)
        spans = try container.decodeIfPresent([PrototypeTextSpan].self, forKey: .spans)
        linkify = try container.decodeIfPresent(PrototypeLinkifyOptions.self, forKey: .linkify)
        activeKey = try container.decodeIfPresent(String.self, forKey: .activeKey)
        trailingActions = try container.decodeIfPresent([PrototypeAppBarAction].self, forKey: .trailingActions)
        onSubmit = try container.decodeIfPresent([PrototypeAction].self, forKey: .onSubmit)
        pageSpacing = try container.decodeIfPresent(Double.self, forKey: .pageSpacing)
        peek = try container.decodeIfPresent(PrototypePagerPeek.self, forKey: .peek)
        pageSize = try container.decodeIfPresent(PrototypePagerPageSize.self, forKey: .pageSize)
        indicator = try container.decodeIfPresent(String.self, forKey: .indicator)
        itemWidth = try container.decodeIfPresent(Double.self, forKey: .itemWidth)
        itemSpacing = try container.decodeIfPresent(Double.self, forKey: .itemSpacing)
        dismissOnSwipe = try container.decodeIfPresent(Bool.self, forKey: .dismissOnSwipe)
        supportingText = try container.decodeIfPresent(String.self, forKey: .supportingText)
        errorWhen = try container.decodeIfPresent(Condition.self, forKey: .errorWhen)
        errorText = try container.decodeIfPresent(String.self, forKey: .errorText)
        keyboardType = try container.decodeIfPresent(String.self, forKey: .keyboardType)
        secure = try container.decodeIfPresent(Bool.self, forKey: .secure)
        multiline = try container.decodeIfPresent(Bool.self, forKey: .multiline)
        minLines = try container.decodeIfPresent(Int.self, forKey: .minLines)
        maxLength = try container.decodeIfPresent(Int.self, forKey: .maxLength)
        trailingIcon = try container.decodeIfPresent(PrototypeAppBarAction.self, forKey: .trailingIcon)
        imeAction = try container.decodeIfPresent(String.self, forKey: .imeAction)
        chartSeries = try container.decodeIfPresent([PrototypeChartSeries].self, forKey: .chartSeries)
        yRange = try container.decodeIfPresent(PrototypeChartRange.self, forKey: .yRange)
        xLabels = try container.decodeIfPresent(String.self, forKey: .xLabels)
        goal = try container.decodeIfPresent(Double.self, forKey: .goal)
    }

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
        header?.collectPagers(into: &counts)
        footer?.collectPagers(into: &counts)
        screens?.values.forEach { $0.collectPagers(into: &counts) }
    }

    /// `fontFamily: {asset}` ids on this node's own style and its `styleWhen` entries.
    func fontAssetIds() -> Set<String> {
        let styles = [style].compactMap { $0 } + (styleWhen ?? []).map(\.style)
        let spanFonts = (spans ?? []).compactMap { span -> String? in
            if case let .asset(id) = span.style?.fontFamily { id } else { nil }
        }
        return Set(spanFonts + styles.compactMap { style -> String? in
            if case let .asset(id) = style.fontFamily { id } else { nil }
        })
    }

    /// Every font asset id in this subtree.
    func collectFontAssets(into ids: inout Set<String>) {
        ids.formUnion(fontAssetIds())
        children?.forEach { $0.collectFontAssets(into: &ids) }
        child?.collectFontAssets(into: &ids)
        header?.collectFontAssets(into: &ids)
        footer?.collectFontAssets(into: &ids)
        screens?.values.forEach { $0.collectFontAssets(into: &ids) }
    }

    /// Asset ids the spec references, for the `missingAssets` warning.
    func collectAssets(into ids: inout Set<String>) {
        // A {light, dark} pair references both ids, whichever mode is drawn.
        ids.formUnion(asset?.values ?? [])
        ids.formUnion(fontAssetIds())
        items?.compactMap(\.image).forEach { ids.formUnion($0.values) }
        children?.forEach { $0.collectAssets(into: &ids) }
        child?.collectAssets(into: &ids)
        header?.collectAssets(into: &ids)
        footer?.collectAssets(into: &ids)
        screens?.values.forEach { $0.collectAssets(into: &ids) }
    }
}

// Compatibility accessors keep layout consumers independent of the wire union's cases.
extension Placement {
    var type: String {
        switch self {
        case .fullscreen: "fullscreen"
        case .sheet: "sheet"
        case .floating: "floating"
        }
    }

    var scrim: PrototypeModeValue? {
        if case let .fullscreen(scrim) = self { return scrim }
        return nil
    }

    var edge: String? {
        if case let .sheet(edge, _) = self { return edge }
        return nil
    }

    var height: Double? {
        if case let .sheet(_, height) = self { return height }
        return nil
    }

    var gravity: String? {
        if case let .floating(gravity, _) = self { return gravity }
        return nil
    }

    var offset: Offset? {
        if case let .floating(_, offset) = self { return offset }
        return nil
    }
}
