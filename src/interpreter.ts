import {
  isAbstractType,
  isObjectType,
  type GraphQLAbstractType,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
} from "graphql";
import { ExecutionError, ImplementationError } from "./errors.ts";
import { ExecutionField } from "./executor/execution_field.ts";
import type { ResolverEntry, ResolverMap, TypeResolverFn } from "./executor/types.ts";
import { FieldResolver, ObjectKeyResolver, type ResolveResult } from "./field_resolvers.ts";
import { LazyLoader, type LazyLoaderConstructor } from "./lazy_loader.ts";
import { isThenable } from "./util.ts";

/**
 * graphql-js interpreter for the breadth-first executor. Runs conventional
 * `GraphQLFieldResolver<TSource, TContext>` functions inside the breadth model.
 *
 *   - `InterpretedFieldResolver` wraps a graphql-js resolver and invokes it
 *     per-object. Sync resolvers complete inline; any Promise returns are
 *     batched into `InterpretedPromiseLoader`, which awaits them all together as
 *     a single breadth-loader cycle. The field's final result is a fully
 *     resolved array — no Promises leak past the loader.
 *   - `interpretSchema(schema)` walks a `GraphQLSchema` and emits a
 *     `ResolverMap` whose entries delegate to each field's `resolve`
 *     (or `ObjectKeyResolver(fieldName)` when the field has no resolver).
 *   - Abstract types get a `__type__` entry that adapts
 *     `abstractType.resolveType` or falls back to walking
 *     `isTypeOf` on each possible type.
 *
 * Restrictions, surfaced as errors:
 *   - `info.path` — breadth-first execution resolves all objects at a level
 *     together, so there is no per-object resolution path. Accessing
 *     `info.path` throws an `ImplementationError`. All other
 *     `GraphQLResolveInfo` fields are populated for field resolvers.
 *   - Abstract type resolvers (`resolveType` / `isTypeOf`) still receive a
 *     stub `info` that throws on any access — the planner invokes them
 *     without an `ExecutionField` in scope.
 *   - Async `resolveType` / `isTypeOf` — abstract type discrimination must
 *     be synchronous. Returning a `Promise` throws an `ImplementationError`.
 */

function makeInfo(execField: ExecutionField): GraphQLResolveInfo {
  const executor = execField.executor;
  const info = {
    fieldName: execField.name,
    fieldNodes: execField.nodes,
    returnType: execField.type,
    parentType: execField.scope.parentType,
    schema: executor.schema,
    fragments: executor.fragments,
    rootValue: executor.rootObject,
    operation: executor.operation,
    variableValues: executor.variables,
  };
  Object.defineProperty(info, "path", {
    get(): never {
      throw new ImplementationError(
        `Interpreted resolver for '${execField.scope.parentType.name}.${execField.name}' ` +
          `accessed 'info.path', but breadth-first execution resolves all objects at a ` +
          `level together so there is no per-object resolution path. All other ` +
          `GraphQLResolveInfo fields are populated.`,
      );
    },
    enumerable: false,
    configurable: false,
  });
  return info as unknown as GraphQLResolveInfo;
}

/**
 * Awaits any native Promises produced by an `InterpretedFieldResolver`. Each Promise
 * is its own identity key, so distinct Promise instances are awaited
 * independently while shared instances dedupe. Rejections become field errors
 * keyed by the same Promise.
 */
export class InterpretedPromiseLoader extends LazyLoader {
  override async = true;

  override identityFor(key: unknown): unknown {
    return key;
  }

  override async performAsync(keys: unknown[]): Promise<void> {
    const settled = await Promise.allSettled(keys as Array<PromiseLike<unknown>>);
    for (let i = 0; i < keys.length; i++) {
      const result = settled[i] as PromiseSettledResult<unknown>;
      if (result.status === "fulfilled") {
        this.fulfillKey(keys[i], result.value);
      } else {
        const reason = result.reason;
        const err =
          reason instanceof Error
            ? ExecutionError.from(reason.message, { cause: reason })
            : ExecutionError.from(typeof reason === "string" ? reason : String(reason));
        this.fulfillKey(keys[i], err);
      }
    }
  }
}

export class InterpretedFieldResolver<TSource = unknown, TContext = unknown> extends FieldResolver<TContext> {
  private resolveFn: GraphQLFieldResolver<TSource, TContext>;

  constructor(resolveFn: GraphQLFieldResolver<TSource, TContext>) {
    super();
    this.resolveFn = resolveFn;
  }

