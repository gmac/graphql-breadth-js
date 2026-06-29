# graphql-breadth

A basic breadth-first GraphQL executor based on [Shopify's Cardinal engine](https://shopify.engineering/faster-breadth-first-graphql-execution). Written in TypeScript, built on top of [graphql-js](https://github.com/graphql/graphql-js) for parsing, type system, and input coercion.

Unlike graphql-js depth traversal, this executor operates breadth-first: every object at a given depth resolves the same field together. This allows per-field overhead to amortize across the entire breadth of a level, and lets lazy loads batch using one Promise _per selection_ rather than _per field instance_.

Note that breadth traversal does still eagerly drill into nested field selections, so this execution model is no more blocking than standard (non-deferred) depth-based execution using Dataloader for batching.

_JavaScript implementation is experimental. No support for subscriptions, defer, and stream in this basic build._

## Benchmarks

**Speed:** single-machine numbers from `pnpm run bench:*` on an M2 MacBook Air, Node 22.

**GC pressure:** numbers from `pnpm run mem:*`. The metric is wall-clock time V8 spent in GC during the run, divided by iterations — a direct proxy for allocation volume. Lower is better. (Heap bytes/iter would be more direct, but V8 triggers GC mid-run on workloads this size, so GC time is the more reliable signal.)

_Some comparisons drop rows due to weak signal._

### Flat list

```graphql
query { widgets(first: N) { id } }
```

**Speed**

| size  | graphql-js | graphql-breadth | ratio                   |
| ----- | ---------- | --------------- | ----------------------- |
| 1     | 603k i/s   | 453k i/s        | graphql-js 1.33× faster |
| 10    | 157k i/s   | 236k i/s        | breadth 1.50× faster    |
| 100   | 20k i/s    | 42k i/s         | breadth 2.13× faster    |
| 1000  | 2.1k i/s   | 4.4k i/s        | breadth 2.13× faster    |
| 10000 | 202 i/s    | 449 i/s         | breadth 2.23× faster    |

**GC pressure**

| size  | graphql-js | graphql-breadth | ratio                   |
| ----- | ---------- | --------------- | ----------------------- |
| 100   | 1.9µs/iter | 0.7µs/iter      | breadth 2.80× less GC   |
| 1000  | 9.0µs/iter | 2.1µs/iter      | breadth 4.39× less GC   |
| 10000 | 239µs/iter | 31µs/iter       | breadth 7.71× less GC   |

### Tree within list

```graphql
# inner tree depth D
query { widgets(first: N) { widget { widget { id } id } id } }
```

**Speed**

| D × N    | graphql-js | graphql-breadth | ratio                |
| -------- | ---------- | --------------- | -------------------- |
| 1 × 10   | 87k i/s    | 162k i/s        | breadth 1.86× faster |
| 1 × 100  | 10k i/s    | 29k i/s         | breadth 2.79× faster |
| 1 × 1000 | 1.1k i/s   | 3.1k i/s        | breadth 2.90× faster |
| 5 × 10   | 25k i/s    | 45k i/s         | breadth 1.79× faster |
| 5 × 100  | 2.7k i/s   | 6.9k i/s        | breadth 2.56× faster |
| 5 × 1000 | 273 i/s    | 740 i/s         | breadth 2.71× faster |

**GC pressure**

| D × N    | graphql-js | graphql-breadth | ratio                 |
| -------- | ---------- | --------------- | --------------------- |
| 1 × 100  | 3.2µs/iter | 0.6µs/iter      | breadth 5.07× less GC |
| 1 × 1000 | 14µs/iter  | 3.7µs/iter      | breadth 3.94× less GC |
| 5 × 100  | 6.1µs/iter | 1.1µs/iter      | breadth 5.64× less GC |
| 5 × 1000 | 52µs/iter  | 12µs/iter       | breadth 4.20× less GC |

### List with batched lazy field (DataLoader promises)

```graphql
query { widgets(first: N) { id lazy } }  # N promises
```

**Speed**

| size  | graphql-js | graphql-breadth | ratio                |
| ----- | ---------- | --------------- | -------------------- |
| 1     | 285k i/s   | 290k i/s        | breadth 1.02× faster |
| 10    | 66k i/s    | 137k i/s        | breadth 2.10× faster |
| 100   | 7.9k i/s   | 22k i/s         | breadth 2.82× faster |
| 1000  | 758 i/s    | 2.4k i/s        | breadth 3.20× faster |
| 10000 | 47 i/s     | 244 i/s         | breadth 5.18× faster |

**GC pressure**

| size  | graphql-js   | graphql-breadth | ratio                 |
| ----- | ------------ | --------------- | --------------------- |
| 100   | 6.2µs/iter   | 0.3µs/iter      | breadth 18.7× less GC |
| 1000  | 110µs/iter   | 2.3µs/iter      | breadth 47.1× less GC |
| 10000 | 5247µs/iter  | 44µs/iter       | breadth 119× less GC  |

### Deep flat tree (no breadth)

```graphql
query { widget { widget { widget { id } id } id } }  # depth D
```

**Speed**

| depth | graphql-js | graphql-breadth | ratio                   |
| ----- | ---------- | --------------- | ----------------------- |
| 1     | 866k i/s   | 552k i/s        | graphql-js 1.57× faster |
| 5     | 235k i/s   | 120k i/s        | graphql-js 1.95× faster |
| 10    | 125k i/s   | 62k i/s         | graphql-js 2.02× faster |
| 18    | 69k i/s    | 34k i/s         | graphql-js 2.00× faster |

**GC pressure**

| depth | graphql-js | graphql-breadth | ratio                 |
| ----- | ---------- | --------------- | --------------------- |
| 1     | 0.3µs/iter | 0.2µs/iter      | breadth 1.22× less GC |
| 5     | 1.1µs/iter | 0.5µs/iter      | breadth 2.37× less GC |
| 10    | 1.2µs/iter | 0.4µs/iter      | breadth 2.89× less GC |
| 18    | 2.3µs/iter | 0.6µs/iter      | breadth 4.13× less GC |

### Where each executor wins

- **graphql-js wins on speed for deep, narrow queries** — every level holds one object, so breadth-first never engages, and graphql-js's tight inner loop runs unopposed. However, lacking repetition means the disadvantage doesn't scale, so is negligible (~15µs vs ~30µs as a one-time cost per query, even at depth 18).
- **graphql-breadth wins on speed once a level holds multiple objects**. The win grows with breadth (2–2.5× at 100+) because per-field work amortizes across the level instead of repeating per object.
- **graphql-breadth wins on GC pressure in every shape tested**, even the deep-narrow case where graphql-js wins on speed. One long-lived `ExecutionField` per level allocates less than one short-lived frame per resolution.
- **The lazy field case is the headline.** graphql-js + DataLoader pays a Promise per value per leaf; the breadth-first lazy queue drains synchronously inside the executor — no Promise allocations on the hot path. At 10k objects the GC gap is 119× (5247µs vs 44µs/iter), and graphql-js spends ~25% of its wall-clock in GC (5247µs of 21277µs/iter at 47 i/s).

Run the benchmarks yourself:

```bash
pnpm install
SIZES=1,10,100,1000,10000 pnpm run bench:list
FIELDS=lazy SIZES=1,10,100,1000,10000 pnpm run bench:list
DEPTHS=1,5,10,18 pnpm run bench:tree
DEPTHS=1,5 BREADTHS=10,100,1000 pnpm run bench:tree-list
pnpm run mem:tree
pnpm run mem:list
FIELDS=lazy pnpm run mem:list
pnpm run mem:tree-list
```

## Install

```bash
npm install graphql-breadth graphql
```

## Quick start

```ts
import { buildSchema } from "graphql";
import { Executor, ObjectKeyResolver } from "graphql-breadth";

const schema = buildSchema(`type Query { hello: String }`);

const { result } = Executor.build({
  schema,
  document: `{ hello }`,
  resolvers: {
    Query: {
      hello: new ObjectKeyResolver("hello"),
    },
  },
  rootObject: { hello: "world" },
});

console.log(result); // { data: { hello: "world" } }
```

An executor is built with a resolver map that keys `{ TypeName => { fieldName => new FieldResolver() } }` to provide all schema field resolvers. Additional options:

```ts
Executor.build({
  schema,           // GraphQLSchema (from graphql-js)
  document,         // string | DocumentNode
  resolvers,        // ResolverMap
  rootObject,       // unknown, optional
  context,          // unknown, optional - passed to resolvers
  variables,        // Record<string, unknown>, optional
  operationName,    // string | null, optional
  validateDocument, // boolean, default true - skip if pre-validated
});
```

## Resolvers

Resolvers receive an `execField` with all field state, including `objects`, `arguments`, and `context`. A resolver must return a mapped set of results derived from `execField.objects`. Returning results with unmatched cardinality is a programming error.

```ts
import { FieldResolver } from "graphql-breadth";
import type { ExecutionField } from "graphql-breadth";

class FullName extends FieldResolver {
  resolve(execField: ExecutionField) {
    if (!execField.context.authorized) return execField.resolveAll(null);

    return execField.mapObjects((user) => `${user.firstName} ${user.lastName}`);
  }
}
```

Built-in resolvers are provided to cover common cases:

```ts
import {
  ObjectKeyResolver, // obj[key]
  MethodResolver,  // obj.method() or obj.a.b.c
  SelfResolver,    // returns the object itself
  ValueResolver,   // returns a constant
} from "graphql-breadth";

const resolvers = {
  User: {
    id: new ObjectKeyResolver("id"),
    fullName: new FullName(),
    age: new MethodResolver("computeAge"),
    self: new SelfResolver(),
    apiVersion: new ValueResolver("v2"),
  },
};
```

## Errors

Map error instances into resolver results, or throw an `ExecutionError` within a `mapObjects` loop:

```ts
import { ExecutionError } from "graphql-breadth";

class SecretField extends FieldResolver {
  resolve(execField) {
    if (!execField.context.authenticated) throw new ExecutionError("Not authorized");

    return execField.mapObjects(
      (obj) => obj.allow() ? obj.secret : new ExecutionError("Not authorized"),
    );
  }
}
```

Raising an `ExecutionError` outside of `mapObjects` will fail the field across all objects. Unhandled exceptions will terminate all execution.

## Lazy batching

Breadth-based fields receive all `objects` at once, so are implicitly batched. However, lazy batching is still useful when pooling I/O across separate field selections. A `LazyLoader` can pool an entire key set into a single lazy promise. That means only one promise is built _per document selection_, versus _per field instance_ in graphql-js.

```ts
import { LazyLoader, FieldResolver } from "graphql-breadth";

class UserById extends LazyLoader {
  map = true; // perform returns results 1:1 with keys
  perform(ids: string[]): User[] {
    return db.usersWhereIdIn(ids); // one query for the entire level
  }
}

class Author extends FieldResolver {
  resolve(execField) {
    return execField.lazy({
      loaderClass: UserById,
      keys: execField.mapObjects((post) => post.authorId),
    });
  }
}
```

Two orthogonal flags configure how a loader delivers its results:

- `map` — when `true`, `perform`'s return value IS the mapped result array. When `false` (the default), the return value is ignored and the implementation calls `fulfillKey(key, result)` (or `fulfillIdentity`) for each key it resolves.
- `async` — when `true`, the loader implements `performAsync` instead of `perform`, and the executor awaits the returned Promise before resolving any waiting fields. When `false` (the default), `perform` runs synchronously and the executor drains the lazy queue without yielding to the microtask queue.

Async loaders are the canonical way to plug remote I/O into the breadth model. Because `performAsync` is called once per document selection — not per field instance — a list of N objects produces a single Promise, regardless of N:

```ts
class UserByIdAsync extends LazyLoader {
  async = true;
  map = true;
  async performAsync(ids: string[]): Promise<User[]> {
    return await db.usersWhereIdIn(ids); // one round-trip for the whole level
  }
}
```

When passing in lazy keys, null keys may be submitted to hold a results position. These will get dropped from the loader set and pass through as null results. Chain a post-load callback with `.then(...)`:

```ts
class AuthorName extends FieldResolver {
  resolve(execField) {
    return execField
      .lazy({ loaderClass: UserById, keys: ... })
      .then((users) => users.map((u) => u.name));
  }
}
```

Awaiting and chaining is also supported:

```ts
class FancyLazy extends FieldResolver {
  resolve(execField) {
    pendingPosts = execField
      .lazy({ loaderClass: UserById, keys: ... })
      .then((users) => execField.lazy({ loaderClass: PostsById, keys: users }));

    pendingPromos = execField
      .lazy({ loaderClass: PromosById, keys: ... })

    return execField.awaitAll([pendingPosts, pendingPromos])
      .then((posts, promos) => posts.zip(promos));
  }
}
```

## Abstract types

For interfaces and unions, attach a `__type__` resolver that maps an object to its concrete type:

```ts
const resolvers = {
  Character: {
    __type__: (obj) => obj.kind === "droid" ? schema.getType("Droid") : schema.getType("Human"),
    id: new ObjectKeyResolver("id"),
  },
};
```

Without `__type__`, the executor falls back to reading `__typename` off the object.

## Planning phase

Before execution begins, the planner walks the tree bottom-up and calls `plan()` on every field's resolver. A field's children plan first, so they can annotate their ancestors with dependency information. Both execution scopes and fields have an `attributes` Map for sharing state between resolvers in the same planning pass.

```ts
// Field resolver for `Widget.sprockets`.
// Plans first and annotates the scope's parent field to include sprockets.
class Sprockets extends FieldResolver {
  plan(execField) {
    // Tell the scope above to join sprockets.
    execField.scope.parentField.attributes.set("includeSprockets", true);
  }

  resolve(execField) {
    return execField.mapObjects((widget) => widget.sprockets);
  }
}

// Field resolver for `Query.widgets`.
// Can check itself for annotations passed upwards by children.
class Widgets extends FieldResolver {
  resolve(execField) {
    const includeSprockets = execField.attributes.get("includeSprockets") === true;
    return db.widgets({ join: includeSprockets ? ["sprockets"] : [] });
  }
}
```

## GraphQL JS resolvers

For schemas built with graphql-js's executable schema pattern (where each field carries a `resolve` function with the `(source, args, context, info)` signature), `interpretSchema` walks the schema and produces a `ResolverMap` whose entries delegate to those resolvers. Pass the result to `Executor.build` to run an existing graphql-js schema through the breadth executor unchanged:

```ts
import { Executor, interpretSchema } from "graphql-breadth";
import { schema } from "./my-graphql-js-schema";

const { result } = Executor.build({
  schema,
  document: `{ hero { name } }`,
  resolvers: interpretSchema(schema),
});
```

Mix interpreted and native resolvers by passing a breadth-native `ResolverMap` as the second argument. Entries are merged field-by-field over the interpreted defaults, so native resolvers retain their breadth-first advantages (single invocation per level, lazy batching, planning) while the rest of the schema runs through the per-object interpreter:

```ts
const resolvers = interpretSchema(schema, {
  User: {
    posts: new PostsLoader(), // batched native resolver
  },
});
```

**Support notes:**

- Resolvers that return native Promises are awaited together as one breadth-loader cycle via `InterpretedPromiseLoader`, so a list of N async resolvers still yields once, not N times. This is generally compatible though may produce different results for situations designed around a depth-based execution flow.
- Resolver `info.path` is the real, spec-compliant graphql-js `Path` (response keys plus list indices) for the object being resolved, reconstructed on demand via the executor's `PathFormatter`. Because breadth resolves a level all at once, the exact path of any single object is only known when asked for, so this is the "slow and precise" option — it indexes the scopes it walks, and is built lazily, so resolvers that never read `info.path` pay nothing. For a "fast and static" alternative, read `info.schemaPath` (cast `info` to `BreadthResolveInfo`): the field's schema-name ancestry with no aliases or indices — a dirt-cheap, stable key, which is what most path-keyed helpers (e.g. per-field DataLoader cache keys) actually want.
- No support for lazy abstract type resolution. `resolveType` and `isTypeOf` returning a `Promise` throw an `ImplementationError`.

## Development

```bash
pnpm install
pnpm test      # jest
pnpm run build # emits dist/
```
