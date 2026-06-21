import type {
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLObjectType,
} from "graphql";
import { HasAttributes } from "./has_attributes.js";
import type { Executor } from "./executor.js";
import type { ExecutionField } from "./execution_field.js";
import type { AbstractExecutionScope } from "./abstract_execution_scope.js";

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

/**
 * A concretely-typed scope holding fields to execute.
 */
export class ExecutionScope extends HasAttributes {
  executor: Executor;
  parentType: GraphQLObjectType;
  parentField: ExecutionField | null;
  selections: ReadonlyArray<SelectionNode>;

  // Mutated as breadth-first execution flows objects/results down the tree.
  _objects: unknown[];
  _results: Array<Record<string, unknown>>;

  abstraction: AbstractExecutionScope | null;
  path: ReadonlyArray<string>;
  fields: Map<string, ExecutionField>;
  executed = false;
  private _aborted = false;
  private _planningRoot: ExecutionScope | null = null;
  private _root: ExecutionScope | null = null;
  parent: ExecutionScope | null;

  constructor(options: {
    executor: Executor;
    parentType: GraphQLObjectType;
    selections: ReadonlyArray<SelectionNode>;
    objects: unknown[];
    results: Array<Record<string, unknown>>;
    abstraction?: AbstractExecutionScope | null;
    parentField?: ExecutionField | null;
  }) {
    super();
    this.executor = options.executor;
    this.parentType = options.parentType;
    this.parentField = options.parentField ?? null;
    this.selections = options.selections;
    this._objects = options.objects;
    this._results = options.results;
    this.abstraction = options.abstraction ?? null;
    this.path = options.parentField ? options.parentField.path : EMPTY_ARRAY;
    this.parent = options.parentField ? options.parentField.scope : null;
    this.fields = new Map();
  }

  get objects(): readonly unknown[] {
    return this._objects;
  }

  get results(): Array<Record<string, unknown>> {
    return this._results;
  }

  setObjects(objects: unknown[]): void {
    this._objects = objects;
  }

  setResults(results: Array<Record<string, unknown>>): void {
    this._results = results;
  }

  get root(): ExecutionScope {
    if (!this._root) {
      if (this.parent) {
        let next: ExecutionScope = this.parent;
        while (next.parent) next = next.parent;
        this._root = next;
      } else {
        this._root = this;
      }
    }
    return this._root;
  }

  // Highest non-executed scope in the current planning branch.
  // In abstract branches (built lazily), this is the abstraction point.
  get planningRoot(): ExecutionScope {
    if (!this._planningRoot) {
      if (this.parent) {
        let next: ExecutionScope = this.parent;
        while (next.parent) {
          if (next.abstraction) {
            this._planningRoot = next;
            return next;
          }
          next = next.parent;
        }
        this._planningRoot = next;
      } else {
        this._planningRoot = this;
      }
    }
    return this._planningRoot;
  }

  get depth(): number {
    return this.path.length;
  }

  get schemaPath(): ReadonlyArray<string> {
    return this.parentField ? this.parentField.schemaPath : EMPTY_ARRAY;
  }

  abort(): void {
    this._aborted = true;
  }

  aborted(): boolean {
    return this._aborted;
  }

  abortedSubtree(): boolean {
    if (this._aborted) return true;
    let field = this.parentField;
    while (field) {
      if (field.scope.aborted()) {
        this.abort();
        return true;
      }
      field = field.scope.parentField;
    }
    return false;
  }

  inspect(): string {
    return `#<ExecutionScope: [${this.path.join(", ")}]>`;
  }
}
