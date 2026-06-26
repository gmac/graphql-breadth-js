// Shallow adjustable list benchmark.
//
// Usage: pnpm run bench:list
//   SIZES=1,10,100,250    Comma-separated list sizes (default: 1,10,100,250)
//   FIELDS=id,string      Comma-separated fields per item (default: id)
//
// Generated query shape (per size):
//   query {
//     widgets(first: N) {
//       id
//     }
//   }

import { parse, print } from "graphql";
import { bench, benchAsync, compare, envInts, envList } from "./bench.ts";
import { buildList } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";

const sizes = envInts("SIZES", "1,10,100,1000,10000");
const fields = envList("FIELDS", "id");
const useAsync = isAsyncFields(fields);

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  for (const size of sizes) {
    const { query, source } = buildList(size, fields);
    const document = parse(`{ ${query} }`);

    await validateResultsMatch(document, source, fields);

    console.log(`\n${print(document)}`);
    console.log(`size=${size} fields=${fields.join(",")}`);

    const label = `${size} objects (${fields.join(", ")})`;
    const results = useAsync
      ? [
          await benchAsync(`graphql-js: ${label}`, () =>
            execGraphQLJsAsync(document, source),
          ),
          bench(`graphql-breadth: ${label}`, () =>
            execBreadth(document, source),
          ),
        ]
      : [
          bench(`graphql-js: ${label}`, () =>
            execGraphQLJsSync(document, source),
          ),
          bench(`graphql-breadth: ${label}`, () =>
            execBreadth(document, source),
          ),
        ];
    compare(results);
  }
}
