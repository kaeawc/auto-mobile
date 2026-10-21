import Foundation

public final class OSLogReaderHolder: Sendable {
    public static let shared = OSLogReaderHolder()
    private let reader = OSLogReader()

    private init() {}

    public func start() { reader.start() }
    public func stop() { reader.stop() }
    public func drain() -> [Data] { reader.drain() }
}
