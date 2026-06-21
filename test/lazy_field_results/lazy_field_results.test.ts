import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { buildSchema } from "graphql";
import {
  Executor,
  FieldResolver,
  ObjectKeyResolver,
  LazyLoader,
  type LazyLoaderConstructor,
  type ResolveResult,
  type ResolverMap,
} from "../../src/index.js";
import type { ExecutionField } from "../../src/executor/execution_field.js";
import { EventCollector } from "../test_helper.js";

const SCHEMA = buildSchema(`
  type Widget {
    syncScalar: String
    lazyChain: String
    lazyWidget: Widget
  }
  type Query {
    fulfillment: String
    widgets: [Widget]
    lazyWidget: Widget
  }
`);

class GroupPrefixLoader extends LazyLoader {
  private group: string;

  constructor(args?: { group?: string }) {
    super();
    this.group = String(args?.group ?? "");
  }

  override perform(keys: unknown[]): void {
    EventCollector.events.push([...keys]);
    for (const key of keys) {
      this.fulfillKey(key, `${String(key)}-${this.group}`);
    }
  }
}

class LazyChainResolver extends FieldResolver {
  override resolve(execField: ExecutionField): ResolveResult {
    const keys = execField.mapObjects((o) => (o as Record<string, unknown>)[execField.key]);
    return execField
      .lazy({
        loaderClass: GroupPrefixLoader as unknown as LazyLoaderConstructor,
        args: { group: "a" },
        keys,
      })
      .then((resultsA) =>
        execField.lazy({
          loaderClass: GroupPrefixLoader as unknown as LazyLoaderConstructor,
          args: { group: "b" },
          keys: resultsA as unknown[],
        }),
      )
      .then((resultsB) => (resultsB as unknown[]).map((b) => `${String(b)}-fin`));
  }
}

class LazyWidgetLoader extends LazyLoader {
  override perform(keys: unknown[]): void {
    const fields = keys as ExecutionField[];
    EventCollector.events.push(fields.map((f) => f.key).sort());
    for (const field of fields) {
      this.fulfillKey(field, (field.objects[0] as Record<string, unknown>)[field.key]);
    }
  }
}

class LazyWidgetResolver extends FieldResolver {
  override resolve(execField: ExecutionField): ResolveResult {
    return execField.lazy({
      loaderClass: LazyWidgetLoader as unknown as LazyLoaderConstructor,
      keys: [execField],
    });
  }
}

class FulfillmentLoader extends LazyLoader {
  override identityFor(key: unknown): unknown {
    return typeof key === "string" ? key.toLowerCase() : key;
  }

  override perform(keys: unknown[], context: unknown): void {
    const ctx = context as { fulfillByIdentity?: boolean } | undefined;
    for (const key of keys) {
      if (ctx?.fulfillByIdentity) {
        this.fulfillIdentity(this.identityFor(key), `${String(key)} via identity`);
      } else {
        this.fulfillKey(key, `${String(key)} via key`);
      }
    }
  }
}

class FulfillmentResolver extends FieldResolver {
  override resolve(execField: ExecutionField): ResolveResult {
    return execField.lazy({
      loaderClass: FulfillmentLoader as unknown as LazyLoaderConstructor,
      keys: execField.mapObjects((o) => (o as Record<string, unknown>)[execField.key]),
    });
  }
}

const RESOLVERS: ResolverMap = {
  Widget: {
    syncScalar: new ObjectKeyResolver("syncScalar"),
    lazyChain: new LazyChainResolver(),
    lazyWidget: new LazyWidgetResolver(),
  },
  Query: {
    fulfillment: new FulfillmentResolver(),
    widgets: new ObjectKeyResolver("widgets"),
    lazyWidget: new LazyWidgetResolver(),
  },
};

function executeOp(
  document: string,
  rootObject: unknown,
  context: Record<string, unknown> = {},
) {
  return Executor.build({
    schema: SCHEMA,
    document,
    resolvers: RESOLVERS,
    rootObject,
    context,
  }).result;
}

describe("lazy field results", () => {
  beforeEach(() => EventCollector.reset());

  test("batches loaders across scopes of common depth", () => {
    const source = {
      a: { b: { c: { syncScalar: "c" } } },
      x: { y: { z: { syncScalar: "z" } } },
    };

    const result = executeOp(
      `{
        a: lazyWidget {
          b: lazyWidget {
            c: lazyWidget { syncScalar }
          }
        }
        x: lazyWidget {
          y: lazyWidget {
            z: lazyWidget { syncScalar }
          }
        }
      }`,
      source,
    );

    assert.deepStrictEqual(result, { data: source });
    assert.deepStrictEqual(EventCollector.events, [["a", "x"], ["b", "y"], ["c", "z"]]);
  });

  test("chains multiple lazy loads", () => {
    const source = {
      widgets: [
        { lazyChain: "He" },
        { lazyChain: "Ne" },
        { lazyChain: "Ar" },
      ],
    };

    const result = executeOp(`{ widgets { lazyChain } }`, source);

    assert.deepStrictEqual(result, {
      data: {
        widgets: [
          { lazyChain: "He-a-b-fin" },
          { lazyChain: "Ne-a-b-fin" },
          { lazyChain: "Ar-a-b-fin" },
        ],
      },
    });
    assert.deepStrictEqual(EventCollector.events, [
      ["He", "Ne", "Ar"],
      ["He-a", "Ne-a", "Ar-a"],
    ]);
  });

  test("fulfillment by key", () => {
    const result = executeOp(
      `{ fulfillment }`,
      { fulfillment: "TEST" },
      { fulfillByIdentity: false },
    );
    assert.deepStrictEqual(result, { data: { fulfillment: "TEST via key" } });
  });

  test("fulfillment by identity uses identityFor normalization", () => {
    const result = executeOp(
      `{ fulfillment }`,
      { fulfillment: "TEST" },
      { fulfillByIdentity: true },
    );
    assert.deepStrictEqual(result, { data: { fulfillment: "TEST via identity" } });
  });
});
