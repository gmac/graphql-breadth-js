// Tree-within-list benchmark: adjustable-depth tree inside an adjustable-breadth list.
//
// Usage: pnpm run bench:tree-list
//   DEPTHS=1,18       Comma-separated tree depths (default: 1,18)
//   BREADTHS=1,100    Comma-separated list sizes (default: 1,100)
//   FIELDS=id,string  Comma-separated leaf fields per level (default: id)
//
// Generated query shape (per depth x breadth):
//   query {
//     widgets(first: B) {
//       widget {
//         widget {
//           #  ... depth x D ...
//           id
//         }
//         id
//       }
//       id
//     }
//   }

import { parse, print } from "graphql";
import { bench, benchAsync, compare, envInts, envList } from "./bench.ts";
import { buildBreadthTree } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";

const depths = envInts("DEPTHS", "1,18");
const breadths = envInts("BREADTHS", "1,100,1000,10000");
const fields = envList("FIELDS", "id");
const useAsync = isAsyncFields(fields);

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  for (const depth of depths) {
    for (const breadth of breadths) {
      const { query, source } = buildBreadthTree(depth, breadth, fields);
      const document = parse(`{ ${query} }`);

      await validateResultsMatch(document, source, fields);

      console.log(`\n${print(document).replace("widgets {", `widgets { # x${breadth}`)}`);
      console.log(`depth=${depth} breadth=${breadth} fields=${fields.join(",")}`);

      const label = `${depth}x${breadth} (${fields.join(", ")})`;
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
}
