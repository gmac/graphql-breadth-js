import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { buildSchema } from "graphql";
import {
  Executor,
  FieldResolver,
  type GraphQLResult,
  type ResolverMap,
} from "../../src/index.ts";
import type { ExecutionField } from "../../src/executor/execution_field.ts";
import { EventCollector } from "../test_helper.ts";

const TEST_SCHEMA = buildSchema(`
  interface Node {
    id: ID!
  }
  type Image implements Node {
    id: ID!
    imageParent: Product
    nodes: [Node]
    info: Info
  }
  type Video implements Node {
    id: ID!
    videoParent: Product
    nodes: [Node]
    info: Info
  }
  type Product {
    id: ID!
    image: Image
    video: Video
    nodes: [Node]
    parent: Product
    info: Info
  }
  type Info {
    root: [String]
    planningRoot: [String]
  }
  type Query {
    product: Product
  }
`);

class DefaultPlanningResolver extends FieldResolver {
  override plan(execField: ExecutionField): null {
    EventCollector.events.push(`plan(${execField.path.join("/")})`);
    return null;
  }
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((obj) => {
      if (obj == null) return null;
      return (obj as Record<string, unknown>)[execField.key];
    });
  }
}

class InfoResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    let result: unknown;
    switch (execField.key) {
      case "info":
        result = {};
        break;
      case "root":
        result = execField.scope.root.path;
        break;
      case "planningRoot":
        result = execField.scope.planningRoot.path;
        break;
    }
    return execField.resolveAll(result);
  }
}

const TEST_RESOLVERS: ResolverMap = {
  Node: {
    __type__: (obj) => {
      const typename = (obj as Record<string, string>)?.__typename__;
      return typename ? TEST_SCHEMA.getType(typename) ?? null : null;
    },
  },
  Image: { info: new InfoResolver() },
  Video: { info: new InfoResolver() },
  Product: { info: new InfoResolver() },
  Info: {
    root: new InfoResolver(),
    planningRoot: new InfoResolver(),
  },
};

function executePlanning(document: string, rootObject: unknown = {}): GraphQLResult {
  return Executor.build({
    schema: TEST_SCHEMA,
    document,
    resolvers: TEST_RESOLVERS,
    rootObject,
    defaultFieldResolver: new DefaultPlanningResolver(),
  }).resultSync;
}

describe("planning", () => {
  beforeEach(() => EventCollector.reset());

  test("plans static query from bottom up", () => {
    executePlanning(`{
      a: product {
        image { id }
        video { id }
      }
      b: product { id }
    }`);

    assert.deepStrictEqual(EventCollector.events, [
      "plan(b/id)",
      "plan(b)",
      "plan(a/video/id)",
      "plan(a/video)",
      "plan(a/image/id)",
      "plan(a/image)",
      "plan(a)",
    ]);
  });

  test("correctly identifies root and planning root scopes through abstract fan-out", () => {
    const source = {
      product: {
        nodes: [{
          __typename__: "Image",
          nodes: [{ __typename__: "Image" }],
        }],
      },
    };

    const expected = {
      product: {
        nodes: [{
          info: {
            root: [],
            planningRoot: ["product", "nodes"],
          },
          nodes: [{
            info: {
              root: [],
              planningRoot: ["product", "nodes", "nodes"],
            },
          }],
        }],
        info: {
          root: [],
          planningRoot: [],
        },
      },
    };

    const result = executePlanning(
      `{
        product {
          nodes {
            ... on Image {
              info { root planningRoot }
              nodes {
                ... on Image {
                  info { root planningRoot }
                }
              }
            }
          }
          info { root planningRoot }
        }
      }`,
      source,
    );

    assert.deepStrictEqual(result.data, expected);
  });
});
