import {
  isListType,
  isNonNullType,
  type FieldNode,
  type GraphQLField,
  type GraphQLOutputType,
  type SelectionNode as GqlSelectionNode,
} from "graphql";
import { ExecutionError, ExecutionErrorSet } from "../errors.js";
import { ExecutionPromise } from "./execution_promise.js";
import { HasAttributes } from "./has_attributes.js";
import { type LazyLoaderConstructor } from "../lazy_loader.js";
import type { ExecutionScope } from "./execution_scope.js";
import type { Executor } from "./executor.js";
import type { FieldResolver } from "../field_resolvers.js";

/**
 * A field to execute. This is the primary unit of
 * execution taxonomy given to all field resolvers to work from.
 */
export class ExecutionField extends HasAttributes {
  key: string;
  name: string;
  path: ReadonlyArray<string>;
  scope: ExecutionScope;
  type: GraphQLOutputType;
  definition: GraphQLField<unknown, unknown>;
  resolver: FieldResolver;
  arguments: Record<string, unknown>;
  nodes: ReadonlyArray<FieldNode>;
  result: unknown = null;
  private _schemaPath: ReadonlyArray<string> | null = null;
  private _argumentErrors: ExecutionError[];

  constructor(
    key: string,
    options: {
      nodes: ReadonlyArray<FieldNode>;
      scope: ExecutionScope;
      definition: GraphQLField<unknown, unknown>;
      resolver: FieldResolver;
      args: Record<string, unknown>;
      argumentErrors?: ExecutionError[];
    },
  ) {
    super();
    this.key = key;
    this.name = options.definition.name;
    this.nodes = options.nodes;
    this.scope = options.scope;
    this.definition = options.definition;
    this.resolver = options.resolver;
    this.type = options.definition.type;
    this.path = [...options.scope.path, key];
    this.arguments = options.args;
    this._argumentErrors = options.argumentErrors ?? [];
  }

  get executor(): Executor {
    return this.scope.executor;
  }

  get context(): Record<string, unknown> {
    return this.executor.context;
  }

  get planningRoot(): ExecutionScope {
    return this.scope.planningRoot;
  }

  get root(): ExecutionScope {
    return this.scope.root;
  }

  get objects(): readonly unknown[] {
    return this.scope.objects;
  }

  get depth(): number {
    return this.path.length;
  }

  get schemaPath(): ReadonlyArray<string> {
    if (!this._schemaPath) {
      this._schemaPath = [...this.scope.schemaPath, this.name];
    }
    return this._schemaPath;
  }

  validate(): void {
    if (this._argumentErrors.length > 0) {
      throw new ExecutionErrorSet(undefined, {
        execField: this,
        errors: this._argumentErrors,
      });
    }
  }

  hasResult(): boolean {
    return this.result != null;
  }

  lazyResult(): boolean {
    return this.result instanceof ExecutionPromise;
  }

  lazy(options: {
    loaderClass: LazyLoaderConstructor;
    keys: unknown[];
    args?: Record<string, unknown> | null;
    eager?: Map<unknown, unknown> | null;
    loadNilKeys?: boolean;
  }): ExecutionPromise<unknown[]> {
    const loader = this.executor.lazyLoaderFor(options.loaderClass, options.args ?? undefined);
    return loader.load({
      field: this,
      keys: options.keys,
      eager: options.eager ?? null,
      loadNilKeys: options.loadNilKeys ?? false,
    });
  }

  awaitAll(promises: ExecutionPromise<unknown>[]): ExecutionPromise<unknown[]> {
    return ExecutionPromise.all(promises);
  }

  handleOrReraise(error: unknown): ExecutionError {
    return this.executor.handleOrReraise(error, this);
  }

  mapObjects<T>(fn: (obj: unknown) => T | ExecutionError): Array<T | ExecutionError> {
    return this.objects.map((obj) => {
      try {
        return fn(obj);
      } catch (e) {
        return this.handleOrReraise(e);
      }
    });
  }

  mapObjectsWithIndex<T>(
    fn: (obj: unknown, index: number) => T | ExecutionError,
  ): Array<T | ExecutionError> {
    return this.objects.map((obj, i) => {
      try {
        return fn(obj, i);
      } catch (e) {
        return this.handleOrReraise(e);
      }
    });
  }

  resolveAll<T>(value: T | unknown): Array<T | ExecutionError | unknown> {
    let v: unknown = value;
    if (v instanceof Error) {
      v = this.handleOrReraise(v);
    }
    return new Array(this.objects.length).fill(v);
  }

  selections(): ReadonlyArray<GqlSelectionNode> {
    if (this.nodes.length > 1) {
      return this.nodes.flatMap((n) => n.selectionSet?.selections ?? []);
    }
    return this.nodes[0]?.selectionSet?.selections ?? [];
  }

  /** True if a null result here must propagate up the tree per non-null wrappings. */
  propagatesNull(): boolean {
    let type: GraphQLOutputType = this.type;
    if (!isNonNullType(type) && !isListType(type)) return false;

    // Walk through list wrappings: e.g. [Node!]! -> Node!
    while (isListType(type) || (isNonNullType(type) && isListType(type.ofType))) {
      if (!isNonNullType(type)) return false; // non-null list?
      // unwrap non-null then list
      let inner = type.ofType;
      if (isListType(inner)) inner = inner.ofType;
      type = inner as GraphQLOutputType;
    }

    return isNonNullType(type);
  }

  inspect(): string {
    const alias = this.key !== this.name ? `${this.key} => ` : "";
    return `#<ExecutionField: ${alias}${this.scope.parentType.name}.${this.name}>`;
  }
}
