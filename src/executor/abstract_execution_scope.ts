import type { GraphQLAbstractType } from "graphql";
import type { ExecutionField } from "./execution_field.ts";
import type { ExecutionScope } from "./execution_scope.ts";
import type { Executor } from "./executor.ts";

/**
 * An abstract type holding the concrete execution scopes it resolved.
 * For execution taxonomy reference only, has no direct execution purpose.
 */
export class AbstractExecutionScope {
  parentType: GraphQLAbstractType;
  parentField: ExecutionField;
  scopes: ExecutionScope[];
  private _objects: ReadonlyArray<unknown> | null = null;
  private _results: ReadonlyArray<Record<string, unknown>> | null = null;

  constructor(options: {
    parentType: GraphQLAbstractType;
    parentField: ExecutionField;
    scopes: ExecutionScope[];
  }) {
    this.parentType = options.parentType;
    this.parentField = options.parentField;
    this.scopes = options.scopes;
  }

  get executor(): Executor {
    return this.parentField.executor;
  }

  get parent(): ExecutionScope {
    return this.parentField.scope;
  }

  get path(): ReadonlyArray<string> {
    return this.parentField.path;
  }

  get depth(): number {
    return this.parentField.depth;
  }

  get objects(): ReadonlyArray<unknown> {
    return (this._objects ??= this.scopes.flatMap((s) => s.objects as unknown[]));
  }

  get results(): ReadonlyArray<Record<string, unknown>> {
    return (this._results ??= this.scopes.flatMap((s) => s.results));
  }
}
