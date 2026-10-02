public struct Outer {}
open class OpenOuter {}
struct InternalOuter {}
extension Outer {
    public enum Nested {
        case visible
    }
    func internalMember() {}
    enum InternalNested {
        case hiddenNested
    }
}
extension OpenOuter {
    public enum OpenNested {
        case openVisible
    }
}
extension InternalOuter {
    enum Nested {
        case hiddenInternal
    }
}
