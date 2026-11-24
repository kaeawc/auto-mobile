import Foundation

/// NSCache is thread-safe; immutable decoded entries share one app-wide pixel budget.
final class PrototypeRemoteImageMemory: @unchecked Sendable {
    static let shared = PrototypeRemoteImageMemory()
    private let cache = NSCache<NSString, PrototypeRemoteImage>()

    init() { cache.totalCostLimit = PrototypeRemoteImages.maxIOSMemoryBytes }

    func get(_ url: String) -> PrototypeRemoteImage? { cache.object(forKey: url as NSString) }

    func put(_ image: PrototypeRemoteImage, url: String) {
        cache.setObject(image, forKey: url as NSString, cost: image.decodedBytes)
    }
}
