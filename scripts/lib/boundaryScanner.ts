import { relative } from "node:path";
import ts from "typescript";

/**
 * Table-driven execution-boundary scanner (issue #13219). Each boundary is a
 * row: the owner that may hold the forbidden call, path exclusions, a detector
 * over a parsed TypeScript source file, and the failure text. The scanner owns
 * diff parsing, ratchet scoping and output so a new boundary never needs its
 * own checker script.
 */

export interface BoundaryHit {
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface BoundaryRow {
  readonly id: string;
  /** The only repo-relative path allowed to hold the forbidden call. */
  readonly owner: string;
  /** Repo-relative path prefixes that are never scanned. */
  readonly skipPrefixes: readonly string[];
  /** Repo-relative paths, beyond the owner, that are never scanned (documented exceptions or allowlists). */
  readonly skipFiles?: readonly string[];
  /** The directory a `tree` row walks; defaults to `src`. */
  readonly treeRoot?: string;
  /** File extensions scanned by `tree` rows; defaults to `.ts`. */
  readonly extensions?: readonly string[];
  /**
   * `added-lines` only reports hits that overlap a line added in the diff (a
   * ratchet that tolerates existing debt). `whole-file` reports every hit in a
   * changed file. `tree` scans every `.ts` file under `src/` (a full-tree
   * check) and needs no diff.
   */
  readonly scope: "added-lines" | "whole-file" | "tree";
  /**
   * How failures are listed: `files` one indented line per file; `locations`
   * indented `file:line:col: text`; `positions` indented `file:line:col`;
   * `src-locations` unindented `file:line:col: text` with the leading `src/`
   * stripped; `bare-locations` and `bare-positions` are the same unindented
   * forms with the full repo path kept. `root-locations` is `file:line:col: text` with the file
   * relative to the row's `treeRoot`. `file-messages` prints `fileMessage(file)` once per file.
   */
  readonly report:
    | "file-messages"
    | "root-locations"
    | "files"
    | "locations"
    | "positions"
    | "src-locations"
    | "bare-locations"
    | "bare-positions";
  /** Printed above the violations; an empty string prints the violations alone. */
  readonly failureHeader: string;
  readonly successMessage?: string;
  /** The line a `file-messages` row prints for each violating file. */
  readonly fileMessage?: (file: string) => string;
  /**
   * For `tree` rows: fewer scanned files than this means the walk saw a partial tree, and a
   * silently-empty scan would pass while checking nothing.
   */
  readonly minTreeFiles?: number;
  /** Hits as 1-based [startLine, endLine] spans plus position. */
  readonly detect: (source: string, file: string) => readonly BoundarySpan[];
}

export interface BoundarySpan extends BoundaryHit {
  readonly endLine: number;
}

export interface BoundaryViolation extends BoundaryHit {
  readonly file: string;
}

export interface ChangedFile {
  readonly path: string;
  /** 1-based line numbers added on the new side of the diff. */
  readonly addedLines: ReadonlySet<number>;
}

/** Parses a unified diff (`git diff` / `jj diff --git`) into changed files and their added lines. */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header) {
      const path = header[2]!;
      current = files.get(path) ?? new Set<number>();
      files.set(path, current);
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      if (raw === "+++ /dev/null") {
        // Deleted file: nothing on disk to scan.
        for (const [path, lines] of files) {
          if (lines === current) {
            files.delete(path);
          }
        }
        current = null;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || current === null) {
      continue;
    }
    if (raw.startsWith("+")) {
      current.add(newLine);
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      newLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // Removed lines and "No newline" markers do not advance the new side.
    } else {
      inHunk = false;
    }
  }
  return [...files].map(([path, addedLines]) => ({ path, addedLines }));
}

export interface ScanOptions {
  readonly readSource: (path: string) => string | undefined;
}

export function scanBoundary(
  row: BoundaryRow,
  changed: readonly ChangedFile[],
  options: ScanOptions,
): BoundaryViolation[] {
  return changed.flatMap((file) => {
    if (
      file.path === row.owner ||
      row.skipFiles?.includes(file.path) ||
      row.skipPrefixes.some((prefix) => file.path.startsWith(prefix))
    ) {
      return [];
    }
    const source = options.readSource(file.path);
    if (source === undefined) {
      return [];
    }
    return row
      .detect(source, file.path)
      .filter(
        (hit) =>
          row.scope !== "added-lines" ||
          [...file.addedLines].some((line) => line >= hit.line && line <= hit.endLine),
      )
      .map(({ line, column, text }) => ({ file: file.path, line, column, text }));
  });
}

function reportLines(
  { report, fileMessage, treeRoot }: Pick<BoundaryRow, "report" | "fileMessage" | "treeRoot">,
  violations: readonly BoundaryViolation[],
): string[] {
  switch (report) {
    case "file-messages":
      return [...new Set(violations.map((violation) => violation.file))].map(
        (file) => fileMessage?.(file) ?? file,
      );
    case "root-locations":
      return violations.map(
        (violation) =>
          `${relative(treeRoot ?? "src", violation.file).replaceAll("\\", "/")}:${violation.line}:${violation.column}: ${violation.text}`,
      );
    case "files":
      return [...new Set(violations.map((violation) => violation.file))].map((file) => `  ${file}`);
    case "locations":
      return violations.map(
        (violation) =>
          `  ${violation.file}:${violation.line}:${violation.column}: ${violation.text}`,
      );
    case "positions":
      return violations.map(
        (violation) => `  ${violation.file}:${violation.line}:${violation.column}`,
      );
    case "bare-locations":
      return violations.map(
        (violation) => `${violation.file}:${violation.line}:${violation.column}: ${violation.text}`,
      );
    case "bare-positions":
      return violations.map(
        (violation) => `${violation.file}:${violation.line}:${violation.column}`,
      );
    case "src-locations":
      return violations.map(
        (violation) =>
          `${violation.file.replace(/^src\//, "")}:${violation.line}:${violation.column}: ${violation.text}`,
      );
  }
}

export function renderBoundaryResult(
  row: BoundaryRow,
  violations: readonly BoundaryViolation[],
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  if (violations.length === 0) {
    return {
      exitCode: 0,
      stdout: row.successMessage ? `${row.successMessage}\n` : "",
      stderr: "",
    };
  }
  const lines = reportLines(row, violations);
  const output = row.failureHeader ? [row.failureHeader, ...lines] : lines;
  return { exitCode: 1, stdout: "", stderr: `${output.join("\n")}\n` };
}

/** The error for a `tree` scan that found fewer files than the row requires, or undefined. */
export function treeTooSmallMessage(row: BoundaryRow, scanned: number): string | undefined {
  return row.minTreeFiles !== undefined && scanned < row.minTreeFiles
    ? `error: ${row.id}-boundary scanned only ${scanned} files under src; expected the full source tree.`
    : undefined;
}

/** Builds a span for an AST node. */
export function spanOf(sourceFile: ts.SourceFile, node: ts.Node, text?: string): BoundarySpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    text: text ?? node.getText(sourceFile),
  };
}
