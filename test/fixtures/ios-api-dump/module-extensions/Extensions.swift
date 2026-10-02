extension Later {
    public enum Kind {
        case one
        case two
    }
    public protocol Req {
        func need()
        var value: Int {
            get
            set
        }
    }
    public func explicitMember() {}
    func internalMember() {}
}
extension OpenLater {
    public enum OpenKind {
        case openCase
    }
}
extension Hidden {
    public enum HKind {
        case hiddenCase
    }
    public protocol HReq {
        func hiddenRequirement()
    }
}
extension CommentOnly {
    public enum CommentKind {
        case commentCase
    }
}
extension StringOnly {
    public enum StringKind {
        case stringCase
    }
}
extension NestedOnly {
    public enum NestedKind {
        case nestedCase
    }
}
