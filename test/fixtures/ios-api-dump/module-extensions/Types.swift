/* public struct CommentOnly {}
public struct CommentOnly {}
*/
let text = "public struct StringOnly {}"
let multiline = """
}
public struct StringOnly {}
{
"""
struct Container {
    // } does not close the container
    public struct NestedOnly {}
    struct Later {}
}
public struct Later {}
open class OpenLater {}
struct Hidden {}
