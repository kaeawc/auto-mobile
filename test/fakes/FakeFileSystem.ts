/**
 * Fake implementation of FileSystem for testing
 * Stores files in memory instead of interacting with the real file system
 */
import { FileSystem } from "../../src/utils/filesystem/DefaultFileSystem";

export class FakeFileSystem implements FileSystem {
  private files: Map<string, string> = new Map();
  private binaryFiles: Map<string, Buffer> = new Map();
  private directories: Set<string> = new Set();
  private existsSync_shouldExist: Map<string, boolean> = new Map();

  private normalizePath(value: string): string {
    return value.replace(/\\/g, "/");
  }

  private parentDir(normalizedPath: string): string {
    const idx = normalizedPath.lastIndexOf("/");
    return idx <= 0 ? "/" : normalizedPath.substring(0, idx);
  }

  private dirExists(normalizedDir: string): boolean {
    return normalizedDir === "" || normalizedDir === "/" || this.directories.has(normalizedDir);
  }

  private registerDirAndAncestors(normalizedDir: string): void {
    let current = normalizedDir;
    while (current && current !== "/" && !this.directories.has(current)) {
      this.directories.add(current);
      current = this.parentDir(current);
    }
  }

  private enoent(normalizedPath: string): NodeJS.ErrnoException {
    const error = new Error(
      `ENOENT: no such file or directory, '${normalizedPath}'`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return error;
  }

  /**
   * Set up a file to be read. Registers the containing directory (and ancestors)
   * so `readdir` of the parent lists this file — mirroring a real tree where a
   * file cannot exist without its directory.
   * @param filePath - Path to the file
   * @param content - Content of the file
   */
  setFile(filePath: string, content: string): void {
    const normalizedPath = this.normalizePath(filePath);
    this.files.set(normalizedPath, content);
    this.registerDirAndAncestors(this.parentDir(normalizedPath));
  }

  /**
   * Set up a directory to exist
   * @param dirPath - Path to the directory
   */
  setDirectory(dirPath: string): void {
    this.directories.add(this.normalizePath(dirPath));
  }

  /**
   * Configure whether a path exists (for existsSync)
   * @param filePath - Path to configure
   * @param exists - Whether it should exist
   */
  setExists(filePath: string, exists: boolean): void {
    this.existsSync_shouldExist.set(this.normalizePath(filePath), exists);
  }

  /**
   * Get history of written files
   * @returns Map of written files
   */
  getWrittenFiles(): Map<string, string> {
    return new Map(this.files);
  }

  /**
   * Get history of created directories
   * @returns Set of created directories
   */
  getCreatedDirectories(): Set<string> {
    return new Set(this.directories);
  }

  /**
   * Set up a binary file to be read
   * @param filePath - Path to the file
   * @param data - Binary content
   * @param mtimeMs - Optional modification time in ms
   */
  setBinaryFile(filePath: string, data: Buffer, mtimeMs?: number): void {
    const normalizedPath = this.normalizePath(filePath);
    this.binaryFiles.set(normalizedPath, data);
    this.registerDirAndAncestors(this.parentDir(normalizedPath));
    if (mtimeMs !== undefined) {
      this.fileMtimes.set(normalizedPath, mtimeMs);
    }
  }

  private fileMtimes: Map<string, number> = new Map();

  /**
   * Clear all stored state
   */
  clear(): void {
    this.files.clear();
    this.binaryFiles.clear();
    this.directories.clear();
    this.existsSync_shouldExist.clear();
    this.fileMtimes.clear();
  }

  // Implementation of FileSystem interface

  async readFile(filePath: string, encoding: string = "utf8"): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    const content = this.files.get(normalizedPath);
    if (content === undefined) {
      throw new Error(`File not found: ${normalizedPath}`);
    }
    return content;
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalizedDirPath = this.normalizePath(dirPath);
    if (!this.dirExists(normalizedDirPath)) {
      // A real readdir rejects a missing directory with ENOENT rather than
      // returning an empty list, so a caller cannot silently treat "absent" as
      // "empty".
      throw this.enoent(normalizedDirPath);
    }

    // Match on the directory BOUNDARY (`dir/`), not a raw substring, so
    // readdir("/a/str") never leaks the direct children of "/a/strings". Only
    // direct children (first path segment) are returned.
    const prefix = normalizedDirPath === "/" ? "/" : `${normalizedDirPath}/`;
    const names = new Set<string>();
    const collect = (candidate: string): void => {
      if (candidate.length <= prefix.length || !candidate.startsWith(prefix)) {
        return;
      }
      const firstSegment = candidate.substring(prefix.length).split("/")[0];
      if (firstSegment) {
        names.add(firstSegment);
      }
    };
    this.files.forEach((_, filePath) => collect(filePath));
    this.binaryFiles.forEach((_, filePath) => collect(filePath));
    this.directories.forEach((directory) => collect(directory));
    return [...names];
  }

