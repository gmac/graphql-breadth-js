// Memory profile: shallow adjustable list.
//
// Usage: pnpm run mem:list
//   SIZES=100,1000      Comma-separated list sizes (default: 100,1000,10000)
//   FIELDS=id           Comma-separated fields per item (default: id)
//   ITERATIONS=2000     Per-shape iteration count (default: 2000)

import { parse, print } from "graphql";
import { envInts, envList } from "./bench.ts";
import { buildList } from "./data.ts";
import {
  execBreadth,
  execGraphQLJsAsync,
  execGraphQLJsSync,
  isAsyncFields,
  validateResultsMatch,
} from "./exec.ts";
import { compareMemory, memProfile, memProfileAsync } from "./mem.js"

const sizes = envInts("SIZES", "100,1000,10000");
const fields = envList("FIELDS", "id");
const iterations = parseInt(process.env.ITERATIONS ?? "2000", 10);
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
    console.log(`size=${size} fields=${fields.join(",")} iters=${iterations}`);

    const label = `${size} objects (${fields.join(", ")})`;
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
