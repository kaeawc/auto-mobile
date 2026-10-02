public enum E1: Error {}
public enum E2: Error {}
public protocol P {
    var x: Int { get throws(E1) }
}
