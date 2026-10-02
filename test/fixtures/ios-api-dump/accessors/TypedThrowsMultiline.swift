public protocol TypedRequirements {
    var typed: Int {
        get
        throws(E1)
    }
    var effect: Int {
        get async
        throws(E1)
    }
    var qualified: Int {
        get throws(Module.MyError)
    }
    var generic: Int {
        get
        throws(Wrapper<A, B>)
    }
    var invalidBefore: Int {
        throws(E1) get
    }
    var invalidSetter: Int {
        set throws(E1)
    }
    var invalidPrefix: Int {
        get mutating throws(E1) set
    }
    var invalidCoroutine: Int {
        _read throws(E1)
    }
}