  override resolve(execField: ExecutionField, context: TContext): ResolveResult {
    const args = execField.arguments;
    const info = makeInfo(execField);
    const objects = execField.objects;
    const results: unknown[] = new Array(objects.length);
    const promises: PromiseLike<unknown>[] = [];
    const promiseIndices: number[] = [];

    for (let i = 0; i < objects.length; i++) {
      let value: unknown;
      try {
        value = this.resolveFn(objects[i] as TSource, args, context, info);
      } catch (e) {
        // ImplementationError (e.g. info access) is intentionally rethrown to
        // fail loudly. Other Error subclasses surface as field errors so the
        // executor's handleOrReraise treats them like a graphql-shaped error.
        if (e instanceof ImplementationError) throw e;
        if (e instanceof Error) {
          results[i] = ExecutionError.from(e.message, { cause: e, execField });
          continue;
        }
        throw e;
      }
      if (isThenable(value)) {
        promiseIndices.push(i);
        promises.push(value);
        // Placeholder — overwritten when the loader resolves.
        results[i] = null;
      } else {
        results[i] = value;
      }
    }

    if (promises.length === 0) return results;

    return execField
      .lazy({
        loaderClass: InterpretedPromiseLoader as unknown as LazyLoaderConstructor,
        keys: promises as unknown[],
      })
      .then((awaited) => {
        const values = awaited as unknown[];
        for (let i = 0; i < promiseIndices.length; i++) {
          results[promiseIndices[i] as number] = values[i];
        }
        return results;
      });
  }

  override inspect(): string {
    return "InterpretedFieldResolver";
  }
}

/**
 * Adapts a graphql-js abstract type resolution policy (`abstractType.resolveType`
 * if defined, otherwise `isTypeOf` on each possible type) into the breadth
 * executor's `TypeResolverFn` shape.
 */
function buildAbstractTypeResolver(
  schema: GraphQLSchema,
  abstractType: GraphQLAbstractType,
): TypeResolverFn {
  const userResolveType = abstractType.resolveType;

  return (obj: unknown, context: unknown) => {
    if (userResolveType) {
      const info = makeAbstractInfoStub(abstractType);
      const result = userResolveType(obj, context, info, abstractType);
      if (isThenable(result)) {
        throw new ImplementationError(
          `resolveType for '${abstractType.name}' returned a Promise. ` +
            `Async type resolvers are not supported by the interpreter shim.`,
        );
      }
      if (result == null) return null;
      if (typeof result === "string") return schema.getType(result) ?? null;
      // graphql-js historically allows returning a type object directly even
      // though the typed signature says string. Pass it through.
      return (result as unknown) as GraphQLObjectType;
    }

    for (const possibleType of schema.getPossibleTypes(abstractType)) {
      const isTypeOf = possibleType.isTypeOf;
      if (!isTypeOf) continue;
      const info = makeAbstractInfoStub(abstractType);
      const matches = isTypeOf(obj, context, info);
      if (isThenable(matches)) {
        throw new ImplementationError(
          `isTypeOf for '${possibleType.name}' returned a Promise. ` +
            `Async type checks are not supported by the interpreter shim.`,
        );
      }
      if (matches) return possibleType;
    }
    return null;
  };
}

function makeAbstractInfoStub(abstractType: GraphQLAbstractType): GraphQLResolveInfo {
  return new Proxy(Object.freeze({}), {
    get(_target, prop) {
      throw new ImplementationError(
        `Type resolver for '${abstractType.name}' accessed 'info.${String(prop)}', ` +
          `but GraphQLResolveInfo is not implemented in the breadth executor's ` +
          `interpreter shim.`,
      );
    },
  }) as unknown as GraphQLResolveInfo;
}

export interface InterpretSchemaOptions {
  /**
   * When true, includes introspection types (those whose name starts with `__`)
   * in the output map. The breadth executor's planner already dispatches
   * introspection through `TYPE_RESOLVERS` before consulting the user's
   * `ResolverMap`, so the default (false) avoids redundant entries.
   */
  includeIntrospectionTypes?: boolean;
}

/**
 * Walk a `GraphQLSchema` and build a `ResolverMap` that delegates every field
 * to its graphql-js `resolve` (or `ObjectKeyResolver` when absent) and every
 * abstract type to a `__type__` entry adapted from `resolveType`/`isTypeOf`.
 *
 * Pass a second `overrides` map of native breadth resolvers to merge them
 * on top of the interpreted entries field-by-field. Override entries win
 * over the interpreted defaults, and types not present in the schema pass
 * through unchanged.
 *
 * The result is meant to be passed as the `resolvers` option of
 * `Executor.build`.
 */
export function interpretSchema(
  schema: GraphQLSchema,
  overrides: ResolverMap = {},
  options: InterpretSchemaOptions = {},
): ResolverMap {
  const includeIntrospection = !!options.includeIntrospectionTypes;
  const map: ResolverMap = {};

  for (const [typeName, type] of Object.entries(schema.getTypeMap())) {
    if (!includeIntrospection && typeName.startsWith("__")) continue;

    if (isObjectType(type)) {
      const entries: Record<string, ResolverEntry> = {};
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        entries[fieldName] = field.resolve
          ? new InterpretedFieldResolver(field.resolve)
          : new ObjectKeyResolver(fieldName);
      }
      map[typeName] = entries;
    } else if (isAbstractType(type)) {
      map[typeName] = { __type__: buildAbstractTypeResolver(schema, type) };
    }
  }

  for (const [typeName, typeEntries] of Object.entries(overrides)) {
    const existing = map[typeName];
    map[typeName] = existing ? { ...existing, ...typeEntries } : typeEntries;
  }

  return map;
}
