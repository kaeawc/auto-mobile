public protocol P {
    var inline: Int { @available(*, deprecated, message: "close } here") get set }
    var multiline: Int {
        @available(*, deprecated, message: "close } here") get
        set
    }
    var closing: Int {
        get
        @available(*, deprecated, message: "a } b") set }
    var nextLine: Int
    {
        @available(*, deprecated, message: "open { and close } here") get
        set
    }
}
