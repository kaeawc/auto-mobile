import CtrlProxy
import Foundation

/// Decodes / re-encodes / hashes a `ViewHierarchy` through the `CtrlProxy`
/// module. Imports the `CtrlProxy` module.
enum HierarchyDecoder {
    static func decodeReencodeAndHash(_ data: Data) throws -> (encoded: Data, structuralHash: Int) {
        let hierarchy = try JSONDecoder().decode(ViewHierarchy.self, from: data)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(hierarchy)
        return (encoded, StructuralHasher.computeHash(hierarchy))
    }
}
