import Foundation

/// Category of a breadcrumb event for classification.
public enum BreadcrumbCategory: String, Codable, Sendable {
    case navigation, tap, lifecycle, network, log, custom
}

/// A single breadcrumb entry with timestamp, category, message, and metadata.
public struct Breadcrumb: Codable, Sendable {
    public let timestamp: TimeInterval
    public let category: BreadcrumbCategory
    public let message: String
    public let metadata: [String: String]

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        category: BreadcrumbCategory,
        message: String,
        metadata: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.category = category
        self.message = message
        self.metadata = metadata
    }
}

/// Protocol for adding, snapshotting, and clearing breadcrumbs.
public protocol BreadcrumbTracking: AnyObject, Sendable {
    func add(_ breadcrumb: Breadcrumb)
    func snapshot() -> [Breadcrumb]
    func clear()
}

/// Thread-safe ring buffer of recent breadcrumbs.
public final class BreadcrumbTrail: BreadcrumbTracking, @unchecked Sendable {
    private let lock = NSLock()
    private let maxSize: Int
    private var buffer: [Breadcrumb] = []

    public init(maxSize: Int = 100) {
        self.maxSize = maxSize
        buffer.reserveCapacity(maxSize)
    }

    public func add(_ breadcrumb: Breadcrumb) {
        lock.lock()
        if buffer.count >= maxSize {
            buffer.removeFirst()
        }
        buffer.append(breadcrumb)
        lock.unlock()
    }

    public func snapshot() -> [Breadcrumb] {
        lock.lock()
        defer { lock.unlock() }
        return Array(buffer)
    }

    public func clear() {
        lock.lock()
        buffer.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    // MARK: - Disk Persistence for Crash Resilience

    /// Write current breadcrumbs to disk for crash recovery.
    public func writeToDisk(directory: URL? = nil) {
        let dir = directory ?? Self.defaultDirectory()
        let fileURL = dir.appendingPathComponent("automobile_breadcrumbs.json")
        let crumbs = snapshot()
        guard let data = try? JSONEncoder().encode(crumbs) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Load breadcrumbs saved from a previous session.
    public static func loadFromDisk(directory: URL? = nil) -> [Breadcrumb]? {
        let dir = directory ?? defaultDirectory()
        let fileURL = dir.appendingPathComponent("automobile_breadcrumbs.json")
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode([Breadcrumb].self, from: data)
    }

    /// Remove persisted breadcrumbs file.
    public static func clearDisk(directory: URL? = nil) {
        let dir = directory ?? defaultDirectory()
        let fileURL = dir.appendingPathComponent("automobile_breadcrumbs.json")
        try? FileManager.default.removeItem(at: fileURL)
    }

    private static func defaultDirectory() -> URL {
        // The caches directory always exists in userDomainMask on iOS.
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!  // swiftlint:disable:this force_unwrapping
    }
}
