public enum Result {
    case success
    case failure, cancelled
    case value(
        code: Int,
        message: String
    )
    indirect case next(Result)
    public var name: String { "result" }
    public func describe() {
        let braces = "} { \" // }"
        // } } }
        /* } { */
        let multiline = """
        } } }
        """
        switch self {
        case .success:
            let local = "success"
        default:
            break
        }
    }
    case afterBody
}

public indirect enum Tree
{
    case leaf
    case branch(Tree, Tree)
}

public struct Container {
    public enum Nested {
        case nestedPublic
    }
    private enum Hidden {
        case nestedPrivate
    }
    public enum Following {
        case followingPublic
    }
}

enum Internal {
    case internalOnly
}
private enum Private {
    case privateOnly
}
fileprivate enum FilePrivate {
    case fileprivateOnly
}
internal enum ExplicitInternal {
    case explicitInternalOnly
}
struct HiddenContainer {
    public enum Exposed {
        case hiddenParent
    }
}
private struct PrivateContainer {
    public enum Exposed {
        case privateParent
    }
}

public protocol Provider {
    associatedtype Value
    func captureObservation() -> Value
    var value: Value { get set }
    var splitAccessors: Value {
        get
        set
    }
    init(
        value: Value
    )
    subscript(index: Int) -> Value { get }
    static func make() -> Self
    static var count: Int { get }
    class func classRequirement() -> Self
    @objc optional func optionalRequirement()
    @MainActor func attributedRequirement()
    @MainActor
    func nextLineAttribute()
#if DEBUG
    /// Conditional requirements still belong to the protocol. }

    func conditionalRequirement()
#endif
    /* Documentation containing a misleading brace: }
       func commentedRequirement()
    */
    func afterComment()
}

protocol InternalProvider {
    func internalRequirement()
}

public extension Container {
    func inherited() {
        let local = "}"
        switch local {
        case "}": break
        default: break
        }
    }
    @MainActor func attributedMember() {}
    var inheritedValue: Int { 1 }
    init(value: Int) { self.init() }
    static func inheritedStatic() {}
    class func inheritedClass() {}
    public func explicitPublic() {}
    private func privateMember() {}
    fileprivate var fileprivateMember: Int { 0 }
    internal func internalMember() {}
    enum InheritedEnum {
        case extensionCase
    }
}

extension Provider {
    func defaultImplementation() {
        let implementationLocal = 0
    }
}
