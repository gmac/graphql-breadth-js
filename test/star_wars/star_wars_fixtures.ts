import { buildSchema, type GraphQLSchema } from "graphql";
import {
  FieldResolver,
  ObjectKeyResolver,
  ExecutionError,
  type ResolverMap,
} from "../../src/index.js";
import type { ExecutionField } from "../../src/executor/execution_field.js";

// Ported from the graphql-js reference implementation.
// https://github.com/graphql/graphql-js/tree/16.x.x/src/__tests__

export const STAR_WARS_SDL = `
  enum Episode {
    NEWHOPE
    EMPIRE
    JEDI
  }

  interface Character {
    id: String!
    name: String
    friends: [Character]
    appearsIn: [Episode]
    secretBackstory: String
  }

  type Human implements Character {
    id: String!
    name: String
    friends: [Character]
    appearsIn: [Episode]
    homePlanet: String
    secretBackstory: String
  }

  type Droid implements Character {
    id: String!
    name: String
    friends: [Character]
    appearsIn: [Episode]
    primaryFunction: String
    secretBackstory: String
  }

  type Query {
    hero(episode: Episode): Character
    human(id: String!): Human
    droid(id: String!): Droid
  }
`;

export const STAR_WARS_SCHEMA: GraphQLSchema = buildSchema(STAR_WARS_SDL);

type Character = {
  __typename__: "Human" | "Droid";
  id: string;
  name: string;
  friends: string[];
  appearsIn: string[];
  homePlanet?: string | null;
  primaryFunction?: string | null;
};

const luke: Character = {
  __typename__: "Human",
  id: "1000",
  name: "Luke Skywalker",
  friends: ["1002", "1003", "2000", "2001"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  homePlanet: "Tatooine",
};

const vader: Character = {
  __typename__: "Human",
  id: "1001",
  name: "Darth Vader",
  friends: ["1004"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  homePlanet: "Tatooine",
};

const han: Character = {
  __typename__: "Human",
  id: "1002",
  name: "Han Solo",
  friends: ["1000", "1003", "2001"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  homePlanet: null,
};

const leia: Character = {
  __typename__: "Human",
  id: "1003",
  name: "Leia Organa",
  friends: ["1000", "1002", "2000", "2001"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  homePlanet: "Alderaan",
};

const tarkin: Character = {
  __typename__: "Human",
  id: "1004",
  name: "Wilhuff Tarkin",
  friends: ["1001"],
  appearsIn: ["NEWHOPE"],
  homePlanet: null,
};

const c3po: Character = {
  __typename__: "Droid",
  id: "2000",
  name: "C-3PO",
  friends: ["1000", "1002", "1003", "2001"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  primaryFunction: "Protocol",
};

const artoo: Character = {
  __typename__: "Droid",
  id: "2001",
  name: "R2-D2",
  friends: ["1000", "1002", "1003"],
  appearsIn: ["NEWHOPE", "EMPIRE", "JEDI"],
  primaryFunction: "Astromech",
};

export const STAR_WARS_DATA: Readonly<Record<string, Character>> = Object.freeze({
  "1000": luke,
  "1001": vader,
  "1002": han,
  "1003": leia,
  "1004": tarkin,
  "2000": c3po,
  "2001": artoo,
});

class FriendsResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((character) => {
      const c = character as Character;
      return c.friends.map((id) => STAR_WARS_DATA[id]);
    });
  }
}

class SecretBackstoryResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects(() => {
      return new ExecutionError("secretBackstory is secret.", { execField });
    });
  }
}

class HeroResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects(() => {
      if (execField.arguments["episode"] === "EMPIRE") {
        return STAR_WARS_DATA["1000"];
      }
      return STAR_WARS_DATA["2001"];
    });
  }
}

class HumanResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects(() => {
      const id = execField.arguments["id"] as string;
      const character = STAR_WARS_DATA[id];
      return character && character.__typename__ === "Human" ? character : null;
    });
  }
}

class DroidResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects(() => {
      const id = execField.arguments["id"] as string;
      const character = STAR_WARS_DATA[id];
      return character && character.__typename__ === "Droid" ? character : null;
    });
  }
}

export const STAR_WARS_RESOLVERS: ResolverMap = {
  Character: {
    id: new ObjectKeyResolver("id"),
    name: new ObjectKeyResolver("name"),
    friends: new FriendsResolver(),
    appearsIn: new ObjectKeyResolver("appearsIn"),
    secretBackstory: new SecretBackstoryResolver(),
    __type__: (obj) => {
      const o = obj as Character;
      switch (o?.__typename__) {
        case "Human":
          return STAR_WARS_SCHEMA.getType("Human") ?? null;
        case "Droid":
          return STAR_WARS_SCHEMA.getType("Droid") ?? null;
        default:
          return null;
      }
    },
  },
  Human: {
    id: new ObjectKeyResolver("id"),
    name: new ObjectKeyResolver("name"),
    friends: new FriendsResolver(),
    appearsIn: new ObjectKeyResolver("appearsIn"),
    homePlanet: new ObjectKeyResolver("homePlanet"),
    secretBackstory: new SecretBackstoryResolver(),
  },
  Droid: {
    id: new ObjectKeyResolver("id"),
    name: new ObjectKeyResolver("name"),
    friends: new FriendsResolver(),
    appearsIn: new ObjectKeyResolver("appearsIn"),
    primaryFunction: new ObjectKeyResolver("primaryFunction"),
    secretBackstory: new SecretBackstoryResolver(),
  },
  Query: {
    hero: new HeroResolver(),
    human: new HumanResolver(),
    droid: new DroidResolver(),
  },
};
