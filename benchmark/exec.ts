import {
  execute as graphqlExecute,
  executeSync as graphqlExecuteSync,
  type DocumentNode,
  type ExecutionResult,
} from "graphql";
import { Executor } from "../src/index.js";
import { schema, createBenchContext } from "./schema.js";
import { breadthResolvers } from "./resolvers.js";

const LAZY_FIELDS = new Set(["lazy", "lazyThen"]);

export function isAsyncFields(fields: string[]): boolean {
  return fields.some((f) => LAZY_FIELDS.has(f));
}

export function execGraphQLJsSync(
  document: DocumentNode,
  rootValue: unknown,
): ExecutionResult {
  return graphqlExecuteSync({
    schema,
    document,
    rootValue,
    contextValue: createBenchContext(),
  });
}

export async function execGraphQLJsAsync(
  document: DocumentNode,
  rootValue: unknown,
): Promise<ExecutionResult> {
  return graphqlExecute({
    schema,
    document,
    rootValue,
    contextValue: createBenchContext(),
  });
}

export function execBreadth(
  document: DocumentNode,
  rootObject: unknown,
): ExecutionResult {
  return Executor.build({
    schema,
    document,
    resolvers: breadthResolvers,
    rootObject,
    validateDocument: false,
  }).result as ExecutionResult;
}

// Sanity check that both executors produce equivalent output before benchmarking.
export async function validateResultsMatch(
  document: DocumentNode,
  rootValue: unknown,
  fields: string[],
): Promise<void> {
  const jsResult = isAsyncFields(fields)
    ? await execGraphQLJsAsync(document, rootValue)
    : execGraphQLJsSync(document, rootValue);
  const breadthResult = execBreadth(document, rootValue);
  const jsJson = JSON.stringify(jsResult.data);
  const breadthJson = JSON.stringify(breadthResult.data);
  if (jsJson !== breadthJson) {
    console.error("graphql-js result:", jsJson);
    console.error("graphql-breadth result:", breadthJson);
    throw new Error("Result mismatch between graphql-js and graphql-breadth");
  }
}
