import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSchema, executeSync, getIntrospectionQuery, parse } from "graphql";
import { Executor, type GraphQLResult } from "../../src/index.ts";

const SDL = `
  """A character in the saga."""
  interface Character {
    id: ID!
    name: String
  }

  """A force-using person."""
  type Jedi implements Character {
    id: ID!
    name: String
    """Color of the lightsaber."""
    saberColor: String
    oldField: String @deprecated(reason: "use name")
  }

  type Sith implements Character {
    id: ID!
    name: String
  }

  union Hero = Jedi | Sith

  """A planet."""
  type Planet {
    name: String
    """The number of moons. Defaults to zero."""
    moons: Int
  }

  """Episode of the saga."""
  enum Episode {
    NEWHOPE
    EMPIRE
    JEDI @deprecated(reason: "spoiler")
  }

  """Selector for finding heroes."""
  input HeroFilter {
    name: String = "Luke"
    minAge: Int
    legacy: Boolean @deprecated(reason: "ignored")
  }

  type Query {
    hero(filter: HeroFilter): Hero
    character(id: ID!): Character
    planet: Planet
    episode: Episode
  }

  type Mutation {
    saveHero(
      name: String!
      """legacy identifier"""
      legacyId: ID @deprecated(reason: "use name")
    ): Hero
  }
`;

const schema = buildSchema(SDL);

function execute(
  document: string,
  variables: Record<string, unknown> = {},
  rootObject: Record<string, unknown> = {},
): GraphQLResult {
  return Executor.build({
    schema,
    document,
    variables,
    rootObject,
  }).resultSync;
}

