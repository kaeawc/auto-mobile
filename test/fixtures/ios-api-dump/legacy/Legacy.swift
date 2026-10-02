public struct Legacy {
    public var value: Int
    public init(
        value: Int,
        factory: () -> Int = { 1 }
    ) {
        self.value = value
    }
    @discardableResult public func update(_ value: Int) -> Int {
        switch value {
        case 0: return 1
        default: return value
        }
    }
    public static let notification = Notification.Name(
        "legacy.notification"
    )
}
