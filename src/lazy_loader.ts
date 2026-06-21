import { ImplementationError, MethodNotImplementedError } from "./errors.js";
import { ExecutionPromise, Deferred } from "./executor/execution_promise.js";
import type { ExecutionField } from "./executor/execution_field.js";

const KEY_OMISSION: unique symbol = Symbol("KEY_OMISSION");
type KeyOmission = typeof KEY_OMISSION;

class LazyFulfillment {
  field: ExecutionField;
  keys: unknown[];
  identities: Array<unknown | KeyOmission>;
  eagers: Map<unknown, unknown> | null;
  promise: ExecutionPromise<unknown[]>;
  private resolver!: (value: unknown[] | ExecutionPromise<unknown[]>) => void;

  constructor(options: {
    field: ExecutionField;
    keys: unknown[];
    identities: Array<unknown | KeyOmission>;
    eagers?: Map<unknown, unknown> | null;
    preDeferred?: Deferred<unknown[]> | null;
  }) {
    this.field = options.field;
    this.keys = options.keys;
    this.identities = options.identities;
    this.eagers = options.eagers ?? null;
    if (options.preDeferred) {
      this.promise = options.preDeferred.promise;
      this.resolver = options.preDeferred.resolver;
    } else {
      this.promise = new ExecutionPromise<unknown[]>((resolve) => {
        this.resolver = resolve;
      });
    }
  }

  resolve(results: unknown[]): void {
    this.resolver(results);
  }
}

export interface LazyLoaderConstructor {
  new (args?: Record<string, unknown>): LazyLoader;
}

/**
 * A breadth-native dataloader pattern. Always enqueues a _set_ of keys
 * (versus keys requested individually), and binds the complete keyset
 * to a single promise. Eliminates promise bloat across list fields that
 * share common I/O operations. Results in a promise _per document selection_
 * rather than one _per field instance_.
 */
export abstract class LazyLoader<Ctx = unknown> {
  pendingKeysByIdentity: Map<unknown, unknown> = new Map();
  resultsByIdentity: Map<unknown, unknown> = new Map();
  promised: LazyFulfillment[] = [];

  // Mode flags select how the loader's perform method delivers results.
  //   - `async === true`  → loader implements `performAsync`, which returns a Promise.
  //                         The executor awaits it before resolving any waiting fields.
  //   - `async === false` → loader implements `perform`, sync.
  //
  //   - `map === true`    → perform's return value IS the result array, in 1:1 order with
  //                         the pending keys. The executor writes it into results by identity.
  //   - `map === false`   → perform's return value is ignored. Implementations fulfill results
  //                         via `fulfillKey` / `fulfillIdentity`.
  //
  // The flags are orthogonal: `async + map` is a valid combination (an async loader whose
  // resolved value is the cardinality-matched result array).
  map = false;
  async = false;

  perform(_keys: unknown[], _context: Ctx): unknown[] | void {
    throw new MethodNotImplementedError(
      "LazyLoader#perform must be implemented",
    );
  }

  performAsync(_keys: unknown[], _context: Ctx): Promise<unknown[] | void> {
    throw new MethodNotImplementedError(
      "LazyLoader#performAsync must be implemented",
    );
  }

  identityFor(key: unknown): unknown {
    return key;
  }

  fulfillKey(key: unknown, result: unknown): void {
    this.resultsByIdentity.set(this.identityFor(key), result);
  }

  fulfillIdentity(identity: unknown, result: unknown): void {
    this.resultsByIdentity.set(identity, result);
  }

  load(options: {
    field: ExecutionField;
    keys: unknown[];
    eager?: Map<unknown, unknown> | null;
    loadNilKeys?: boolean;
    preDeferred?: Deferred<unknown[]> | null;
  }): ExecutionPromise<unknown[]> {
    let eager = options.eager ?? null;
    if (eager && eager.size === 0) eager = null;
    const compact = !options.loadNilKeys;
    const pending = this.pendingKeysByIdentity;
    const results = this.resultsByIdentity;

    const identities: Array<unknown | KeyOmission> = options.keys.map((key) => {
      if ((compact && key == null) || (eager && eager.has(key))) {
        return KEY_OMISSION;
      }
      const identity = this.identityFor(key);
      if (!results.has(identity) && !pending.has(identity)) {
        pending.set(identity, key);
      }
      return identity;
    });

    const fulfillment = new LazyFulfillment({
      field: options.field,
      keys: options.keys,
      identities,
      eagers: eager,
      preDeferred: options.preDeferred ?? null,
    });
    this.promised.push(fulfillment);
    return fulfillment.promise;
  }

  collectResults(deferred: LazyFulfillment): unknown[] {
    const identities = deferred.identities;
    const eagers = deferred.eagers;
    const results = this.resultsByIdentity;
    if (eagers) {
      const keys = deferred.keys;
      return identities.map((identity, i) =>
        identity === KEY_OMISSION ? eagers.get(keys[i]) : results.get(identity),
      );
    }
    return identities.map((identity) => results.get(identity));
  }

  execute(context: Ctx): void | Promise<void> {
    const deferreds = this.promised;
    if (this.pendingKeysByIdentity.size === 0) {
      this.reset();
      for (const deferred of deferreds) {
        deferred.resolve(this.collectResults(deferred));
      }
      return;
    }

    const pendingKeys = Array.from(this.pendingKeysByIdentity.values());
    const pendingIdentities = this.map
      ? Array.from(this.pendingKeysByIdentity.keys())
      : null;
    this.reset();

    const finalize = (ret: unknown[] | void): void => {
      if (this.map) {
        const results = ret as unknown[];
        if (pendingKeys.length !== results.length) {
          throw new ImplementationError(
            `Wrong number of results. Expected ${pendingKeys.length}, got ${results.length}`,
          );
        }
        const identities = pendingIdentities as unknown[];
        for (let i = 0; i < identities.length; i++) {
          this.resultsByIdentity.set(identities[i], results[i]);
        }
      }
      for (const deferred of deferreds) {
        deferred.resolve(this.collectResults(deferred));
      }
    };

    if (this.async) {
      return Promise.resolve(this.performAsync(pendingKeys, context)).then(finalize);
    }
    finalize(this.perform(pendingKeys, context));
  }

  reset(): void {
    this.pendingKeysByIdentity.clear();
    this.promised = [];
  }
}
