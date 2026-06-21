import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  buildSchema,
} from "graphql";
import {
  Executor,
  FieldResolver,
  ImplementationError,
  LazyLoader,
  InterpretedFieldResolver,
  InterpretedPromiseLoader,
  interpretSchema,
  type GraphQLResult,
  type LazyLoaderConstructor,
  type ResolveResult,
  type ResolverMap,
} from "../../src/index.js";
import type { ExecutionField } from "../../src/executor/execution_field.js";

type ExecuteOptions = {
  rootObject?: unknown;
  variables?: Record<string, unknown>;
  resolvers?: ResolverMap;
  context?: Record<string, unknown>;
};

function execute(
  schema: GraphQLSchema,
  document: string,
  options: ExecuteOptions = {},
): GraphQLResult {
  return Executor.build({
    schema,
    document,
    rootObject: options.rootObject ?? null,
    variables: options.variables ?? {},
    resolvers: options.resolvers ?? interpretSchema(schema),
    context: options.context ?? {},
  }).resultSync;
}

function executeAsync(
  schema: GraphQLSchema,
  document: string,
  options: ExecuteOptions = {},
): Promise<GraphQLResult> {
  return Promise.resolve(
    Executor.build({
      schema,
      document,
      rootObject: options.rootObject ?? null,
      variables: options.variables ?? {},
      resolvers: options.resolvers ?? interpretSchema(schema),
      context: options.context ?? {},
    }).result,
  );
}

