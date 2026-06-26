// Memory profile: tree-within-list (adjustable depth x breadth).
//
// Usage: pnpm run mem:tree-list
//   DEPTHS=1,5          Comma-separated tree depths (default: 1,5)
//   BREADTHS=100,1000   Comma-separated list sizes (default: 100,1000)
//   FIELDS=id           Comma-separated leaf fields per level (default: id)
//   ITERATIONS=1000     Per-shape iteration count (default: 1000)

import { parse, print } from "graphql";
import { envInts, envList } from "./bench.ts";
import { buildBreadthTree } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";
import { compareMemory, memProfile, memProfileAsync } from "./mem.js"

const depths = envInts("DEPTHS", "1,5");
const breadths = envInts("BREADTHS", "100,1000");
const fields = envList("FIELDS", "id");
const iterations = parseInt(process.env.ITERATIONS ?? "1000", 10);
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
      console.log(
        `depth=${depth} breadth=${breadth} fields=${fields.join(",")} iters=${iterations}`,
      );

      const label = `${depth}x${breadth} (${fields.join(", ")})`;
      const results = useAsync
        ? [
            await memProfileAsync(
              `graphql-js: ${label}`,
              () => execGraphQLJsAsync(document, source),
              iterations,
            ),
            await memProfile(
              `graphql-breadth: ${label}`,
              () => execBreadth(document, source),
              iterations,
            ),
          ]
        : [
            await memProfile(
              `graphql-js: ${label}`,
              () => execGraphQLJsSync(document, source),
              iterations,
            ),
            await memProfile(
              `graphql-breadth: ${label}`,
              () => execBreadth(document, source),
              iterations,
            ),
          ];
      compareMemory(results);
    }
  }
}
