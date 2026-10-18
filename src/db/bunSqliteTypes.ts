import type { Database } from "bun:sqlite";

export type BunDatabase = Database;

export type BunStatement = ReturnType<BunDatabase["prepare"]>;
