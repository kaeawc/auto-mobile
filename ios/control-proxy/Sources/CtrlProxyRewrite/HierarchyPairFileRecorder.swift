import Foundation
import os

/// Writes merger input pairs as sorted-key JSON files under a host directory (#5837).
///
/// Simulator runners share the host filesystem, so the daemon forwards
/// `CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` through the xctestrun environment and the files
/// land directly in the developer's capture directory. Each file is
/// compact sorted-key `{"sdk": SdkViewHierarchy, "xcuitest": ViewHierarchy}` named `pair-NNNN-<bundle>.json`.
///
/// Nothing is redacted: XCUITest already masks secure-text-field values, and the SDK
/// tree carries accessibility labels and geometry, not field contents.
public final class HierarchyPairFileRecorder: HierarchyPairRecording, Sendable {
    public static let environmentKey = "CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR"

    private let directory: URL
    private let sequence = OSAllocatedUnfairLock<Int>(initialState: 0)

    public init(directory: URL) {
        self.directory = directory
    }

    /// A recorder for the directory named by the environment, or nil when unset or blank.
    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    )
        -> HierarchyPairFileRecorder?
    {
        guard let path = environment[environmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty
        else { return nil }
        return HierarchyPairFileRecorder(directory: URL(fileURLWithPath: path, isDirectory: true))
    }

    public func record(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy) {
        let index = sequence.withLock { value -> Int in
            value += 1
            return value
        }
        let bundle = (sdk.bundleId ?? xcuitest.packageName ?? "unknown")
            .map { $0.isLetter || $0.isNumber || $0 == "." ? $0 : "_" }
        let name = String(format: "pair-%04d-", index) + String(bundle) + ".json"
        do {
            let encoder = JSONEncoder()
            // Compact: pairs are ~100 KB each and are committed as replay fixtures.
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(HierarchyPair(xcuitest: xcuitest, sdk: sdk))
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try (data + Data("\n".utf8)).write(to: directory.appendingPathComponent(name), options: .atomic)
        } catch {
            // Capture is a best-effort developer aid; a failed write must not fail the
            // hierarchy request it observes.
            print("[HierarchyPairFileRecorder] Failed to write \(name): \(error)")
        }
    }
}
