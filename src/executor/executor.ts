import {
  DocumentNode,
  GraphQLObjectType,
  GraphQLSchema,
  Kind,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  GraphQLLeafType,
  GraphQLOutputType,
  GraphQLAbstractType,
  isAbstractType,
  isObjectType,
  isCompositeType,
  isListType,
  isNonNullType,
  parse,
  validate,
  getOperationAST,
  getVariableValues,
  GraphQLError,
} from "graphql";
import {
  DocumentError,
  ExecutionError,
  ImplementationError,
  InvalidListResultError,
  InvalidNullError,
  OperationTypeUnsupportedError,
  ResultCountMismatchError,
  UnknownLazyRejectionError,
  UNREPORTED_ERROR,
  type FormattedError,
} from "../errors";
import type { FieldResolver } from "../field_resolvers";
import { LazyLoader, type LazyLoaderConstructor } from "../lazy_loader";
import { isListLike, isThenable, unwrapNonNull, unwrapType, UNDEFINED } from "../util";
import { AbstractExecutionScope } from "./abstract_execution_scope";
import { ErrorResultFormatter } from "./error_result_formatter";
import { ExecutionField } from "./execution_field";
import { ExecutionPlanner } from "./execution_planner";
import { ExecutionPromise } from "./execution_promise";
import { ExecutionScope } from "./execution_scope";
import type { ResolverMap, TypeResolverFn } from "./types";

export interface BuildOptions {
  schema: GraphQLSchema;
  document: string | DocumentNode;
  resolvers?: ResolverMap;
  operationName?: string | null;
  variables?: Record<string, unknown>;
  rootObject?: unknown;
  context?: Record<string, unknown>;
  validateDocument?: boolean;
  defaultFieldResolver?: FieldResolver | null;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: FormattedError[];
  extensions?: Record<string, unknown>;
}

/**
 * Primay execution engine.
 */
export class Executor {
  schema: GraphQLSchema;
  document: DocumentNode;
  operation: OperationDefinitionNode;
  fragments: Record<string, FragmentDefinitionNode>;
  context: Record<string, unknown>;
  rootObject: unknown;
  variables: Record<string, unknown>;
  invalidatedResults: Map<unknown, ExecutionError> = new Map();
  abstractResultTypes: Map<unknown, GraphQLObjectType> = new Map();
  defaultFieldResolver: FieldResolver | null;

  private resolvers: ResolverMap;
  private validateDocument: boolean;
  private providedVariables: Record<string, unknown>;
  private operationName: string | null;

  private data: Record<string, unknown> = {};
  private resultPayload: Record<string, unknown> = {};
  private execQueue: ExecutionScope[] = [];
  private lazyQueue: ExecutionField[] = [];
  private executed = false;
  private aborted = false;
  private resultPromise: Promise<GraphQLResult> | null = null;
  // Nested cache: outer keyed by loader constructor (reference identity, fast),
  // inner keyed by JSON.stringify(args). The no-args case (the common one)
  // skips the inner stringify entirely.
  private loaderCache: Map<LazyLoaderConstructor, Map<string, LazyLoader>> = new Map();
  private _errorResultFormatter: ErrorResultFormatter | null = null;
  private _planner: ExecutionPlanner | null = null;

  static build(options: BuildOptions): Executor {
    const document =
      typeof options.document === "string" ? parse(options.document) : options.document;
    return new Executor({
      schema: options.schema,
      document,
      resolvers: options.resolvers ?? {},
      operationName: options.operationName ?? null,
      variables: options.variables ?? {},
      rootObject: options.rootObject ?? null,
      context: options.context ?? {},
      validateDocument: options.validateDocument !== false,
      defaultFieldResolver: options.defaultFieldResolver ?? null,
    });
  }

