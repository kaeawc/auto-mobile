import contract from "../../../schemas/prototype-spec-contract.json";

/** Which bound a charge crossed: one screen's render bound, or the whole-spec ceiling. */
export type PrototypeScreenBudgetOverflow = "nodes" | "images" | "specNodes" | "specImages";

interface Counts {
  nodes: number;
  images: number;
}

interface Scope {
  /** What the enclosing scopes draw beside this screen, fixed when it is entered. */
  base: Counts;
  own: Counts;
  /** Per closed stack, its largest screen extent; stacks drawn side by side add up. */
  children: Counts;
}

const zero = (): Counts => ({ nodes: 0, images: 0 });
const add = (a: Counts, b: Counts): Counts => ({
  nodes: a.nodes + b.nodes,
  images: a.images + b.images,
});

/**
 * Node and image budgets per stack screen (#14213). Renderers draw only a stack's top screen, so
 * each screen is charged its own subtree plus everything drawn with it: the content outside the
 * stack and, for a screen holding a nested stack, that stack's largest screen. Sibling screens
 * never count against each other. Every node and image also counts against the whole-spec
 * ceiling. A spec without a stack has one scope, which is today's whole-tree bound.
 */
export class PrototypeScreenBudget {
  private readonly scopes: Scope[] = [{ base: zero(), own: zero(), children: zero() }];
  private readonly stacks: Counts[] = [];
  private readonly total: Counts = zero();

  constructor(
    private readonly limits: {
      MAX_PROTOTYPE_NODES: number;
      MAX_PROTOTYPE_IMAGES: number;
      MAX_PROTOTYPE_SPEC_NODES: number;
      MAX_PROTOTYPE_SPEC_IMAGES: number;
    } = contract.limits,
  ) {}

  enterStack(): void {
    this.stacks.push(zero());
  }

  enterScreen(): void {
    const parent = this.current();
    this.scopes.push({
      base: add(add(parent.base, parent.own), parent.children),
      own: zero(),
      children: zero(),
    });
  }

  exitScreen(): void {
    const screen = this.scopes.pop()!;
    const extent = add(screen.own, screen.children);
    const stack = this.stacks[this.stacks.length - 1];
    stack.nodes = Math.max(stack.nodes, extent.nodes);
    stack.images = Math.max(stack.images, extent.images);
  }

  exitStack(): void {
    const parent = this.current();
    parent.children = add(parent.children, this.stacks.pop()!);
  }

  /** Charges nodes and images to the open screen; returns the first bound crossed. */
  charge(nodes: number, images: number): PrototypeScreenBudgetOverflow | undefined {
    const scope = this.current();
    scope.own.nodes += nodes;
    scope.own.images += images;
    this.total.nodes += nodes;
    this.total.images += images;
    const drawn = add(add(scope.base, scope.own), scope.children);
    if (drawn.nodes > this.limits.MAX_PROTOTYPE_NODES) {
      return "nodes";
    }
    if (this.total.nodes > this.limits.MAX_PROTOTYPE_SPEC_NODES) {
      return "specNodes";
    }
    if (drawn.images > this.limits.MAX_PROTOTYPE_IMAGES) {
      return "images";
    }
    return this.total.images > this.limits.MAX_PROTOTYPE_SPEC_IMAGES ? "specImages" : undefined;
  }

  private current(): Scope {
    return this.scopes[this.scopes.length - 1];
  }
}

/** The validation message for an overflow; `expanded` prefixes the repeat-expansion wording. */
export function prototypeScreenBudgetMessage(
  overflow: PrototypeScreenBudgetOverflow,
  expanded = false,
): string {
  const message = {
    nodes: "Node limit exceeded",
    images: "Image limit exceeded",
    specNodes: "Spec node limit exceeded",
    specImages: "Spec image limit exceeded",
  }[overflow];
  return expanded ? `Expanded ${message[0].toLowerCase()}${message.slice(1)}` : message;
}
