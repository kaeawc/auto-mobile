import { homedir } from "node:os";
import { redactHomeDir } from "../redactPath";

const CREDENTIAL_KEY = String.raw`(?:(?:[A-Za-z0-9]+[._-])*(?:token|password|secret|api[_-]?key)|access[_-]?token|client[_-]?secret)`;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`\b(${CREDENTIAL_KEY})\s*[:=]\s*(?:"(?:\\.|[^"])*(?:"|$)|'(?:\\.|[^'])*(?:'|$)|[^\s]+)`,
  "gi",
);
const CREDENTIAL_ASSIGNMENT_START = new RegExp(String.raw`\b(${CREDENTIAL_KEY})\s*[:=]\s*`, "i");

type CredentialValueState =
  | { kind: "awaiting" }
  | { kind: "unquoted" }
  | { kind: "quoted"; quote: string; escaping: boolean };

export function redactAndroidCommandOutput(value: string, home: string = homedir()): string {
  const redactedSecrets = value.replace(
    CREDENTIAL_ASSIGNMENT,
    (_match, key: string) => `${key}=[REDACTED]`,
  );
  const redactedLeadingHome = redactHomeDir(redactedSecrets, home);
  return home.length > 0 ? redactedLeadingHome.replaceAll(home, "~") : redactedLeadingHome;
}

/**
 * Redacts command output incrementally without treating stream chunks as records.
 *
 * Credential values are discarded as they arrive, so neither a chunk boundary nor
 * a line break inside a quoted value can leak data into the emitted output.
 */
export class AndroidCommandOutputStreamRedactor {
  private pending = "";
  private credentialValueState: CredentialValueState | undefined;
  private readonly pendingPrefixLength: number;

  constructor(private readonly home: string = homedir()) {
    this.pendingPrefixLength = Math.max(128, home.length);
  }

  append(value: string): string {
    this.pending += value;
    return this.consume(false);
  }

  flush(): string {
    return this.consume(true);
  }

  /**
   * Returns a safe view of the uncommitted non-secret suffix for classification.
   */
  snapshot(): string {
    return this.credentialValueState ? "" : redactAndroidCommandOutput(this.pending, this.home);
  }

  private consume(flush: boolean): string {
    let emitted = "";
    while (this.pending.length > 0) {
      if (this.credentialValueState) {
        if (!this.consumeCredentialValue(flush)) {
          break;
        }
        continue;
      }

      const assignment = this.pending.match(CREDENTIAL_ASSIGNMENT_START);
      if (assignment && assignment.index !== undefined) {
        emitted += redactAndroidCommandOutput(this.pending.slice(0, assignment.index), this.home);
        emitted += `${assignment[1]}=[REDACTED]`;
        this.pending = this.pending.slice(assignment.index + assignment[0].length);
        this.credentialValueState = { kind: "awaiting" };
        continue;
      }

      const safeLength = flush
        ? this.pending.length
        : Math.max(0, this.pending.length - this.pendingPrefixLength);
      if (safeLength === 0) {
        break;
      }
      emitted += redactAndroidCommandOutput(this.pending.slice(0, safeLength), this.home);
      this.pending = this.pending.slice(safeLength);
    }
    return emitted;
  }

  private consumeCredentialValue(flush: boolean): boolean {
    if (this.credentialValueState?.kind === "awaiting") {
      if (this.pending.length === 0) {
        return false;
      }
      const quote = this.pending[0];
      if (quote === '"' || quote === "'") {
        this.pending = this.pending.slice(1);
        this.credentialValueState = { kind: "quoted", quote, escaping: false };
      } else {
        this.credentialValueState = { kind: "unquoted" };
      }
      return true;
    }

    if (this.credentialValueState?.kind === "quoted") {
      const quotedValue = this.findClosingQuote(
        this.credentialValueState.quote,
        this.credentialValueState.escaping,
      );
      if (quotedValue.closingQuote === -1) {
        this.pending = "";
        if (flush) {
          this.credentialValueState = undefined;
        } else {
          this.credentialValueState = {
            ...this.credentialValueState,
            escaping: quotedValue.trailingEscape,
          };
        }
        return false;
      }
      this.pending = this.pending.slice(quotedValue.closingQuote + 1);
      this.credentialValueState = undefined;
      return true;
    }

    const valueTerminator = this.pending.search(/\s/);
    if (valueTerminator === -1) {
      this.pending = "";
      if (flush) {
        this.credentialValueState = undefined;
      }
      return false;
    }
    this.pending = this.pending.slice(valueTerminator);
    this.credentialValueState = undefined;
    return true;
  }

  private findClosingQuote(
    quote: string,
    escaped: boolean,
  ): { closingQuote: number; trailingEscape: boolean } {
    for (let index = 0; index < this.pending.length; index += 1) {
      const character = this.pending[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return { closingQuote: index, trailingEscape: false };
      }
    }
    return { closingQuote: -1, trailingEscape: escaped };
  }
}
