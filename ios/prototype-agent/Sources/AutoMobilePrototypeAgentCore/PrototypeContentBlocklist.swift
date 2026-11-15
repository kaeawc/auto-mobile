import Foundation

/// Local Hide state for received content (#16437). Hide keys on the spec SHA-256 recorded at import,
/// so it hides that content and its later copies, and blocks no one. Block keys on a link-origin
/// host, which only a link import records; iOS has no link import, so it has nothing to block yet.
protocol PrototypeContentBlocklist: AnyObject {
    var hiddenSpecHashes: Set<String> { get }
    func hide(_ specSha256: String) throws
}

/// The two `UserDefaults` calls the blocklist needs, so tests can supply an in-memory fake.
protocol PrototypeStringListDefaults: AnyObject {
    func stringArray(forKey defaultName: String) -> [String]?
    func set(_ value: Any?, forKey defaultName: String)
}

extension UserDefaults: PrototypeStringListDefaults {}

/// App-local and never exported: the list lives in defaults, outside the library directory.
final class PrototypeDefaultsContentBlocklist: PrototypeContentBlocklist {
    static let hiddenKey = "hidden_spec_sha256"
    private let defaults: any PrototypeStringListDefaults
    private let lock = NSLock()

    init(defaults: any PrototypeStringListDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    var hiddenSpecHashes: Set<String> { lock.withLock { read() } }

    func hide(_ specSha256: String) throws {
        guard Self.isSpecSha256(specSha256) else {
            throw PrototypeLibraryFailure(path: "specSha256", message: "Not a spec SHA-256")
        }
        lock.withLock { defaults.set(read().union([specSha256]).sorted(), forKey: Self.hiddenKey) }
    }

    /// Lowercase hex, as the library records it. A malformed stored value is ignored, not fatal.
    static func isSpecSha256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }

    private func read() -> Set<String> {
        Set((defaults.stringArray(forKey: Self.hiddenKey) ?? []).filter(Self.isSpecSha256))
    }
}

extension PrototypeLibraryEntry.Source {
    /// Report and Hide apply to content another person sent, never to the user's own prototypes.
    var isReceived: Bool { self == .file || self == .share }
}

extension PrototypeLibraryEntry {
    var isReceived: Bool { source.isReceived }

    func isHidden(by hidden: Set<String>) -> Bool { isReceived && hidden.contains(specSha256) }
}
