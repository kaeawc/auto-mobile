public protocol Requirements {
    var x: Int { get set }
    var readOnly: Int { get }
    var asyncValue: Int { get async }
    var throwingValue: Int { get throws }
    var effect: Int { get async throws }
    var prefixed: Int { mutating get nonmutating set }
    var coroutine: Int { _read _modify }
    var attributed: Int { @MainActor get nonmutating set }
    var available: Int { @available(*, deprecated, message: "use  {other}") get }
    subscript(index: Int) -> Int { get set }
    var nextLine: Int { get async throws }
    subscript( index: Int, second: Int ) -> Int { get async throws }
    func afterAccessors()
}
public struct Computed {
    public var body: Int {
        get { 1 }
        set { }
    }
}
public protocol BodyLike {
    var invalid: Int {
        return 1
    }
    func afterInvalid()
}
public class BodyOwner {
    public var classBody: Int {
        get { 1 }
        set { }
    }
}
extension BodyOwner {
    public var extensionBody: Int {
        get { 1 }
        set { }
    }
}
