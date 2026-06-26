import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Executor } from "../../src/index.ts";
import { STAR_WARS_SCHEMA, STAR_WARS_RESOLVERS } from "./star_wars_fixtures.ts";

function executeStarWars(query: string, variables: Record<string, unknown> = {}) {
  return Executor.build({
    schema: STAR_WARS_SCHEMA,
    document: query,
    resolvers: STAR_WARS_RESOLVERS,
    variables,
  }).result;
}

describe("StarWars query", () => {
  test("correctly identifies R2-D2 as the hero of the Star Wars saga", () => {
    const query = `
          query HeroNameQuery {
            hero {
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          name: "R2-D2",
        },
      },
    });
  });

  test("correctly identifies R2-D2 as the hero with nested query", () => {
    const query = `
          query NestedQuery {
            hero {
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          name: "R2-D2",
        },
      },
    });
  });

  test("allows us to query for the id and friends of R2-D2", () => {
    const query = `
          query HeroNameAndFriendsQuery {
            hero {
              id
              name
              friends {
                name
              }
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          id: "2001",
          name: "R2-D2",
          friends: [
            { name: "Luke Skywalker" },
            { name: "Han Solo" },
            { name: "Leia Organa" },
          ],
        },
      },
    });
  });

  test("allows us to query for the friends of friends of R2-D2", () => {
    const query = `
          query NestedQuery {
            hero {
              name
              friends {
                name
                appearsIn
                friends {
                  name
                }
              }
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          name: "R2-D2",
          friends: [
            {
              name: "Luke Skywalker",
              appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Han Solo" },
                { name: "Leia Organa" },
                { name: "C-3PO" },
                { name: "R2-D2" },
              ],
            },
            {
              name: "Han Solo",
              appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Luke Skywalker" },
                { name: "Leia Organa" },
                { name: "R2-D2" },
              ],
            },
            {
              name: "Leia Organa",
              appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Luke Skywalker" },
                { name: "Han Solo" },
                { name: "C-3PO" },
                { name: "R2-D2" },
              ],
            },
          ],
        },
      },
    });
  });

  test("allows us to query character directly using their ids", () => {
    const query = `
          query FetchLukeQuery {
            human(id: "1000") {
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        human: {
          name: "Luke Skywalker",
        },
      },
    });
  });

  test("allows us to create a generic query, then fetch Luke using his id", () => {
    const query = `
          query FetchSomeIDQuery($someId: String!) {
            human(id: $someId) {
              name
            }
          }
        `;

    const result = executeStarWars(query, { someId: "1000" });

    assert.deepStrictEqual(result, {
      data: {
        human: {
          name: "Luke Skywalker",
        },
      },
    });
  });

  test("allows us to create a generic query, then fetch Han using his id", () => {
    const query = `
          query FetchSomeIDQuery($someId: String!) {
            human(id: $someId) {
              name
            }
          }
        `;

    const result = executeStarWars(query, { someId: "1002" });

    assert.deepStrictEqual(result, {
      data: {
        human: {
          name: "Han Solo",
        },
      },
    });
  });

  test("allows us to create a generic query, then pass an invalid id to get null", () => {
    const query = `
          query HumanQuery($id: String!) {
            human(id: $id) {
              name
            }
          }
        `;

    const result = executeStarWars(query, { id: "not a valid id" });

    assert.deepStrictEqual(result, {
      data: {
        human: null,
      },
    });
  });

  test("allows us to query for Luke, changing his key with an alias", () => {
    const query = `
          query FetchLukeAliased {
            luke: human(id: "1000") {
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        luke: {
          name: "Luke Skywalker",
        },
      },
    });
  });

  test("allows us to query for both Luke and Leia using two root fields and an alias", () => {
    const query = `
          query FetchLukeAndLeiaAliased {
            luke: human(id: "1000") {
              name
            }
            leia: human(id: "1003") {
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        luke: {
          name: "Luke Skywalker",
        },
        leia: {
          name: "Leia Organa",
        },
      },
    });
  });

  test("allows us to query using duplicated content", () => {
    const query = `
          query DuplicateFields {
            luke: human(id: "1000") {
              name
              homePlanet
            }
            leia: human(id: "1003") {
              name
              homePlanet
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        luke: {
          name: "Luke Skywalker",
          homePlanet: "Tatooine",
        },
        leia: {
          name: "Leia Organa",
          homePlanet: "Alderaan",
        },
      },
    });
  });

  test("allows us to use a fragment to avoid duplicating content", () => {
    const query = `
          query UseFragment {
            luke: human(id: "1000") {
              ...HumanFragment
            }
            leia: human(id: "1003") {
              ...HumanFragment
            }
          }

          fragment HumanFragment on Human {
            name
            homePlanet
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        luke: {
          name: "Luke Skywalker",
          homePlanet: "Tatooine",
        },
        leia: {
          name: "Leia Organa",
          homePlanet: "Alderaan",
        },
      },
    });
  });

  test("allows us to verify that R2-D2 is a droid", () => {
    const query = `
          query CheckTypeOfR2 {
            hero {
              __typename
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          __typename: "Droid",
          name: "R2-D2",
        },
      },
    });
  });

  test("allows us to verify that Luke is a human", () => {
    const query = `
          query CheckTypeOfLuke {
            hero(episode: EMPIRE) {
              __typename
              name
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          __typename: "Human",
          name: "Luke Skywalker",
        },
      },
    });
  });

  test("correctly reports error on accessing secret backstory", () => {
    const query = `
          query HeroNameQuery {
            hero {
              name
              secretBackstory
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          name: "R2-D2",
          secretBackstory: null,
        },
      },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 5, column: 15 }],
          path: ["hero", "secretBackstory"],
        },
      ],
    });
  });

  test("correctly reports error on accessing secret backstory in a list", () => {
    const query = `
          query HeroNameQuery {
            hero {
              name
              friends {
                name
                secretBackstory
              }
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        hero: {
          name: "R2-D2",
          friends: [
            { name: "Luke Skywalker", secretBackstory: null },
            { name: "Han Solo", secretBackstory: null },
            { name: "Leia Organa", secretBackstory: null },
          ],
        },
      },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 17 }],
          path: ["hero", "friends", 0, "secretBackstory"],
        },
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 17 }],
          path: ["hero", "friends", 1, "secretBackstory"],
        },
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 17 }],
          path: ["hero", "friends", 2, "secretBackstory"],
        },
      ],
    });
  });

  test("correctly reports error on accessing through an alias", () => {
    const query = `
          query HeroNameQuery {
            mainHero: hero {
              name
              story: secretBackstory
            }
          }
        `;

    const result = executeStarWars(query);

    assert.deepStrictEqual(result, {
      data: {
        mainHero: {
          name: "R2-D2",
          story: null,
        },
      },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 5, column: 15 }],
          path: ["mainHero", "story"],
        },
      ],
    });
  });
});
