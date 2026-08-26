import CtrlProxy
import Foundation

/// Decodes / re-encodes / hashes a `ViewHierarchy` through the REFERENCE `CtrlProxy`
/// module. Imports only `CtrlProxy` so the bare `ViewHierarchy` / `StructuralHasher`
/// resolve unambiguously (see `ReferenceWireDecoder` for the module-vs-type clash).
enum ReferenceHierarchyDecoder {
    /// Decodes the JSON into `ViewHierarchy`, re-encodes it with sorted keys, and
    /// computes its structural hash. Returned as module-agnostic Foundation values
    /// so the parity test never names either module's types.
    static func decodeReencodeAndHash(_ data: Data) throws -> (encoded: Data, structuralHash: Int) {
        let hierarchy = try JSONDecoder().decode(ViewHierarchy.self, from: data)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(hierarchy)
        return (encoded, StructuralHasher.computeHash(hierarchy))
    }
}
