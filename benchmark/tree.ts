// Deep adjustable tree benchmark.
//
// Usage: pnpm run bench:tree
//   DEPTHS=1,10,18    Comma-separated tree depths (default: 1,10,18)
//   FIELDS=id,string  Comma-separated leaf fields per level (default: id)
//
// Generated query shape (per depth):
//   query {
//     widget {
//       widget {
//         #  ... depth x N ...
//         id
//       }
//       id
//     }
//   }

import { parse, print } from "graphql";
import { bench, benchAsync, compare, envInts, envList } from "./bench.ts";
import { buildTree } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";

const depths = envInts("DEPTHS", "1,10,18");
const fields = envList("FIELDS", "id");
const useAsync = isAsyncFields(fields);

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  for (const depth of depths) {
    const { query, source } = buildTree(depth, fields);
    const document = parse(`{ ${query} }`);

    await validateResultsMatch(document, source, fields);

    console.log(`\n${print(document)}`);
    console.log(`depth=${depth} fields=${fields.join(",")}`);

    const label = `depth ${depth} (${fields.join(", ")})`;
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
