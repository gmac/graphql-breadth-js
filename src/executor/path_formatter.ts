import { type GraphQLOutputType } from "graphql";
import { isListLike, unwrapNonNull } from "../util.ts";
import type { ExecutionField } from "./execution_field.ts";
import type { ExecutionScope } from "./execution_scope.ts";

/**
 * graphql-js does not publicly export its `Path` type, so model its shape
 * (`{ prev, key, typename }`) locally — this is what `GraphQLResolveInfo.path` is.
 * `key` is a response key (field alias) for field segments and a numeric index
 * for list segments; `typename` is the concrete object type a field segment was
 * selected on (and `undefined` for list-index segments), matching graphql-js'
 * `addPath(prev, key, parentType.name)` semantics.
 */
export interface ResolvePath {
  readonly prev: ResolvePath | undefined;
  readonly key: string | number;
  readonly typename: string | undefined;
}

/**
 * For each object position in a scope, the "object path suffix" relative to the
 * scope's parent: `[parentObjectIndex, listIndex1, listIndex2, ...]`. The first
 * element recalibrates to the parent scope's object position; the remaining
 * elements are the (real, null-inclusive) list indices wrapping this object.
 */
type ScopeIndex = ReadonlyArray<ReadonlyArray<number>>;

/**
 * Builds the *real*, spec-compliant object path to a specific breadth object
 * position — e.g. `["products", 0, "variants", 1]`. This is the precise path
 * graphql-js would expose on `info.path`, complete with list indices.
 *
 * Breadth-first execution resolves every object at a level together, so the
 * exact path of any single object is not known until it's asked for. Computing
 * it requires indexing each scope: walking the parent field's (possibly nested,
 * list-wrapped) result to recover, for every surviving object, its parent
 * object position and the list indices that wrap it. That indexing is real
 * overhead, so it is done lazily — and only for the scopes on the path actually
 * requested — and memoized per scope. This is the "slow and precise" path; the
 * cheap, static alternative is `ExecutionField.schemaPath`.
 *
 * Ported from graphql-breadth-exec's `Executor::PathFormatter`, with one
 * addition: abstract-type scopes bucket their objects by concrete type, so the
 * parent field's result order does not line up 1:1 with a concrete scope's
 * objects. Indexing distributes the result-order suffixes back to each concrete
 * sibling scope by object identity, preserving real list indices per bucket.
 */
export class PathFormatter {
  // Identity-keyed (Map uses object identity for keys), matching the Ruby
  // formatter's `compare_by_identity`.
  private indicesByScope = new Map<ExecutionScope, ScopeIndex>();

  /**
   * The precise object path to the object at `index` within `scope.objects`,
   * as a flat array of response keys and list indices (the shape used for
   * spec `errors[].path`). Walks ancestor scopes, prepending each scope's
   * response key and list indices.
   */
  objectPath(scope: ExecutionScope, index: number): Array<string | number> {
    const path: Array<string | number> = [];
    let current: ExecutionScope | null = scope;
    let breadthIndex = index;

    while (current) {
      const suffix = this.indexFor(current)[breadthIndex] ?? [breadthIndex];
      // List indices (suffix[1..]) sit after the field key; prepend them so the
      // segment ends up as `[key, listIndex1, listIndex2, ...]`.
      for (let i = suffix.length - 1; i >= 1; i--) path.unshift(suffix[i] as number);
      const key = current.parentField?.key;
      if (key != null) path.unshift(key);
      breadthIndex = (suffix[0] as number) ?? 0;
      current = current.parent;
    }

    return path;
  }

