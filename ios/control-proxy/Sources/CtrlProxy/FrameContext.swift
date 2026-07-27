import Foundation

/// Stable, opaque identity for a device hierarchy. It deliberately hashes the encoded hierarchy
/// rather than dimensions: same-size navigation must still invalidate a mirrored frame.
enum FrameContext {
    static func forHierarchy(_ hierarchy: ViewHierarchy) -> String? {
        // `updatedAt` is assigned for every extraction, so including it would reject an unchanged
        // screen merely because validation sampled it a millisecond later. Hash only semantic
        // screen state, with sorted keys for deterministic dictionary encoding.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(SemanticHierarchy(hierarchy)) else { return nil }
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 0x100000001b3
        }
        return String(hash, radix: 16)
    }
}

private struct SemanticHierarchy: Encodable {
    let packageName: String?
    let hierarchy: UIElementInfo?
    let windowInfo: WindowInfo?
    let windows: [WindowInfo]?
    let screenScale: Float?
    let screenWidth: Int?
    let screenHeight: Int?
    let systemInsets: EdgeInsetsInfo?
    let insets: ObservationInsetsInfo
    let error: String?
    let fallbackToSpringboard: Bool?

    init(_ value: ViewHierarchy) {
        packageName = value.packageName
        hierarchy = value.hierarchy
        windowInfo = value.windowInfo
        windows = value.windows
        screenScale = value.screenScale
        screenWidth = value.screenWidth
        screenHeight = value.screenHeight
        systemInsets = value.systemInsets
        insets = value.insets
        error = value.error
        fallbackToSpringboard = value.fallbackToSpringboard
    }
}
