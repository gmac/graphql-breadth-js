// Memory profile: deep adjustable tree.
//
// Usage: pnpm run mem:tree
//   DEPTHS=1,10,18      Comma-separated tree depths (default: 1,10,18)
//   FIELDS=id           Comma-separated leaf fields per level (default: id)
//   ITERATIONS=2000     Per-shape iteration count (default: 2000)

import { parse, print } from "graphql";
import { envInts, envList } from "./bench.ts";
import { buildTree } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";
import { compareMemory, memProfile, memProfileAsync } from "./mem.js"

const depths = envInts("DEPTHS", "1,10,18");
const fields = envList("FIELDS", "id");
const iterations = parseInt(process.env.ITERATIONS ?? "2000", 10);
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
    console.log(`depth=${depth} fields=${fields.join(",")} iters=${iterations}`);

    const label = `depth ${depth} (${fields.join(", ")})`;
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
