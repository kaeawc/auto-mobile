import Foundation

// MARK: - Shared wire-snapshot fixture loading

/// One decoded entry of the shared request-wire fixture
/// (`test/fixtures/ios-ctrlproxy-request-snapshots.json`).
///
/// Not `Sendable`: `wire` is a `[String: Any]` used synchronously within a single
/// test method. It never crosses an isolation boundary.
public struct WireSnapshot {
    public let name: String
    /// The exact JSON object the TS client puts on the wire, including the `type`
    /// discriminator.
    public let wire: [String: Any]

    public init(name: String, wire: [String: Any]) {
        self.name = name
        self.wire = wire
    }
}

public enum WireSnapshotFixtureError: Error {
    case malformed(String)
}

/// Loads and shapes the shared request-wire snapshot fixture. The same bytes back
/// the reference `RequestSnapshotWireParityTests`, the TS capture test, and the
/// rewrite's differential decode-parity gate — so all three read one oracle.
public enum WireSnapshotFixture {
    /// The canonical fixture lives at the repo root so the TS and Swift suites read
    /// the same bytes. A test passes its own `#filePath`; `climb` is the number of
    /// path components from that file up to the repo root (5 for a file at
    /// `<repo>/ios/control-proxy/Tests/<target>/<file>.swift`). A missing fixture
    /// fails loudly (never skips) — silently skipping would defeat the tripwire.
    public static func fixtureURL(fromTestFilePath path: String, climb levels: Int = 5) -> URL {
        var url = URL(fileURLWithPath: path)
        for _ in 0..<levels {
            url.deleteLastPathComponent()
        }
        return url
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent("ios-ctrlproxy-request-snapshots.json")
    }

    /// Loads every `{ name, wire }` snapshot from the fixture at `url`.
    public static func load(contentsOf url: URL) throws -> [WireSnapshot] {
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = root["snapshots"] as? [[String: Any]]
        else {
            throw WireSnapshotFixtureError.malformed("fixture root must be { snapshots: [...] }")
        }
        return try entries.map { entry in
            guard let name = entry["name"] as? String,
                  let wire = entry["wire"] as? [String: Any]
            else {
                throw WireSnapshotFixtureError.malformed("snapshot entries must carry `name` and `wire`")
            }
            return WireSnapshot(name: name, wire: wire)
        }
    }
}

// MARK: - Mirror-based payload normalization

/// Convert a decoded payload value into a JSON-comparable form: optionals unwrap
/// (nil → NSNull), numbers/strings pass through, structs become dictionaries keyed
/// by property name, collections and dictionaries recurse.
///
/// This is a module-agnostic port of the normalizer in the reference target's
/// `RequestSnapshotWireParityTests`. Because it reflects structurally, it applies
/// uniformly to a payload decoded by `CtrlProxy` OR by `CtrlProxyRewrite`, which is
/// what lets the differential gate compare the two side by side.
///
/// Assumption (holds for every request payload): payloads use synthesized
/// `Decodable` with no custom `CodingKeys`, so a property's Mirror label IS its
/// wire key. A payload that adds custom `CodingKeys` breaks that equivalence and
/// must update this normalization.
public func jsonNormalized(_ value: Any) -> Any {
    let mirror = Mirror(reflecting: value)
    if mirror.displayStyle == .optional {
        guard let child = mirror.children.first else {
            return NSNull()
        }
        return jsonNormalized(child.value)
    }
    // Int/Int64/Double/Float/Bool all bridge to NSNumber; String stays String.
    if let number = value as? NSNumber {
        return number
    }
    if let string = value as? String {
        return string
    }
    switch mirror.displayStyle {
    case .collection:
        return mirror.children.map { jsonNormalized($0.value) }
    case .dictionary:
        var dict = [String: Any]()
        for child in mirror.children {
            let pair = Mirror(reflecting: child.value).children.map(\.value)
            if pair.count == 2, let key = pair[0] as? String {
                dict[key] = jsonNormalized(pair[1])
            }
        }
        return dict
    case .struct, .class:
        var dict = [String: Any]()
        for child in mirror.children {
            if let label = child.label {
                dict[label] = jsonNormalized(child.value)
            }
        }
        return dict
    default:
        return value
    }
}
