import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { buildSchema } from "graphql";
import {
  Executor,
  FieldResolver,
  LazyLoader,
  type GraphQLResult,
  type LazyLoaderConstructor,
  type ResolveResult,
  type ResolverMap,
} from "../../src/index.js";
import type { ExecutionField } from "../../src/executor/execution_field.js";
import { EventCollector } from "../test_helper.js";

const SCHEMA = buildSchema(`
  type Query {
    mayObj: Query
    mustObj: Query!
    mayList: [Query]
    mustList: [Query!]!
    x: String
    y: String!
    may: String
    must: String!
  }
  type Mutation {
    mayObj: Query
    mustObj: Query!
    mayList: [Query]
    mustList: [Query!]!
  }
`);

class TestLazyLoader extends LazyLoader {
  private key: string;

  constructor(args: { key: string }) {
    super();
    this.key = args.key;
  }

  override perform(objects: unknown[]): void {
    EventCollector.events.push(`lazy:${this.key}`);
    for (const obj of objects) this.fulfillKey(obj, obj);
  }
}

class TestResolver extends FieldResolver {
  key: string;

  constructor(key: string) {
    super();
    this.key = key;
  }

  override resolve(execField: ExecutionField, context: unknown): ResolveResult {
    EventCollector.events.push(this.key);
    const ctx = context as { lazy?: string[] } | undefined;
    if (ctx?.lazy?.includes(this.key)) {
      return execField.lazy({
        loaderClass: TestLazyLoader as unknown as LazyLoaderConstructor,
        args: { key: this.key },
        keys: execField.mapObjects((o) => (o as Record<string, unknown>)[this.key]),
      });
    }
    return execField.mapObjects((obj) => {
      if (obj == null) return null;
      return (obj as Record<string, unknown>)[this.key];
    });
  }
}

const RESOLVERS: ResolverMap = {
  Query: {
    mayObj: new TestResolver("mayObj"),
    mustObj: new TestResolver("mustObj"),
    mayList: new TestResolver("mayList"),
    mustList: new TestResolver("mustList"),
    x: new TestResolver("x"),
    y: new TestResolver("y"),
    may: new TestResolver("may"),
    must: new TestResolver("must"),
  },
  Mutation: {
    mayObj: new TestResolver("mayObj"),
    mustObj: new TestResolver("mustObj"),
    mayList: new TestResolver("mayList"),
    mustList: new TestResolver("mustList"),
  },
};

function executeOp(
  document: string,
  rootObject: unknown,
  context: Record<string, unknown> = {},
): GraphQLResult {
  return Executor.build({
    schema: SCHEMA,
    document,
    resolvers: RESOLVERS,
    rootObject,
    context,
  }).resultSync;
}

describe("abort execution", () => {
  beforeEach(() => EventCollector.reset());

  test("does not abort for nullable object fields", () => {
    const source = {
      mayList: [{ must: null, may: "hi" }],
      mustObj: { must: "hi", may: "hi" },
    };

    const result = executeOp(
      `query {
        mayList { may must }
        mustObj { may must }
      }`,
      source,
    );

    assert.deepStrictEqual(result, {
      errors: [{
        message: "Cannot return null for non-nullable field Query.must",
        path: ["mayList", 0, "must"],
        locations: [{ line: 2, column: 23 }],
        extensions: { code: "INVALID_NULL" },
      }],
      data: {
        mayList: [null],
        mustObj: { may: "hi", must: "hi" },
      },
    });

    assert.deepStrictEqual(EventCollector.events, [
      "mayList",
      "mustObj",
      "may",
      "must",
      "may",
      "must",
    ]);
  });

  test("aborts subsequent query fields when non-null cascades to root", () => {
    const source = {
      mustObj: { must: null, may: "hi" },
      mayList: [{ must: "hi", may: "hi" }],
    };

    const result = executeOp(
      `query {
        mustObj { must may }
        mayList { must may }
      }`,
      source,
    );

    assert.strictEqual(result.data, null);
    assert.deepStrictEqual(EventCollector.events, [
      "mustObj",
      "mayList",
      "must",
      "may",
    ]);
  });

  test("does not propagate non-null within a list of nullable items", () => {
    const source = {
      mayList: [
        { mustObj: { mustObj: { must: null, may: "hi" } } },
        { mustObj: { mustObj: { must: "hi", may: "hi" } } },
      ],
    };

    const result = executeOp(
      `query {
        mayList {
          mustObj {
            mustObj {
              must
              may
            }
          }
        }
      }`,
      source,
    );

    assert.deepStrictEqual(result, {
      errors: [{
        message: "Cannot return null for non-nullable field Query.must",
        extensions: { code: "INVALID_NULL" },
        locations: [{ line: 5, column: 15 }],
        path: ["mayList", 0, "mustObj", "mustObj", "must"],
      }],
      data: {
        mayList: [
          null,
          { mustObj: { mustObj: { must: "hi", may: "hi" } } },
        ],
      },
    });

    assert.deepStrictEqual(EventCollector.events, [
      "mayList",
      "mustObj",
      "mustObj",
      "must",
      "may",
    ]);
  });
});
