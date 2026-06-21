import { ExecutionPromise } from "./executor/execution_promise.js";
import type { ExecutionField } from "./executor/execution_field.js";

export type ResolveResult = unknown[] | ExecutionPromise<unknown[]>;

/**
 * Base class for graphql-breadth field resolvers.
 *
 * Resolvers receive `exec_field` plus the request context, and return a list
 * of values aligned 1:1 with `exec_field.objects` (the breadth contract).
 *
 * @example
 * class MyResolver extends FieldResolver {
 *   resolve(execField, _context) {
 *     return execField.mapObjects((obj) => obj.title);
 *   }
 * }
 */
export abstract class FieldResolver<Ctx = unknown> {
  /**
   * Planning hook, invoked once per `ExecutionField` after the execution tree
   * is built and before any field on this level resolves. The executor walks
   * the tree bottom-up, so a field's children are planned before it is.
   *
   * Override to inspect the upcoming field shape and share state across the
   * planning pass — typically by writing to `execField.attributes` or to a
   * parent scope's attributes (`execField.scope.parent`,
   * `execField.planningRoot`). The default is a no-op.
   */
  plan(_execField: ExecutionField, _context: Ctx): unknown {
    return null;
  }

  /**
   * Resolve every object in `execField.objects` and return a list aligned 1:1
   * with that array. This is the breadth contract: returning fewer or more
   * values is a programming error. Most resolvers want
   * `execField.mapObjects((obj) => ...)` which handles the iteration.
   */
  abstract resolve(execField: ExecutionField, context: Ctx): ResolveResult;

  /**
   * Chain a callback onto a sync OR async resolver result without forcing the caller
   * to branch on the return type.
   */
  handleResolved(
    result: ResolveResult,
    handler: (results: unknown[]) => unknown[],
  ): ResolveResult {
    if (result instanceof ExecutionPromise) {
      return result.then((results) => handler(results as unknown[]));
    }
    return handler(result);
  }

  inspect(): string {
    return this.constructor.name;
  }
}

export class ObjectKeyResolver<Ctx = unknown> extends FieldResolver<Ctx> {
  key: string;

  constructor(key: string) {
    super();
    this.key = key;
  }

  override resolve(execField: ExecutionField, _context: Ctx): unknown[] {
    return execField.mapObjects((obj) => {
      if (obj == null) return null;
      return (obj as Record<string, unknown>)[this.key];
    });
  }

  override inspect(): string {
    return `ObjectKeyResolver(:${this.key})`;
  }
}

export class MethodResolver<Ctx = unknown> extends FieldResolver<Ctx> {
  methodNames: string[];
  private fallback: unknown;

  constructor(...methodNames: string[]);
  constructor(arg1: string, options: { fallback: unknown });
  constructor(...args: unknown[]) {
    super();
    let fallback: unknown = undefined;
    let names: string[];
    const last = args[args.length - 1];
    if (typeof last === "object" && last !== null && "fallback" in (last as object)) {
      fallback = (last as { fallback: unknown }).fallback;
      names = args.slice(0, -1) as string[];
    } else {
      names = args as string[];
    }
    if (names.length > 4) {
      throw new Error(
        `MethodResolver supports at most 4 methods, got ${names.length}. Use a custom resolver class instead.`,
      );
    }
    this.methodNames = names;
    this.fallback = fallback;
  }

  override resolve(execField: ExecutionField, _context: Ctx): unknown[] {
    return execField.mapObjects((obj) => this.chain(obj));
  }

  private chain(obj: unknown): unknown {
    let cur: unknown = obj;
    for (const name of this.methodNames) {
      if (cur == null) return this.fallback ?? cur;
      const cand = (cur as Record<string, unknown>)[name];
      cur = typeof cand === "function" ? (cand as () => unknown).call(cur) : cand;
    }
    return cur == null && this.fallback !== undefined ? this.fallback : cur;
  }

  override inspect(): string {
    return `MethodResolver(:${this.methodNames.join(", :")})`;
  }
}

export class SelfResolver<Ctx = unknown> extends FieldResolver<Ctx> {
  override resolve(execField: ExecutionField, _context: Ctx): unknown[] {
    return execField.mapObjects((o) => o);
  }
  override inspect(): string {
    return "SelfResolver";
  }
}

export class ValueResolver<Ctx = unknown> extends FieldResolver<Ctx> {
  value: unknown;
  constructor(value: unknown) {
    super();
    this.value = value;
  }
  override resolve(execField: ExecutionField, _context: Ctx): unknown[] {
    return execField.resolveAll(this.value);
  }
  override inspect(): string {
    return `ValueResolver(${JSON.stringify(this.value)})`;
  }
}
