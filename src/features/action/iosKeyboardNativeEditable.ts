import type { ElementBounds } from "../../models/ElementBounds";

/**
 * Safari's address field is a native editable that owns the keyboard without a focused flag, while
 * the page's own focused field keeps its value. When one native editable is the only editable
 * sitting above an on-screen UIKeyboard, it is the keyboard owner and its value is the clear
 * target's value.
 */
export class IosKeyboardNativeEditableTracker {
  private readonly editables: { value: string; bounds: ElementBounds }[] = [];
  private keyboardTop: number | undefined;

  recordKeyboard(bounds: ElementBounds | null): void {
    if (bounds) {
      this.keyboardTop = Math.min(this.keyboardTop ?? bounds.top, bounds.top);
    }
  }

  recordEditable(value: string, bounds: ElementBounds | null): void {
    if (bounds) {
      this.editables.push({ value, bounds });
    }
  }

  /** The sole editable above the keyboard, or undefined when absent or ambiguous. */
  soleValueAboveKeyboard(): string | undefined {
    const keyboardTop = this.keyboardTop;
    if (keyboardTop === undefined) {
      return undefined;
    }
    const above = this.editables.filter((editable) => editable.bounds.bottom <= keyboardTop);
    return above.length === 1 ? above[0].value : undefined;
  }
}
