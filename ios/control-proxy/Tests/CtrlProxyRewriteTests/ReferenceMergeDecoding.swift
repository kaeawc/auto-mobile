import CtrlProxy
import Foundation

/// Decodes an XCUITest + SDK hierarchy pair, runs the REFERENCE `HierarchyMerger`,
/// and re-encodes the merged result with sorted keys. Imports only `CtrlProxy` so
/// the bare type names resolve unambiguously (see `ReferenceWireDecoder`).
enum ReferenceMerge {
    static func mergeAndReencode(xcuitest: Data, sdk: Data) throws -> Data {
        let xc = try JSONDecoder().decode(ViewHierarchy.self, from: xcuitest)
        let sdkHierarchy = try JSONDecoder().decode(SdkViewHierarchy.self, from: sdk)
        let merged = HierarchyMerger.merge(xcuitest: xc, sdk: sdkHierarchy)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(merged)
    }
}
