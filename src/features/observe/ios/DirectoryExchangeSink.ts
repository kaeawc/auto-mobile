import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExchangeSink } from "./CtrlProxyExchangeRecorder";

export class DirectoryExchangeSink implements ExchangeSink {
  private created = false;

  constructor(private readonly directory: string) {}

  write(fileName: string, contents: string): void {
    if (!this.created) {
      mkdirSync(this.directory, { recursive: true });
      this.created = true;
    }
    writeFileSync(path.join(this.directory, fileName), contents);
  }
}
