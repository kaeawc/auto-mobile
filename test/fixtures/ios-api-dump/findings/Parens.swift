public enum Token: String {
    case leftParen = "("
    case rightParen = ")"
    case later
}
public func following() {}
public func multiline(
    value: String = "(" // unmatched comment paren: (
) {}
public func afterMultiline() {}