  /**
   * The graphql-js `info.path` (a `{ prev, key, typename }` linked list) for a
   * field resolver running against the object at `index` within
   * `execField.scope`. This is the path to that source object plus the field's
   * own response key as the deepest segment.
   */
  resolveInfoPath(execField: ExecutionField, index: number): ResolvePath {
    // Collect segments deepest-first, then reverse into root→leaf order.
    const segments: Array<{ key: string | number; typename: string | undefined }> = [];
    let current: ExecutionScope | null = execField.scope;
    let breadthIndex = index;

    while (current) {
      const suffix = this.indexFor(current)[breadthIndex] ?? [breadthIndex];
      for (let i = suffix.length - 1; i >= 1; i--) {
        segments.push({ key: suffix[i] as number, typename: undefined });
      }
      const parentField = current.parentField;
      if (parentField) {
        // A field segment's typename is the concrete type the field was
        // selected on — i.e. the parent scope's object type.
        segments.push({ key: parentField.key, typename: parentField.scope.parentType.name });
      }
      breadthIndex = (suffix[0] as number) ?? 0;
      current = current.parent;
    }

    segments.reverse();
    // The field being resolved contributes the deepest segment. It has no list
    // index yet (its value is what the resolver is about to produce).
    segments.push({ key: execField.key, typename: execField.scope.parentType.name });

    let path: ResolvePath | undefined;
    for (const segment of segments) {
      path = { prev: path, key: segment.key, typename: segment.typename };
    }
    return path as ResolvePath;
  }

  /**
   * The per-object path suffixes for a scope, computed and memoized on first
   * access. Row `i` is the suffix for `scope.objects[i]`.
   */
  private indexFor(scope: ExecutionScope): ScopeIndex {
    const cached = this.indicesByScope.get(scope);
    if (cached) return cached;

    const parentField = scope.parentField;
    const parentObjects = (parentField ? parentField.result : scope.objects) as ReadonlyArray<unknown>;
    const currentType: GraphQLOutputType = parentField ? parentField.type : scope.parentType;

    // Walk the parent result in order, emitting a suffix per surviving leaf
    // object. `tupleObjects[k]` is the object that produced `tuples[k]`.
    const tuples: number[][] = [];
    const tupleObjects: unknown[] = [];
    for (let i = 0; i < parentObjects.length; i++) {
      this.buildIndices(currentType, parentObjects[i], [i], tuples, tupleObjects);
    }

    let rows: number[][];
    if (scope.abstraction) {
      // Abstract scopes are one type bucket of the parent result. Distribute the
      // result-order suffixes to this scope's objects by identity, in order —
      // an object resolves to exactly one concrete type, so its bucket is
      // unambiguous, and a duplicated instance stays within its bucket's order.
      const objects = scope.objects;
      rows = new Array(objects.length);
      let ptr = 0;
      for (let k = 0; k < tuples.length && ptr < objects.length; k++) {
        if (tupleObjects[k] === objects[ptr]) rows[ptr++] = tuples[k] as number[];
      }
    } else {
      // Non-abstract scopes flat-map the parent result 1:1 in order.
      rows = tuples;
    }

    this.indicesByScope.set(scope, rows);
    return rows;
  }

  /**
   * Recursively walk a (possibly list-wrapped) value, recording an index suffix
   * for each surviving leaf object. List positions are pushed onto `objectPath`
   * so that `objectPath` reads `[parentIndex, listIndex1, listIndex2, ...]` at
   * each leaf. Nulls and errors produce no object (and no suffix), but their
   * list slots still advance the index, so survivors keep their real positions.
   */
  private buildIndices(
    currentType: GraphQLOutputType,
    object: unknown,
    objectPath: number[],
    tuples: number[][],
    tupleObjects: unknown[],
  ): void {
    if (object == null || object instanceof Error) return;

    if (isListLike(currentType)) {
      if (!Array.isArray(object)) return;
      const elementType = (unwrapNonNull(currentType) as { ofType: GraphQLOutputType }).ofType;
      for (let i = 0; i < object.length; i++) {
        objectPath.push(i);
        this.buildIndices(elementType, object[i], objectPath, tuples, tupleObjects);
        objectPath.pop();
      }
    } else {
      tuples.push(objectPath.slice());
      tupleObjects.push(object);
    }
  }
}
