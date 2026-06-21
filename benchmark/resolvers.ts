import {
  FieldResolver,
  LazyLoader,
  type ResolverMap,
} from "../src/index.ts";
import type { ExecutionField } from "../src/executor/execution_field.ts";
import type { ExecutionPromise } from "../src/executor/execution_promise.ts";

// Generic key-based property accessor: reads exec_field.key off each object.
// Used for id/string/integer/boolean/widget/widgets/resolveByMethod.
export class FieldKeyResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const key = execField.key;
    return execField.mapObjects((obj) => {
      if (obj == null) return null;
      return (obj as Record<string, unknown>)[key];
    });
  }
}

// Batched lazy loader. `map = true` means perform returns results 1:1 with pending keys.
export class BreadthBatchLoader extends LazyLoader {
  override map = true;
  private key: string;

  constructor(args: { key: string }) {
    super();
    this.key = args.key;
  }

  // Identity by reference.
  override identityFor(obj: unknown): unknown {
    return obj;
  }

  override perform(keys: unknown[]): unknown[] {
    const k = this.key;
    return keys.map((obj) => (obj as Record<string, unknown>)[k]);
  }
}

export class LazyFieldResolver extends FieldResolver {
  override resolve(execField: ExecutionField): ExecutionPromise<unknown[]> {
    return execField.lazy({
      loaderClass: BreadthBatchLoader,
      args: { key: "lazy" },
      keys: [...execField.objects],
    });
  }
}

export class LazyThenFieldResolver extends FieldResolver {
  override resolve(execField: ExecutionField): ExecutionPromise<unknown[]> {
    return execField
      .lazy({
        loaderClass: BreadthBatchLoader,
        args: { key: "lazyThen" },
        keys: [...execField.objects],
      })
      .then((results) =>
        (results as unknown[]).map((v) =>
          typeof v === "string" ? v.toUpperCase() : v,
        ),
      );
  }
}

const fieldKey = new FieldKeyResolver();
const lazyResolver = new LazyFieldResolver();
const lazyThenResolver = new LazyThenFieldResolver();

export const breadthResolvers: ResolverMap = {
  Widget: {
    id: fieldKey,
    string: fieldKey,
    integer: fieldKey,
    boolean: fieldKey,
    widget: fieldKey,
    widgets: fieldKey,
    resolveByMethod: fieldKey,
    lazy: lazyResolver,
    lazyThen: lazyThenResolver,
  },
  Query: {
    widget: fieldKey,
    widgets: fieldKey,
  },
};