  existsSync(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    // Check if explicitly configured
    if (this.existsSync_shouldExist.has(normalizedPath)) {
      return this.existsSync_shouldExist.get(normalizedPath) ?? false;
    }

    // Otherwise, check if file or directory exists
    return (
      this.files.has(normalizedPath) ||
      this.binaryFiles.has(normalizedPath) ||
      this.directories.has(normalizedPath)
    );
  }

  async pathExists(filePath: string): Promise<boolean> {
    return this.existsSync(filePath);
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const normalizedPath = this.normalizePath(filePath);
    const content = this.files.get(normalizedPath);
    if (content !== undefined) {
      // A real stat reports byte length; a string's `.length` counts UTF-16
      // units, so multibyte content (e.g. accented characters) would under- or
      // mis-report. Measure bytes.
      return {
        size: Buffer.byteLength(content, "utf8"),
        mtimeMs: this.fileMtimes.get(normalizedPath) ?? 0,
      };
    }
    const binaryContent = this.binaryFiles.get(normalizedPath);
    if (binaryContent !== undefined) {
      return { size: binaryContent.length, mtimeMs: this.fileMtimes.get(normalizedPath) ?? 0 };
    }
    throw new Error(`File not found: ${normalizedPath}`);
  }

  async readFileBuffer(filePath: string): Promise<Buffer> {
    const normalizedPath = this.normalizePath(filePath);
    const binaryContent = this.binaryFiles.get(normalizedPath);
    if (binaryContent !== undefined) {
      return binaryContent;
    }
    const content = this.files.get(normalizedPath);
    if (content !== undefined) {
      return Buffer.from(content);
    }
    throw new Error(`File not found: ${normalizedPath}`);
  }

  async writeFile(filePath: string, content: string, encoding: string = "utf8"): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    const parent = this.parentDir(normalizedPath);
    if (!this.dirExists(parent)) {
      // A real writeFile rejects when the target directory does not exist; the
      // fake must not silently materialize the file (and its missing parent).
      throw this.enoent(normalizedPath);
    }
    this.files.set(normalizedPath, content);
  }

  async writeFileBuffer(filePath: string, data: Buffer): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    const parent = this.parentDir(normalizedPath);
    if (!this.dirExists(parent)) {
      throw this.enoent(normalizedPath);
    }
    this.binaryFiles.set(normalizedPath, data);
  }

  async ensureDir(dirPath: string): Promise<void> {
    this.registerDirAndAncestors(this.normalizePath(dirPath));
  }

  async unlink(filePath: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    this.files.delete(normalizedPath);
    this.binaryFiles.delete(normalizedPath);
  }

  async remove(filePath: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    const childPrefix = `${normalizedPath}/`;
    // Recursive remove: drop the path itself AND every descendant file/dir, so
    // remove(dir) never orphans children the way `delete(dir)` alone did.
    for (const map of [this.files, this.binaryFiles]) {
      for (const key of [...map.keys()]) {
        if (key === normalizedPath || key.startsWith(childPrefix)) {
          map.delete(key);
        }
      }
    }
    for (const directory of [...this.directories]) {
      if (directory === normalizedPath || directory.startsWith(childPrefix)) {
        this.directories.delete(directory);
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);
    const content = this.files.get(normalizedOld);
    if (content !== undefined) {
      this.files.set(normalizedNew, content);
      this.files.delete(normalizedOld);
      return;
    }
    const binaryContent = this.binaryFiles.get(normalizedOld);
    if (binaryContent !== undefined) {
      this.binaryFiles.set(normalizedNew, binaryContent);
      this.binaryFiles.delete(normalizedOld);
      return;
    }
    if (this.directories.has(normalizedOld)) {
      this.directories.add(normalizedNew);
      this.directories.delete(normalizedOld);
      return;
    }
    throw new Error(`Path not found: ${normalizedOld}`);
  }
}
