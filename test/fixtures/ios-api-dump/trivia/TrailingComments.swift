public protocol TrailingComments {
    var inlinePlain: Int { get set } // x
    var inlineBlock: Int { get /* c */ set } // x
    func plain() -> Int // x
    func block() -> Int /* c */ // x
    var multilinePlain: Int {
        get
        set
    } // x
    var multilineBlock: Int {
        get
        set
    } /* c */ // x
    var nextLinePlain: Int
    { get set } // x
    var nextLineBlock: Int
    { get /* c */ set } // x
    func inlineWherePlain<T>(_ value: T) -> Int where T: Equatable // x
    func inlineWhereBlock<T>(_ value: T) -> Int where T: Equatable /* c */ // x
    func wherePlain<T>(_ value: T) -> Int
        where T: Equatable // x
    func whereBlock<T>(_ value: T) -> Int
        where T: Equatable /* c */ // x
    func laterParenPlain( // x
        _ value: Int // x
    ) -> Int // x
    func laterParenBlock( /* c */ // x
        _ value: Int /* c */ // x
    ) -> Int /* c */ // x
}
