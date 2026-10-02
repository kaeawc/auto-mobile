public enum Options {
    case first,
        second
    indirect case value(
        Int
    ),
        next(Options),
        last
    case following
}
