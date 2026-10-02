public protocol Values {
    var value: Int { get set }
    subscript(index: Int) -> Int { get set }
    var commented: Int { get set } // requirement
    var split: Int {
        get
        set
    }
}