describe("graphql-js interpreter shim", () => {
  describe("InterpretedFieldResolver", () => {
    test("invokes a sync resolver once per object and returns its values", () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            ping: { type: GraphQLString, resolve: () => "pong" },
            uppered: {
              type: new GraphQLList(GraphQLString),
              args: { values: { type: new GraphQLList(GraphQLString) } },
              resolve: (_src, args) =>
                ((args["values"] as string[]) ?? []).map((s) => s.toUpperCase()),
            },
          },
        }),
      });

      const result = execute(schema, `{ ping uppered(values: ["a", "b", "c"]) }`);
      assert.deepStrictEqual(result, { data: { ping: "pong", uppered: ["A", "B", "C"] } });
    });

    test("receives args and context, in graphql-js argument order", () => {
      const seen: Array<{ source: unknown; args: unknown; context: unknown }> = [];
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            echo: {
              type: GraphQLString,
              args: { value: { type: GraphQLString } },
              resolve: (source, args, context) => {
                seen.push({ source, args, context });
                return args["value"] as string;
              },
            },
          },
        }),
      });

      const result = execute(schema, `{ echo(value: "hi") }`, {
        rootObject: { tag: "root" },
        context: { user: "ada" },
      });

      assert.deepStrictEqual(result, { data: { echo: "hi" } });
      assert.deepStrictEqual(seen, [
        { source: { tag: "root" }, args: { value: "hi" }, context: { user: "ada" } },
      ]);
    });

    test("falls back to ObjectKeyResolver when a field has no resolve", () => {
      const schema = buildSchema(`
        type Widget { sku: String, label: String }
        type Query { widget: Widget }
      `);
      const widget = { sku: "abc-123", label: "Hello" };
      const result = execute(schema, `{ widget { sku label } }`, {
        rootObject: { widget },
      });
      assert.deepStrictEqual(result, { data: { widget: { sku: "abc-123", label: "Hello" } } });
    });

    test("an error thrown by an interpreted resolver surfaces as a field error", () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            boom: {
              type: GraphQLString,
              resolve: () => {
                throw new Error("interpreted boom");
              },
            },
          },
        }),
      });

      const result = execute(schema, `{ boom }`);
      assert.deepStrictEqual(result.data, { boom: null });
      assert.strictEqual(result.errors?.[0]?.message, "interpreted boom");
    });

    test("the info argument is populated with field, schema, and document state", () => {
      const captured: Record<string, unknown> = {};
      const userType = new GraphQLObjectType({
        name: "User",
        fields: {
          name: { type: GraphQLString },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            user: {
              type: userType,
              args: { id: { type: new GraphQLNonNull(GraphQLString) } },
              resolve: (_src, _args, _ctx, info) => {
                captured.fieldName = info.fieldName;
                captured.fieldNodes = info.fieldNodes;
                captured.returnType = info.returnType;
                captured.parentType = info.parentType;
                captured.schema = info.schema;
                captured.fragments = info.fragments;
                captured.rootValue = info.rootValue;
                captured.operation = info.operation;
                captured.variableValues = info.variableValues;
                return { name: "ada" };
              },
            },
          },
        }),
      });

      const result = execute(
        schema,
        `query Q($id: String!) { user(id: $id) { name } ...F }
         fragment F on Query { __typename }`,
        { variables: { id: "1" }, rootObject: { tag: "root" } },
      );
      assert.deepStrictEqual(result.data, { user: { name: "ada" }, __typename: "Query" });
      assert.strictEqual(captured.fieldName, "user");
      assert.strictEqual(Array.isArray(captured.fieldNodes), true);
      assert.strictEqual((captured.fieldNodes as Array<{ name: { value: string } }>)[0]?.name.value,
        "user",
      );
      assert.strictEqual(captured.returnType, userType);
      assert.strictEqual((captured.parentType as GraphQLObjectType).name, "Query");
      assert.strictEqual(captured.schema, schema);
      assert.strictEqual((captured.fragments as Record<string, { name: { value: string } }>).F?.name.value,
        "F",
      );
      assert.deepStrictEqual(captured.rootValue, { tag: "root" });
      assert.strictEqual((captured.operation as { operation: string }).operation, "query");
      assert.deepStrictEqual(captured.variableValues, { id: "1" });
    });

    test("accessing info.path throws ImplementationError", () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            usesPath: {
              type: GraphQLString,
              resolve: (_src, _args, _ctx, info) => String(info.path),
            },
          },
        }),
      });

      assert.throws(() => execute(schema, `{ usesPath }`), ImplementationError);
      assert.throws(() => execute(schema, `{ usesPath }`),
        /accessed 'info\.path'.*no per-object resolution path/,
      );
    });

    test("manually constructed InterpretedFieldResolver works inside a hand-built ResolverMap", () => {
      const schema = buildSchema(`
        type Query { greet(name: String!): String }
      `);

      const resolvers: ResolverMap = {
        Query: {
          greet: new InterpretedFieldResolver<unknown, unknown>(
            (_source, args) => `hello ${(args as { name: string }).name}`,
          ),
        },
      };

      const result = execute(schema, `{ greet(name: "ada") }`, { resolvers });
      assert.deepStrictEqual(result, { data: { greet: "hello ada" } });
    });
  });

  describe("async interpreted resolvers", () => {
    test("a resolver returning a Promise resolves through a loader cycle", async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            value: {
              type: GraphQLString,
              resolve: () => Promise.resolve("hello"),
            },
          },
        }),
      });

      const result = await executeAsync(schema, `{ value }`);
      assert.deepStrictEqual(result, { data: { value: "hello" } });
    });

    test("a rejected Promise becomes a field error", async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            boom: {
              type: GraphQLString,
              resolve: () => Promise.reject(new Error("async boom")),
            },
          },
        }),
      });

      const result = await executeAsync(schema, `{ boom }`);
      assert.deepStrictEqual(result.data, { boom: null });
      assert.strictEqual(result.errors?.[0]?.message, "async boom");
    });

    test("a Promise that rejects with a non-Error reason still produces a field error", async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            boom: {
              type: GraphQLString,
              resolve: () => Promise.reject("stringly typed"),
            },
          },
        }),
      });

      const result = await executeAsync(schema, `{ boom }`);
      assert.deepStrictEqual(result.data, { boom: null });
      assert.strictEqual(result.errors?.[0]?.message, "stringly typed");
    });

    test("mixed sync and async resolvers across parent objects merge correctly", async () => {
      type ItemData = { id: string; kind: "sync" | "async" };
      const Item = new GraphQLObjectType({
        name: "Item",
        fields: {
          id: {
            type: GraphQLString,
            resolve: (src: unknown) => (src as ItemData).id,
          },
          name: {
            type: GraphQLString,
            resolve: (src: unknown) => {
              const item = src as ItemData;
              if (item.kind === "async") return Promise.resolve(`async-${item.id}`);
              return `sync-${item.id}`;
            },
          },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            items: {
              type: new GraphQLList(Item),
              resolve: () => [
                { id: "1", kind: "sync" },
                { id: "2", kind: "async" },
                { id: "3", kind: "sync" },
                { id: "4", kind: "async" },
              ] as ItemData[],
            },
          },
        }),
      });

      const result = await executeAsync(schema, `{ items { id name } }`);
      assert.deepStrictEqual(result, {
        data: {
          items: [
            { id: "1", name: "sync-1" },
            { id: "2", name: "async-2" },
            { id: "3", name: "sync-3" },
            { id: "4", name: "async-4" },
          ],
        },
      });
    });

    test("multiple async resolvers across a list batch into a single loader perform call", async () => {
      const originalPerform = InterpretedPromiseLoader.prototype.performAsync;
      let performCalls = 0;
      let totalKeys = 0;
      InterpretedPromiseLoader.prototype.performAsync = async function (
        keys: unknown[],
      ) {
        performCalls++;
        totalKeys += keys.length;
        return originalPerform.call(this, keys);
      };
      try {
        const Item = new GraphQLObjectType({
          name: "Item",
          fields: {
            doubled: {
              type: GraphQLString,
              resolve: (src: unknown) =>
                Promise.resolve(String((src as { n: number }).n * 2)),
            },
          },
        });
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: {
              items: {
                type: new GraphQLList(Item),
                resolve: () => [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
              },
            },
          }),
        });

        const result = await executeAsync(schema, `{ items { doubled } }`);
        assert.deepStrictEqual(result, {
          data: {
            items: [
              { doubled: "2" },
              { doubled: "4" },
              { doubled: "6" },
              { doubled: "8" },
            ],
          },
        });
        assert.strictEqual(performCalls, 1);
        assert.strictEqual(totalKeys, 4);
      } finally {
        InterpretedPromiseLoader.prototype.performAsync = originalPerform;
      }
    });

    test("async resolver inside a nested composite still completes", async () => {
      const Inner = new GraphQLObjectType({
        name: "Inner",
        fields: {
          tag: {
            type: GraphQLString,
            resolve: (src: unknown) =>
              Promise.resolve(`tag-${(src as { id: string }).id}`),
          },
        },
      });
      const Outer = new GraphQLObjectType({
        name: "Outer",
        fields: {
          inner: {
            type: Inner,
            resolve: (src: unknown) =>
              Promise.resolve({ id: (src as { id: string }).id }),
          },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            outer: {
              type: Outer,
              resolve: () => Promise.resolve({ id: "x" }),
            },
          },
        }),
      });

      const result = await executeAsync(schema, `{ outer { inner { tag } } }`);
      assert.deepStrictEqual(result, {
        data: { outer: { inner: { tag: "tag-x" } } },
      });
    });
  });

  describe("interpretSchema", () => {
    test("skips introspection types by default but covers user types", () => {
      const schema = buildSchema(`
        type Query { ping: String }
      `);
      const map = interpretSchema(schema);

      assert.deepStrictEqual(Object.keys(map).sort(), ["Query"]);
      assert.notStrictEqual(map["Query"], undefined);
      // SDL-built fields have no `.resolve`, so the shim falls back to a
      // breadth-native key resolver. When a `.resolve` is defined, it wraps.
      assert.ok(map["Query"]?.["ping"] instanceof FieldResolver);
    });

    test("wraps fields with explicit .resolve in an InterpretedFieldResolver", () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { ping: { type: GraphQLString, resolve: () => "pong" } },
        }),
      });
      const map = interpretSchema(schema);
      assert.ok(map["Query"]?.["ping"] instanceof InterpretedFieldResolver);
    });

    test("opt-in flag includes introspection types", () => {
      const schema = buildSchema(`type Query { ping: String }`);
      const map = interpretSchema(schema, undefined, { includeIntrospectionTypes: true });

      assert.ok(["Query", "__Schema", "__Type"].every((key) => Object.keys(map).includes(key)));
    });

    test("interfaces dispatch via abstractType.resolveType when defined", () => {
      const Character = new GraphQLInterfaceType({
        name: "Character",
        fields: { name: { type: GraphQLString } },
        resolveType: (value) => (value as { kind: string }).kind,
      });

      const Jedi = new GraphQLObjectType({
        name: "Jedi",
        interfaces: [Character],
        fields: { name: { type: GraphQLString }, saberColor: { type: GraphQLString } },
      });
      const Sith = new GraphQLObjectType({
        name: "Sith",
        interfaces: [Character],
        fields: { name: { type: GraphQLString }, darkSide: { type: GraphQLBoolean } },
      });

      const Query = new GraphQLObjectType({
        name: "Query",
        fields: {
          hero: {
            type: Character,
            resolve: () => ({ kind: "Jedi", name: "Luke", saberColor: "green" }),
          },
        },
      });

      const schema = new GraphQLSchema({ query: Query, types: [Jedi, Sith] });

      const result = execute(
        schema,
        `{ hero { name ... on Jedi { saberColor } ... on Sith { darkSide } } }`,
      );
      assert.deepStrictEqual(result, {
        data: { hero: { name: "Luke", saberColor: "green" } },
      });
    });

    test("interfaces fall back to isTypeOf on each possible type", () => {
      const Character = new GraphQLInterfaceType({
        name: "Character",
        fields: { name: { type: GraphQLString } },
      });

      const Jedi = new GraphQLObjectType({
        name: "Jedi",
        interfaces: [Character],
        isTypeOf: (value) => (value as { kind: string }).kind === "jedi",
        fields: { name: { type: GraphQLString }, saberColor: { type: GraphQLString } },
      });
      const Sith = new GraphQLObjectType({
        name: "Sith",
        interfaces: [Character],
        isTypeOf: (value) => (value as { kind: string }).kind === "sith",
        fields: { name: { type: GraphQLString }, darkSide: { type: GraphQLBoolean } },
      });

      const Query = new GraphQLObjectType({
        name: "Query",
        fields: {
          hero: {
            type: Character,
            resolve: () => ({ kind: "sith", name: "Vader", darkSide: true }),
          },
        },
      });

      const schema = new GraphQLSchema({ query: Query, types: [Jedi, Sith] });

      const result = execute(
        schema,
        `{ hero { name ... on Jedi { saberColor } ... on Sith { darkSide } } }`,
      );
      assert.deepStrictEqual(result, { data: { hero: { name: "Vader", darkSide: true } } });
    });

    test("unions dispatch via resolveType returning a GraphQLObjectType", () => {
      const Jedi = new GraphQLObjectType({
        name: "Jedi",
        fields: { name: { type: GraphQLString } },
      });
      const Sith = new GraphQLObjectType({
        name: "Sith",
        fields: { name: { type: GraphQLString } },
      });
      const Hero = new GraphQLUnionType({
        name: "Hero",
        types: [Jedi, Sith],
        resolveType: (value) => ((value as { side: string }).side === "light" ? "Jedi" : "Sith"),
      });

      const Query = new GraphQLObjectType({
        name: "Query",
        fields: {
          who: {
            type: new GraphQLNonNull(Hero),
            resolve: () => ({ side: "dark", name: "Maul" }),
          },
        },
      });

      const schema = new GraphQLSchema({ query: Query, types: [Jedi, Sith] });
      const result = execute(
        schema,
        `{ who { ... on Jedi { name } ... on Sith { name } } }`,
      );
      assert.deepStrictEqual(result, { data: { who: { name: "Maul" } } });
    });

    test("a resolveType returning a Promise throws ImplementationError", () => {
      const Character = new GraphQLInterfaceType({
        name: "Character",
        fields: { name: { type: GraphQLString } },
        resolveType: () => Promise.resolve("Jedi") as never,
      });
      const Jedi = new GraphQLObjectType({
        name: "Jedi",
        interfaces: [Character],
        fields: { name: { type: GraphQLString } },
      });
      const Query = new GraphQLObjectType({
        name: "Query",
        fields: {
          hero: { type: Character, resolve: () => ({ name: "Luke" }) },
        },
      });
      const schema = new GraphQLSchema({ query: Query, types: [Jedi] });

      assert.throws(() => execute(schema, `{ hero { name } }`),
        /resolveType for 'Character' returned a Promise/,
      );
    });
  });

  describe("mixing interpreted and native resolvers", () => {
    test("a native FieldResolver overrides an interpreted entry in the same map", () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            greeting: {
              type: GraphQLString,
              args: { name: { type: GraphQLString } },
              resolve: (_src, args) => `interpreted hello ${(args as { name: string }).name}`,
            },
            version: {
              type: GraphQLString,
              resolve: () => "interpreted-1.0",
            },
          },
        }),
      });

      class NativeVersion extends FieldResolver {
        override resolve(execField: ExecutionField): unknown[] {
          return execField.mapObjects(() => "native-2.0");
        }
      }

      const resolvers = interpretSchema(schema, {
        Query: { version: new NativeVersion() },
      });

      const result = execute(schema, `{ greeting(name: "ada") version }`, { resolvers });
      assert.deepStrictEqual(result, {
        data: { greeting: "interpreted hello ada", version: "native-2.0" },
      });
    });

    test("a native LazyLoader batches across the breadth while interpreted resolvers populate siblings", () => {
      type ItemRow = { id: string; name: string };
      const ROWS: ItemRow[] = [
        { id: "1", name: "alpha" },
        { id: "2", name: "beta" },
        { id: "3", name: "gamma" },
      ];

      let loaderCalls = 0;
      let lastBatchSize = 0;
      class ScoreLoader extends LazyLoader {
        override map = true;
        override perform(keys: unknown[]): unknown[] {
          loaderCalls++;
          lastBatchSize = keys.length;
          return (keys as string[]).map((id) => Number(id) * 10);
        }
      }

      class ScoreResolver extends FieldResolver {
        override resolve(execField: ExecutionField): ResolveResult {
          return execField.lazy({
            loaderClass: ScoreLoader as unknown as LazyLoaderConstructor,
            keys: execField.mapObjects((o) => (o as ItemRow).id),
          });
        }
      }

      const Item = new GraphQLObjectType({
        name: "Item",
        fields: {
          id: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: (src: unknown) => (src as ItemRow).id,
          },
          name: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: (src: unknown) => (src as ItemRow).name.toUpperCase(),
          },
          score: { type: new GraphQLNonNull(GraphQLInt) },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            items: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Item))),
              resolve: () => ROWS,
            },
          },
        }),
      });

      const resolvers = interpretSchema(schema, {
        Item: { score: new ScoreResolver() },
      });

      const result = execute(schema, `{ items { id name score } }`, { resolvers });
      assert.deepStrictEqual(result, {
        data: {
          items: [
            { id: "1", name: "ALPHA", score: 10 },
            { id: "2", name: "BETA", score: 20 },
            { id: "3", name: "GAMMA", score: 30 },
          ],
        },
      });
      assert.strictEqual(loaderCalls, 1);
      assert.strictEqual(lastBatchSize, 3);
    });

    test("an interpreted async resolver and a native LazyLoader cooperate in one query", async () => {
      type ItemRow = { id: string };
      const ROWS: ItemRow[] = [{ id: "1" }, { id: "2" }, { id: "3" }];

      let scoreLoaderCalls = 0;
      class ScoreLoader extends LazyLoader {
        override map = true;
        override perform(keys: unknown[]): unknown[] {
          scoreLoaderCalls++;
          return (keys as string[]).map((id) => Number(id) * 10);
        }
      }

      class ScoreResolver extends FieldResolver {
        override resolve(execField: ExecutionField): ResolveResult {
          return execField.lazy({
            loaderClass: ScoreLoader as unknown as LazyLoaderConstructor,
            keys: execField.mapObjects((o) => (o as ItemRow).id),
          });
        }
      }

      const Item = new GraphQLObjectType({
        name: "Item",
        fields: {
          id: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: (src: unknown) => (src as ItemRow).id,
          },
          tag: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: (src: unknown) =>
              Promise.resolve(`tag-${(src as ItemRow).id}`),
          },
          score: { type: new GraphQLNonNull(GraphQLInt) },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            items: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Item))),
              resolve: () => ROWS,
            },
          },
        }),
      });

      const resolvers = interpretSchema(schema, {
        Item: { score: new ScoreResolver() },
      });

      const result = await executeAsync(schema, `{ items { id tag score } }`, { resolvers });
      assert.deepStrictEqual(result, {
        data: {
          items: [
            { id: "1", tag: "tag-1", score: 10 },
            { id: "2", tag: "tag-2", score: 20 },
            { id: "3", tag: "tag-3", score: 30 },
          ],
        },
      });
      assert.strictEqual(scoreLoaderCalls, 1);
    });
  });

  describe("end-to-end coverage on a Star Wars-like schema", () => {
    const schema = buildSchema(`
      enum Side { LIGHT DARK }
      interface Character { id: ID!, name: String!, side: Side }
      type Jedi implements Character {
        id: ID!, name: String!, side: Side
        saberColor: String
      }
      type Sith implements Character {
        id: ID!, name: String!, side: Side
        apprentice: Character
      }
      type Query {
        heroes: [Character!]!
        character(id: ID!): Character
      }
    `);

    type CharacterData = {
      id: string;
      name: string;
      side: "LIGHT" | "DARK";
      saberColor?: string;
      apprenticeId?: string;
    };

    const luke: CharacterData = { id: "1", name: "Luke", side: "LIGHT", saberColor: "green" };
    const vader: CharacterData = { id: "2", name: "Vader", side: "DARK", apprenticeId: "3" };
    const maul: CharacterData = { id: "3", name: "Maul", side: "DARK" };

    const DATA: Record<string, CharacterData> = { "1": luke, "2": vader, "3": maul };

    const Character = schema.getType("Character") as GraphQLInterfaceType;
    Character.resolveType = (value) => ((value as CharacterData).side === "LIGHT" ? "Jedi" : "Sith");

    const Sith = schema.getType("Sith") as GraphQLObjectType;
    Sith.getFields()["apprentice"]!.resolve = (source: unknown) => {
      const apprenticeId = (source as CharacterData).apprenticeId;
      return apprenticeId ? DATA[apprenticeId] : null;
    };

    const Query = schema.getType("Query") as GraphQLObjectType;
    Query.getFields()["heroes"]!.resolve = () => Object.values(DATA);
    Query.getFields()["character"]!.resolve = (_src: unknown, args: unknown) =>
      DATA[(args as { id: string }).id] ?? null;

    test("runs a multi-type query through the breadth executor", () => {
      const result = execute(
        schema,
        `{
          heroes {
            id name side
            ... on Jedi { saberColor }
            ... on Sith { apprentice { name } }
          }
        }`,
      );
      assert.deepStrictEqual(result, {
        data: {
          heroes: [
            { id: "1", name: "Luke", side: "LIGHT", saberColor: "green" },
            { id: "2", name: "Vader", side: "DARK", apprentice: { name: "Maul" } },
            { id: "3", name: "Maul", side: "DARK", apprentice: null },
          ],
        },
      });
    });

    test("resolver arguments flow through correctly", () => {
      const result = execute(
        schema,
        `query Lookup($id: ID!) { character(id: $id) { name } }`,
        { variables: { id: "2" } },
      );
      assert.deepStrictEqual(result, { data: { character: { name: "Vader" } } });
    });
  });
});