describe("introspection", () => {
  test("resolves __typename on a concrete object", () => {
    const result = execute(
      `{
      planet { __typename name }
    }`,
      {},
      { planet: {} },
    );
    // Planet has no resolver so name is null, but __typename comes from introspection.
    assert.deepStrictEqual(result.data, { planet: { __typename: "Planet", name: null } });
  });

  test("resolves the __schema entrypoint at the root", () => {
    const result = execute(`{
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
      }
    }`);
    assert.deepStrictEqual(result.data, {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        subscriptionType: null,
      },
    });
  });

  test("resolves the __type entrypoint and reports kind", () => {
    const result = execute(`{
      jedi: __type(name: "Jedi") { name kind description }
      hero: __type(name: "Hero") { name kind }
      episode: __type(name: "Episode") { name kind }
      filter: __type(name: "HeroFilter") { name kind }
      missing: __type(name: "Nope") { name }
    }`);
    assert.deepStrictEqual(result.data, {
      jedi: { name: "Jedi", kind: "OBJECT", description: "A force-using person." },
      hero: { name: "Hero", kind: "UNION" },
      episode: { name: "Episode", kind: "ENUM" },
      filter: { name: "HeroFilter", kind: "INPUT_OBJECT" },
      missing: null,
    });
  });

  test("lists object fields with descriptions, filtering deprecated by default", () => {
    const result = execute(`{
      __type(name: "Jedi") {
        fields {
          name
          description
          isDeprecated
        }
      }
    }`) as { data: { __type: { fields: Array<{ name: string }> } } };
    const fieldNames = result.data.__type.fields.map((f) => f.name);
    assert.deepStrictEqual(fieldNames, ["id", "name", "saberColor"]);
    assert.deepStrictEqual(result.data.__type.fields.find((f) => f.name === "saberColor"), {
      name: "saberColor",
      description: "Color of the lightsaber.",
      isDeprecated: false,
    });
  });

  test("includes deprecated fields when requested", () => {
    const result = execute(`{
      __type(name: "Jedi") {
        fields(includeDeprecated: true) {
          name
          isDeprecated
          deprecationReason
        }
      }
    }`) as {
      data: {
        __type: {
          fields: Array<{ name: string; isDeprecated: boolean; deprecationReason: string | null }>;
        };
      };
    };
    const deprecated = result.data.__type.fields.find((f) => f.name === "oldField");
    assert.deepStrictEqual(deprecated, {
      name: "oldField",
      isDeprecated: true,
      deprecationReason: "use name",
    });
  });

  test("walks wrapping types via ofType", () => {
    const result = execute(`{
      __type(name: "Jedi") {
        fields(includeDeprecated: true) {
          name
          type {
            kind
            name
            ofType { kind name }
          }
        }
      }
    }`) as {
      data: {
        __type: {
          fields: Array<{
            name: string;
            type: { kind: string; name: string | null; ofType: { kind: string; name: string } | null };
          }>;
        };
      };
    };
    const idField = result.data.__type.fields.find((f) => f.name === "id")!;
    assert.deepStrictEqual(idField.type, {
      kind: "NON_NULL",
      name: null,
      ofType: { kind: "SCALAR", name: "ID" },
    });
  });

  test("lists interfaces, possibleTypes, and input fields", () => {
    const result = execute(`{
      jedi: __type(name: "Jedi") {
        interfaces { name kind }
      }
      hero: __type(name: "Hero") {
        possibleTypes { name kind }
      }
      character: __type(name: "Character") {
        possibleTypes { name }
      }
      filter: __type(name: "HeroFilter") {
        inputFields {
          name
          defaultValue
        }
      }
    }`) as {
      data: {
        jedi: { interfaces: Array<{ name: string; kind: string }> };
        hero: { possibleTypes: Array<{ name: string; kind: string }> };
        character: { possibleTypes: Array<{ name: string }> };
        filter: { inputFields: Array<{ name: string; defaultValue: string | null }> };
      };
    };
    assert.deepStrictEqual(result.data.jedi.interfaces, [
      { name: "Character", kind: "INTERFACE" },
    ]);
    assert.deepStrictEqual(result.data.hero.possibleTypes.map((t) => t.name).sort(), [
      "Jedi",
      "Sith",
    ]);
    assert.deepStrictEqual(result.data.character.possibleTypes.map((t) => t.name).sort(), [
      "Jedi",
      "Sith",
    ]);
    // Deprecated input fields filtered by default.
    assert.deepStrictEqual(result.data.filter.inputFields, [
      { name: "name", defaultValue: '"Luke"' },
      { name: "minAge", defaultValue: null },
    ]);
  });

  test("returns enum values, filtering deprecated by default", () => {
    const result = execute(`{
      default: __type(name: "Episode") {
        enumValues { name isDeprecated }
      }
      all: __type(name: "Episode") {
        enumValues(includeDeprecated: true) { name isDeprecated deprecationReason }
      }
    }`) as {
      data: {
        default: { enumValues: Array<{ name: string; isDeprecated: boolean }> };
        all: {
          enumValues: Array<{
            name: string;
            isDeprecated: boolean;
            deprecationReason: string | null;
          }>;
        };
      };
    };
    assert.deepStrictEqual(result.data.default.enumValues.map((v) => v.name), [
      "NEWHOPE",
      "EMPIRE",
    ]);
    assert.deepStrictEqual(result.data.all.enumValues.find((v) => v.name === "JEDI"), {
      name: "JEDI",
      isDeprecated: true,
      deprecationReason: "spoiler",
    });
  });

  test("lists directives with args", () => {
    const result = execute(`{
      __schema {
        directives {
          name
          isRepeatable
          locations
          args { name type { kind ofType { name } } }
        }
      }
    }`) as {
      data: {
        __schema: {
          directives: Array<{
            name: string;
            isRepeatable: boolean;
            locations: string[];
            args: Array<{ name: string; type: { kind: string; ofType: { name: string } | null } }>;
          }>;
        };
      };
    };
    const skip = result.data.__schema.directives.find((d) => d.name === "skip")!;
    assert.strictEqual(skip.isRepeatable, false);
    assert.deepStrictEqual(skip.locations, ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"]);
    assert.deepStrictEqual(skip.args, [
      {
        name: "if",
        type: { kind: "NON_NULL", ofType: { name: "Boolean" } },
      },
    ]);
  });

  test("returns null for fields/enumValues/inputFields on incompatible kinds", () => {
    const result = execute(`{
      unionFields: __type(name: "Hero") { fields { name } }
      scalarFields: __type(name: "String") { fields { name } }
      objectEnumValues: __type(name: "Jedi") { enumValues { name } }
      objectInputFields: __type(name: "Jedi") { inputFields { name } }
    }`);
    assert.deepStrictEqual(result.data, {
      unionFields: { fields: null },
      scalarFields: { fields: null },
      objectEnumValues: { enumValues: null },
      objectInputFields: { inputFields: null },
    });
  });

  test("lists field-level args with deprecation, description, and type kind", () => {
    const result = execute(`{
      __type(name: "Mutation") {
        fields {
          name
          some: args { name }
          all: args(includeDeprecated: true) {
            name
            description
            isDeprecated
            deprecationReason
            type { kind ofType { name } }
          }
        }
      }
    }`) as {
      data: {
        __type: {
          fields: Array<{
            name: string;
            some: Array<{ name: string }>;
            all: Array<{
              name: string;
              description: string | null;
              isDeprecated: boolean;
              deprecationReason: string | null;
              type: { kind: string; ofType: { name: string } | null };
            }>;
          }>;
        };
      };
    };
    const saveHero = result.data.__type.fields.find((f) => f.name === "saveHero")!;
    assert.deepStrictEqual(saveHero.some.map((a) => a.name), ["name"]);
    assert.deepStrictEqual(saveHero.all, [
      {
        name: "name",
        description: null,
        isDeprecated: false,
        deprecationReason: null,
        type: { kind: "NON_NULL", ofType: { name: "String" } },
      },
      {
        name: "legacyId",
        description: "legacy identifier",
        isDeprecated: true,
        deprecationReason: "use name",
        type: { kind: "SCALAR", ofType: null },
      },
    ]);
  });

  test("serializes argument default values for varied input shapes", () => {
    const defaultsSchema = buildSchema(`
      enum TestEnum { A B }
      input TestInput { a: TestEnum!, b: String, c: [String] }
      type Query {
        test1(input: TestEnum = A): Boolean
        test2(input: [TestEnum] = [A, B]): Boolean
        test3(input: TestInput = { a: A, b: "sfoo", c: ["sfoo"] }): Boolean
        test4(input: [TestInput] = [{ a: A }]): Boolean
        test5(input: String = "sfoo"): Boolean
        test6(input: Int = 23): Boolean
        test7(input: Float = 23.77): Boolean
        test8(input: Boolean = true): Boolean
        test9(input: Boolean = null): Boolean
      }
    `);

    const result = Executor.build({
      schema: defaultsSchema,
      document: `{
        __type(name: "Query") {
          fields {
            name
            args { defaultValue }
          }
        }
      }`,
      variables: {},
      rootObject: {},
    }).resultSync as unknown as {
      data: {
        __type: {
          fields: Array<{ name: string; args: Array<{ defaultValue: string | null }> }>;
        };
      };
    };

    // graphql-js's print formats input object literals without inner spaces
    // (e.g. `{a: A}`), differing from graphql-ruby's `{ a: A }`.
    const expected: Record<string, string | null> = {
      test1: "A",
      test2: "[A, B]",
      test3: '{a: A, b: "sfoo", c: ["sfoo"]}',
      test4: "[{a: A}]",
      test5: '"sfoo"',
      test6: "23",
      test7: "23.77",
      test8: "true",
      test9: "null",
    };
    for (const field of result.data.__type.fields) {
      const got = field.args[0]?.defaultValue;
      assert.deepStrictEqual(got, expected[field.name]);
    }
  });

  test("matches graphql-js's own execution of the standard introspection query", () => {
    const document = parse(getIntrospectionQuery());
    const ours = execute(getIntrospectionQuery());
    const reference = executeSync({ schema, document });
    assert.strictEqual(ours.errors, undefined);
    assert.strictEqual(reference.errors, undefined);
    // graphql-js doesn't guarantee field-order stability across implementations;
    // normalize both sides by sorting named arrays before comparing.
    assert.deepStrictEqual(normalize(ours.data), normalize(reference.data));
  });

  test("answers the full standard introspection query", () => {
    const result = execute(getIntrospectionQuery());
    assert.strictEqual(result.errors, undefined);
    assert.notStrictEqual(result.data, undefined);
    const data = result.data as { __schema: { types: Array<{ name: string }> } };
    const typeNames = data.__schema.types.map((t) => t.name);
    // Custom types and standard scalars should all be present.
    for (const expected of [
      "Query",
      "Jedi",
      "Sith",
      "Character",
      "Hero",
      "Planet",
      "Episode",
      "HeroFilter",
      "String",
      "Boolean",
      "ID",
      "Int",
      "__Schema",
      "__Type",
      "__Field",
      "__InputValue",
      "__EnumValue",
      "__Directive",
      "__TypeKind",
      "__DirectiveLocation",
    ]) {
      assert.ok(typeNames.includes(expected));
    }
  });
});

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    if (items.length > 0 && items.every((i) => i && typeof i === "object" && "name" in (i as object))) {
      return [...items].sort((a, b) => {
        const an = (a as { name: string | null }).name ?? "";
        const bn = (b as { name: string | null }).name ?? "";
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}