  constructor(options: {
    schema: GraphQLSchema;
    document: DocumentNode;
    resolvers: ResolverMap;
    operationName: string | null;
    variables: Record<string, unknown>;
    rootObject: unknown;
    context: Record<string, unknown>;
    validateDocument: boolean;
    defaultFieldResolver: FieldResolver | null;
  }) {
    this.schema = options.schema;
    this.document = options.document;
    this.resolvers = options.resolvers;
    this.operationName = options.operationName;
    this.providedVariables = options.variables;
    this.rootObject = options.rootObject;
    this.context = options.context;
    this.validateDocument = options.validateDocument;
    this.defaultFieldResolver = options.defaultFieldResolver;
    this.variables = {};
    this.fragments = {};

    for (const def of this.document.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        this.fragments[def.name.value] = def;
      }
    }

    const opAst = getOperationAST(this.document, this.operationName);
    if (!opAst) {
      throw new DocumentError(
        this.operationName
          ? `No operation named '${this.operationName}' in document`
          : "No operation in document",
      );
    }

    this.operation = opAst;
  }

  get result(): GraphQLResult | Promise<GraphQLResult> {
    if (this.resultPromise) return this.resultPromise;
    if (!this.executed) {
      const ret = this.execute();
      if (isThenable(ret)) {
        this.resultPromise = Promise.resolve(ret).then(
          () => this.resultPayload as GraphQLResult,
        );
        return this.resultPromise;
      }
    }
    return this.resultPayload as GraphQLResult;
  }

  get resultSync(): GraphQLResult {
    const r = this.result;
    if (isThenable(r)) {
      throw new ImplementationError(
        "Executor.resultSync requires synchronous execution, but an async " +
          "lazy loader was triggered. Use `result` and await it instead.",
      );
    }
    return r;
  }

  errorCount(): number {
    return this.invalidatedResults.size;
  }

  get planner(): ExecutionPlanner {
    if (!this._planner) {
      this._planner = new ExecutionPlanner({
        executor: this,
        resolvers: this.resolvers,
      });
    }
    return this._planner;
  }

  get errorResultFormatter(): ErrorResultFormatter {
    if (!this._errorResultFormatter) {
      this._errorResultFormatter = new ErrorResultFormatter({
        invalidatedResults: this.invalidatedResults,
        abstractResultTypes: this.abstractResultTypes,
        schema: this.schema,
        fragments: this.fragments,
      });
    }
    return this._errorResultFormatter;
  }

  lazyLoaderFor(
    loaderClass: LazyLoaderConstructor,
    args?: Record<string, unknown>,
  ): LazyLoader {
    let byArgs = this.loaderCache.get(loaderClass);
    if (!byArgs) {
      byArgs = new Map();
      this.loaderCache.set(loaderClass, byArgs);
    }
    const argsKey = args ? JSON.stringify(args) : "";
    let loader = byArgs.get(argsKey);
    if (!loader) {
      loader = args ? new loaderClass(args) : new loaderClass();
      byArgs.set(argsKey, loader);
    }
    return loader;
  }

  handleOrReraise(originalError: unknown, execField?: ExecutionField | null): ExecutionError {
    if (originalError instanceof ExecutionError) {
      return ExecutionError.from(originalError, { execField: execField ?? null });
    }
    if (originalError instanceof GraphQLError) {
      return ExecutionError.from(originalError.message, {
        execField: execField ?? null,
        cause: originalError,
      });
    }
    // No user-defined error handlers in the port — re-raise anything that isn't
    // a GraphQL-shaped error so it propagates out to the caller of `result`.
    throw originalError;
  }

  addError(
    error: ExecutionError,
    result: unknown = null,
    execField: ExecutionField | null = null,
  ): ExecutionError {
    if (execField) {
      let currentType: GraphQLOutputType = execField.type;
      while (isListLike(currentType)) {
        const unwrapped = isNonNullType(currentType)
          ? (currentType.ofType as GraphQLOutputType)
          : currentType;
        currentType = (unwrapped as { ofType: GraphQLOutputType }).ofType;
      }
      if (isNonNullType(currentType)) {
        const out = this.invalidateNonNullValue(execField, currentType, error);
        if (out instanceof ExecutionError) error = out;
      }
    }
    this.invalidatedResults.set(result ?? error, error);
    return error;
  }

  // ===== Main execute =====

  private execute(): void | Promise<void> {
    this.executed = true;

    if (this.validateDocument) {
      const validationErrors = validate(this.schema, this.document);
      if (validationErrors.length > 0) {
        this.resultPayload = this.renderResult({
          errors: validationErrors.map((e) => graphqlErrorToJSON(e)),
        });
        return;
      }
    }

    const coerced = getVariableValues(
      this.schema,
      this.operation.variableDefinitions ?? [],
      this.providedVariables,
    );
    if ("errors" in coerced && coerced.errors && coerced.errors.length > 0) {
      this.resultPayload = this.renderResult({
        errors: coerced.errors.map((e) => graphqlErrorToJSON(e)),
      });
      return;
    }
    this.variables = (coerced as { coerced: Record<string, unknown> }).coerced;

    let planned: ExecutionScope[];
    try {
      const rootScopes = this.buildRootScopes();
      if (rootScopes === null) {
        this.resultPayload = this.renderResult({
          errors: [new OperationTypeUnsupportedError(this.operation.operation).toJSON()],
        });
        return;
      }
      planned = this.planner.planScopes(rootScopes);
    } catch (ex) {
      this.finalizeErrorResult(ex);
      return;
    }

    return this.runScopes(planned, 0);
  }

  private runScopes(scopes: ExecutionScope[], startIdx: number): void | Promise<void> {
    for (let i = startIdx; i < scopes.length; i++) {
      this.execQueue.push(scopes[i] as ExecutionScope);
      try {
        const drained = this.drainLoop();
        if (isThenable(drained)) {
          const next = i + 1;
          return Promise.resolve(drained).then(
            () => this.runScopes(scopes, next),
            (ex) => this.finalizeErrorResult(ex),
          );
        }
      } catch (ex) {
        this.finalizeErrorResult(ex);
        return;
      }
    }
    this.finalizeSuccessResult();
  }

  private drainLoop(): void | Promise<void> {
    while (!this.aborted && (this.execQueue.length > 0 || this.lazyQueue.length > 0)) {
      if (this.execQueue.length > 0) {
        const scope = this.execQueue.shift() as ExecutionScope;
        this.executeScope(scope);
      } else {
        const lazyElements = this.lazyQueue;
        this.lazyQueue = [];
        const ret = this.executeLazy(lazyElements);
        if (isThenable(ret)) {
          return Promise.resolve(ret).then(() => this.drainLoop());
        }
      }
    }
  }

  private finalizeSuccessResult(): void {
    let resultData: unknown = UNDEFINED;
    let errors: FormattedError[] = [];
    if (this.invalidatedResults.size > 0) {
      const rootType = this.rootTypeForOperation(this.operation);
      const rootSelections = this.operation.selectionSet.selections;
      const [data, formattedErrors] = this.errorResultFormatter.formatObject(
        rootType,
        rootSelections,
        this.data,
      );
      this.data = data ?? {};
      resultData = data === null ? null : this.data;
      errors = formattedErrors;
    } else {
      resultData = this.data;
    }
    this.resultPayload = this.renderResult({ data: resultData, errors });
  }

  private finalizeErrorResult(ex: unknown): void {
    const errs: FormattedError[] = [];
    this.handleOrReraise(ex).each((e) => errs.push(e.toJSON()));
    this.resultPayload = this.renderResult({ data: null, errors: errs });
  }

  private renderResult(options: { data?: unknown; errors?: FormattedError[] } = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (options.errors && options.errors.length > 0) out["errors"] = options.errors;
    if (options.data !== UNDEFINED && options.data !== undefined) out["data"] = options.data;
    return out;
  }

  private rootTypeForOperation(op: OperationDefinitionNode): GraphQLObjectType {
    let t: GraphQLObjectType | null | undefined;
    switch (op.operation) {
      case "query":
        t = this.schema.getQueryType();
        break;
      case "mutation":
        t = this.schema.getMutationType();
        break;
    }
    if (!t) throw new OperationTypeUnsupportedError(op.operation);
    return t;
  }

  private buildRootScopes(): ExecutionScope[] | null {
    const op = this.operation;
    if (op.operation === "query") {
      const rootType = this.rootTypeForOperation(op);
      return [
        new ExecutionScope({
          executor: this,
          parentType: rootType,
          selections: op.selectionSet.selections,
          objects: [this.rootObject],
          results: [this.data],
        }),
      ];
    }
    if (op.operation === "mutation") {
      const rootType = this.rootTypeForOperation(op);
      const grouped = this.planner.selectionsGroupedByKey(rootType, op.selectionSet.selections);
      const scopes: ExecutionScope[] = [];
      for (const selections of grouped.values()) {
        scopes.push(
          new ExecutionScope({
            executor: this,
            parentType: rootType,
            selections: [...selections],
            objects: [this.rootObject],
            results: [this.data],
          }),
        );
      }
      return scopes;
    }
    return null;
  }

  // ===== Scope execution =====

  // Mark the scope as having run, then resolve each field on this level via
  // `executeField`. A scope may only be executed once; re-entry is an
  // implementation bug in the scheduler.
  private executeScope(scope: ExecutionScope): void {
    if (scope.objects.length === 0) return;
    if (scope.executed) {
      throw new ImplementationError(`Cannot re-execute ${scope.inspect()}`);
    }
    scope.executed = true;

    for (const field of scope.fields.values()) {
      if (!field.scope.aborted()) this.executeField(field);
    }
  }

  // ===== Field execution =====

  private executeField(field: ExecutionField): void {
    try {
      field.validate();
      field.result = field.resolver.resolve(field, this.context);
    } catch (e) {
      const fieldError = this.handleOrReraise(e, field);
      field.result = field.resolveAll(fieldError);
    }

    if (field.lazyResult()) {
      this.lazyQueue.push(field);
      this.buildFieldPlaceholder(field);
    } else {
      this.buildFieldResult(field);
    }
  }

  // ===== Lazy execution =====

  private executeLazy(lazyFields: ExecutionField[]): void | Promise<void> {
    const pendingLoaders: LazyLoader[] = [];
    for (const byArgs of this.loaderCache.values()) {
      for (const loader of byArgs.values()) {
        if (loader.promised.length > 0) pendingLoaders.push(loader);
      }
    }

    if (pendingLoaders.length === 0) {
      throw new ImplementationError(
        `Lazy ${lazyFields[0] && lazyFields[0].inspect()} produced a promise without a loader`,
      );
    }

    // abortedSubtree() memoizes positive results onto the scope (sets _aborted),
    // so repeated checks for the same aborted scope are O(1); negative checks
    // walk parents but the depth is typically shallow.
    const asyncRuns: Promise<void>[] = [];
    for (const loader of pendingLoaders) {
      const loaderFields = loader.promised.map((p) => p.field);
      if (loaderFields.every((f) => f.scope.abortedSubtree())) {
        loader.reset();
        continue;
      }

      try {
        if (loader.async) {
          const ret = loader.execute(this.context) as Promise<void>;
          const fields = loaderFields;
          asyncRuns.push(
            ret.then(undefined, (e) => {
              // handleOrReraise re-raises non-graphql errors → that throw
              // rejects the wrapper promise and propagates through Promise.all
              // up to the executor's drain loop.
              const handled = this.handleOrReraise(e);
              for (const field of fields) {
                const fieldErr = ExecutionError.from(handled, { execField: field });
                field.result = field.resolveAll(fieldErr);
              }
            }),
          );
        } else {
          loader.execute(this.context);
        }
      } catch (e) {
        const handled = this.handleOrReraise(e);
        for (const field of loaderFields) {
          const fieldErr = ExecutionError.from(handled, { execField: field });
          field.result = field.resolveAll(fieldErr);
        }
      }
    }

    const resumeAll = (): void => {
      for (const field of lazyFields) {
        if (field.scope.abortedSubtree()) continue;
        this.resumeLazyField(field);
      }
    };

    if (asyncRuns.length > 0) {
      return Promise.all(asyncRuns).then(resumeAll);
    }
    resumeAll();
  }

  private resumeLazyField(field: ExecutionField): void {
    if (field.lazyResult()) {
      try {
        const promise = field.result as ExecutionPromise<unknown>;
        if (this.promiseResolved(promise, field)) {
          field.result = promise.value();
        }
      } catch (e) {
        const err = e instanceof ExecutionError ? e : this.handleOrReraise(e, field);
        field.result = field.resolveAll(err);
      }
    }

    if (field.lazyResult()) {
      this.lazyQueue.push(field);
    } else {
      this.buildFieldResult(field);
    }
  }

  private promiseResolved(promise: ExecutionPromise<unknown>, field: ExecutionField): boolean {
    if (promise.resolved()) return true;
    if (promise.rejected()) {
      let rejection = promise.reason();
      if (!(rejection instanceof Error)) {
        rejection = new UnknownLazyRejectionError(
          `Lazy ${field.inspect()} was rejected for an unknown reason: ${rejection}`,
        );
      }
      throw this.handleOrReraise(rejection, field);
    }
    return false;
  }

  // ===== Result building =====

  private buildFieldPlaceholder(field: ExecutionField): void {
    const scopeResults = field.scope.results;
    for (const r of scopeResults) r[field.key] = UNDEFINED;
  }

  private buildFieldResult(field: ExecutionField): void {
    let resolvedObjects = field.result as unknown[];
    const parentObjects = field.scope.objects;
    const parentResults = field.scope.results;
    const fieldKey = field.key;
    const fieldType = field.type;
    const returnType = unwrapType(fieldType);

    if (!Array.isArray(resolvedObjects)) {
      const handled = this.handleOrReraise(
        new ResultCountMismatchError({
          execField: field,
          expectedCount: parentObjects.length,
          actualCount: -1,
        }),
      );
      for (const r of parentResults) r[fieldKey] = handled;
      this.addError(handled);
      return;
    }

    if (resolvedObjects.length !== parentObjects.length) {
      this.handleOrReraise(
        new ResultCountMismatchError({
          execField: field,
          expectedCount: parentObjects.length,
          actualCount: resolvedObjects.length,
        }),
      );
      resolvedObjects = field.resolveAll(null);
    }

    try {
      if (isCompositeType(returnType)) {
        const nextObjects: unknown[] = [];
        const nextResults: Record<string, unknown>[] = [];
        for (let i = 0; i < resolvedObjects.length; i++) {
          const obj = resolvedObjects[i];
          const result = parentResults[i] as Record<string, unknown>;
          result[fieldKey] = this.buildAndFlatmapCompositeResult(
            field,
            fieldType,
            obj,
            nextObjects,
            nextResults,
          );
        }

        if (isAbstractType(returnType)) {
          this.buildAbstractScopes(field, returnType as GraphQLAbstractType, nextObjects, nextResults);
        } else {
          const nextScope = this.planner.plannedScopeFor(field);
          if (nextScope) {
            nextScope.setObjects(nextObjects);
            nextScope.setResults(nextResults);
            if (nextObjects.length > 0) this.execQueue.push(nextScope);
          }
        }
      } else {
        for (let i = 0; i < resolvedObjects.length; i++) {
          const obj = resolvedObjects[i];
          const result = parentResults[i] as Record<string, unknown>;
          result[fieldKey] = this.buildLeafResult(field, fieldType, obj);
        }
      }
    } catch (e) {
      const fieldError = this.handleOrReraise(e, field);
      for (const r of parentResults) r[fieldKey] = fieldError;
      this.addError(fieldError);
    }
  }

  private buildAndFlatmapCompositeResult(
    field: ExecutionField,
    currentType: GraphQLOutputType,
    object: unknown,
    nextObjects: unknown[],
    nextResults: Record<string, unknown>[],
  ): unknown {
    if (object == null || object instanceof Error) {
      return this.buildMissingValue(field, currentType, object instanceof Error ? object : null);
    }
    if (isListLike(currentType)) {
      if (!Array.isArray(object)) {
        throw new InvalidListResultError({
          execField: field,
          resultType: typeof object,
        });
      }
      const inner = unwrapNonNull(currentType) as { ofType: GraphQLOutputType };
      return object.map((src) =>
        this.buildAndFlatmapCompositeResult(field, inner.ofType, src, nextObjects, nextResults),
      );
    }
    nextObjects.push(object);
    const result: Record<string, unknown> = {};
    nextResults.push(result);
    return result;
  }

  private buildLeafResult(
    field: ExecutionField,
    currentType: GraphQLOutputType,
    val: unknown,
  ): unknown {
    if (val == null || val instanceof Error) {
      return this.buildMissingValue(field, currentType, val instanceof Error ? val : null);
    }
    if (isListLike(currentType)) {
      if (!Array.isArray(val)) {
        throw new InvalidListResultError({
          execField: field,
          resultType: typeof val,
        });
      }
      const inner = unwrapNonNull(currentType) as { ofType: GraphQLOutputType };
      return val.map((item) => this.buildLeafResult(field, inner.ofType, item));
    }

    try {
      const leafType = unwrapType(currentType) as GraphQLLeafType;
      const coerced = leafType.serialize(val);
      if (coerced == null) return this.buildMissingValue(field, currentType, null);
      return coerced;
    } catch (e) {
      const err = this.handleOrReraise(e, field);
      return this.buildMissingValue(field, currentType, err);
    }
  }

  private buildMissingValue(
    field: ExecutionField,
    currentType: GraphQLOutputType,
    val: Error | null,
  ): unknown {
    let out: unknown = val;
    if (isNonNullType(currentType)) {
      out = this.invalidateNonNullValue(field, currentType, val);
    }
    if (out instanceof Error) {
      const handled = this.handleOrReraise(out, field);
      this.addError(handled);
      return handled;
    }
    return out;
  }

  private invalidateNonNullValue(
    field: ExecutionField,
    currentType: GraphQLOutputType,
    val: Error | null,
  ): unknown {
    this.propagateNull(field);

    if (val == null || val === UNREPORTED_ERROR) {
      const listItem = isListLike(field.type) && field.type !== currentType;
      return new InvalidNullError({ execField: field, listItem });
    }
    return val;
  }

  // ===== Abstract scope construction =====

  private buildAbstractScopes(
    field: ExecutionField,
    abstractType: GraphQLAbstractType,
    nextObjects: unknown[],
    nextResults: Record<string, unknown>[],
  ): void {
    const typeResolver = this.resolvers[abstractType.name]?.["__type__"] as
      | TypeResolverFn
      | undefined;
    const possibleTypes = new Set(this.schema.getPossibleTypes(abstractType));

    const nextObjectsByType = new Map<GraphQLObjectType, unknown[]>();
    const nextResultsByType = new Map<GraphQLObjectType, Record<string, unknown>[]>();

    for (let i = 0; i < nextObjects.length; i++) {
      const object = nextObjects[i];
      let objectType: GraphQLObjectType | null = null;

      if (typeResolver) {
        const resolved = typeResolver(object, this.context);
        if (resolved && isObjectType(resolved)) {
          objectType = resolved as GraphQLObjectType;
        } else if (typeof resolved === "string") {
          const named = this.schema.getType(resolved);
          if (named && isObjectType(named)) objectType = named;
        }
      }

      if (!objectType && object && typeof object === "object") {
        const declared = (object as { __typename?: string }).__typename;
        if (declared) {
          const named = this.schema.getType(declared);
          if (named && isObjectType(named)) objectType = named;
        }
      }

      if (!objectType || !possibleTypes.has(objectType)) {
        throw new ImplementationError(
          `Failed to resolve a concrete object type for \`${abstractType.name}.${field.name}\``,
        );
      }

      let bucketObjects = nextObjectsByType.get(objectType);
      let bucketResults = nextResultsByType.get(objectType);
      if (!bucketObjects) {
        bucketObjects = [];
        nextObjectsByType.set(objectType, bucketObjects);
      }
      if (!bucketResults) {
        bucketResults = [];
        nextResultsByType.set(objectType, bucketResults);
      }
      bucketObjects.push(object);
      const result = nextResults[i] as Record<string, unknown>;
      bucketResults.push(result);
      this.abstractResultTypes.set(result, objectType);
    }

    const abstractScope = new AbstractExecutionScope({
      parentType: abstractType,
      parentField: field,
      scopes: [],
    });
    for (const [nextType, objs] of nextObjectsByType) {
      abstractScope.scopes.push(
        new ExecutionScope({
          executor: this,
          abstraction: abstractScope,
          parentType: nextType,
          parentField: field,
          selections: field.selections(),
          objects: objs,
          results: nextResultsByType.get(nextType) ?? [],
        }),
      );
    }

    for (const scope of this.planner.planScopes(abstractScope.scopes)) {
      this.execQueue.push(scope);
    }
  }

  // ===== Null propagation =====

  /**
   * Propagate a null value up the scope tree to see if it reaches the top.
   * If it does, the entire executor is aborted — preventing subsequent root
   * (mutation) scopes from running.
   *
   * We can ONLY abort breadth resolvers when one of:
   *   1. null propagation reaches the root scope (total loss);
   *   2. there are no lists in the tree (no objects share breadth resolvers); or
   *   3. all lists in the tree are invalidated (every object sharing a
   *      resolver has been eliminated).
   *
   * The walk computes two depths:
   *   - `highestNulledDepth`: top of the *contiguous* non-null chain from the
   *     erroring field upward. Stops at the first nullable wrapper.
   *   - `highestListDepth`: highest list wrapper anywhere above this field.
   * The pair tells us whether condition (2) or (3) holds.
   */
  private propagateNull(field: ExecutionField): void {
    if (field.scope.aborted() || !field.propagatesNull()) return;

    let cur: ExecutionField | null = field;
    let propagating = true;
    let highestNulledDepth = field.scope.depth;
    let highestListDepth: number | null = null;

    while (cur) {
      if (cur.propagatesNull() && propagating) {
        highestNulledDepth = cur.scope.depth;
      } else {
        propagating = false;
      }
      if (isListType(cur.type)) {
        highestListDepth = cur.scope.depth;
      }
      cur = cur.scope.parentField;
    }

    if (highestNulledDepth === 0) {
      // Non-null propagation hit the top. Marking the executor aborted stops
      // any subsequent isolated root scopes (e.g. follow-up mutations) from running.
      this.aborted = true;
    } else if (highestListDepth === null || highestNulledDepth <= highestListDepth) {
      // Abort all non-null ancestor scopes up to (and including) the highest-level list.
      // Lists must be invalidated in their entirety, or they remain alive.
      let abortField: ExecutionField | null = field;
      while (abortField && highestNulledDepth <= abortField.scope.depth) {
        abortField.scope.abort();
        abortField = abortField.scope.parentField;
      }
      // Purge any aborted work from the pending queue.
      this.execQueue = this.execQueue.filter((s) => !s.abortedSubtree());
    }
  }
}

// =======================================================================
// Helpers
// =======================================================================

function graphqlErrorToJSON(e: GraphQLError): FormattedError {
  const h: FormattedError = { message: e.message };
  if (e.locations && e.locations.length > 0) {
    h.locations = e.locations.map((l) => ({ line: l.line, column: l.column }));
  }
  if (e.path && e.path.length > 0) {
    h.path = e.path.slice() as Array<string | number>;
  }
  if (e.extensions && Object.keys(e.extensions).length > 0) {
    h.extensions = { ...e.extensions };
  }
  // Validation/coercion errors arrive as graphql-js GraphQLError; carry the
  // source error so callers can inspect the original (non-enumerable).
  Object.defineProperty(h, "originalError", {
    value: e.originalError ?? e,
    enumerable: false,
    configurable: true,
  });
  return h;
}

