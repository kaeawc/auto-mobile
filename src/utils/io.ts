import { promises as fsPromises } from "node:fs";

// Promisified fs functions
export const readFileAsync = fsPromises.readFile;
export const writeFileAsync = fsPromises.writeFile;
export const statAsync = fsPromises.stat;
export const readdirAsync = fsPromises.readdir;

// Additional promisified fs functions
export const renameAsync = fsPromises.rename;
export const unlinkAsync = fsPromises.unlink;
