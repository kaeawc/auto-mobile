import ts from "typescript";

/** Replace comment characters with spaces while preserving offsets and newlines. */
export function blankComments(source: string): string {
  const sourceFile = ts.createSourceFile(
    "blank-comments.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const ranges = new Map<string, ts.CommentRange>();

  const addRanges = (comments: ts.CommentRange[] | undefined): void => {
    for (const range of comments ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
  };

  const collect = (node: ts.Node): void => {
    addRanges(ts.getLeadingCommentRanges(source, node.getFullStart()));
    addRanges(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) {
      collect(child);
    }
  };

  collect(sourceFile);
  const out = source.split("");
  for (const { pos, end } of ranges.values()) {
    for (let index = pos; index < end; index += 1) {
      if (out[index] !== "\n" && out[index] !== "\r") {
        out[index] = " ";
      }
    }
  }
  return out.join("");
}
