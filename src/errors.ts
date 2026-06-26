import type { ASTNode } from "graphql";
import type { ExecutionField } from "./executor/execution_field.ts";

export type ErrorPath = Array<string | number>;
export type Extensions = Record<string, unknown>;

export interface FormattedError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: ErrorPath;
  extensions?: Extensions;
  /**
   * The original error this was derived from (the resolver's thrown error / the
   * `cause`), attached non-enumerably so it never serializes onto the wire but is
   * available to callers that need to inspect the source — e.g. an error masker
   * doing `instanceof` checks on framework error classes. Populated by
   * {@link ExecutionError.toJSON}.
   */
  originalError?: unknown;
}

export class BreadthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DocumentError extends BreadthError {}
export class ImplementationError extends BreadthError {}
export class MethodNotImplementedError extends BreadthError {}

export interface ExecutionErrorOptions {
  execField?: ExecutionField | null;
  nodes?: ReadonlyArray<ASTNode>;
  extensions?: Extensions | null;
  cause?: unknown;
}

const EMPTY_NODES: ReadonlyArray<ASTNode> = Object.freeze([]);

export class ExecutionError extends BreadthError {
  static errorCode: string | null = null;
  static DEFAULT_MESSAGE = "An unknown error occurred";

  execField: ExecutionField | null;
  override cause: unknown;
  protected _nodes: ReadonlyArray<ASTNode>;
  extensions: Extensions | null;

  constructor(message?: string | null, options: ExecutionErrorOptions = {}) {
    super(message || (new.target as typeof ExecutionError).DEFAULT_MESSAGE);
    this.execField = options.execField ?? null;
    this.cause = options.cause;
    this._nodes = options.nodes ?? EMPTY_NODES;
    this.extensions = options.extensions ?? null;

    const code = (this.constructor as typeof ExecutionError).errorCode;
    if (code) {
      this.extensions = this.extensions ?? {};
      if (!("code" in this.extensions)) this.extensions["code"] = code;
    }
  }

  static from(
    err: unknown,
    options: { execField?: ExecutionField | null; cause?: unknown } = {},
  ): ExecutionError {
    if (err instanceof ExecutionError) {
      if (err === UNREPORTED_ERROR) return err;
      if (err.execField !== (options.execField ?? null) || err.cause !== options.cause) {
        const dup = Object.create(Object.getPrototypeOf(err)) as ExecutionError;
        // `Object.assign` only copies enumerable own properties, but V8 stores
        // `message` and `stack` as non-enumerable own properties on Error
        // instances — they would be lost. Copy via property descriptors instead.
        Object.defineProperties(dup, Object.getOwnPropertyDescriptors(err));
        if (options.execField !== undefined) dup.execField = options.execField ?? null;
        if (options.cause !== undefined) dup.cause = options.cause;
        return dup;
      }
      return err;
    }
    if (err instanceof Error) {
      return new ExecutionError(err.message, {
        execField: options.execField,
        cause: options.cause ?? err,
      });
    }
    if (typeof err === "string") {
      return new ExecutionError(err, options);
    }
    return new ExecutionError(undefined, options);
  }

  get nodes(): ReadonlyArray<ASTNode> {
    if (this._nodes.length === 0 && this.execField) {
      return this.execField.nodes;
    }
    return this._nodes;
  }

  set nodes(value: ReadonlyArray<ASTNode>) {
    this._nodes = value;
  }

  toJSON(): FormattedError {
    const formatted: FormattedError = { message: this.message };
    const nodes = this.nodes;
    if (nodes.length > 0) {
      formatted.locations = nodes.flatMap((n) => {
        const loc = (n as ASTNode).loc;
        if (!loc) return [];
        const source = loc.source;
        const startToken = loc.startToken;
        return [{ line: startToken.line, column: startToken.column }];
      });
      if (formatted.locations.length === 0) delete formatted.locations;
    }
    if (this.extensions && Object.keys(this.extensions).length > 0) {
      formatted.extensions = JSON.parse(JSON.stringify(this.extensions));
    }
    // Preserve the source error (non-enumerable, so it does not serialize) so
    // callers can recover the original thrown error instance.
    Object.defineProperty(formatted, "originalError", {
      value: this.cause ?? this,
      enumerable: false,
      configurable: true,
    });
    return formatted;
  }

  each(callback: (err: ExecutionError) => void): void {
    callback(this);
  }
}

export class ExecutionErrorSet extends ExecutionError {
  errors: ExecutionError[];

  constructor(
    message: string | null | undefined,
    options: ExecutionErrorOptions & { errors?: ExecutionError[] } = {},
  ) {
    const errors = options.errors ?? [];
    super(message ?? errors.map((e) => e.message).join(", "), options);
    this.errors = errors;
  }

  override get nodes(): ReadonlyArray<ASTNode> {
    return this.errors.flatMap((e) => e.nodes);
  }

  override each(callback: (err: ExecutionError) => void): void {
    this.errors.forEach(callback);
  }
}

export class InvalidNullError extends ExecutionError {
  static override errorCode = "INVALID_NULL";

  constructor(options: { execField: ExecutionField; listItem?: boolean }) {
    const ef = options.execField;
    const message = options.listItem
      ? `Cannot return null for non-nullable element of type '${describeListItemType(ef)}' for ${ef.scope.parentType.name}.${ef.name}`
      : `Cannot return null for non-nullable field ${ef.scope.parentType.name}.${ef.name}`;
    super(message, { execField: ef });
  }
}

export class OperationTypeUnsupportedError extends ExecutionError {
  operationType: string;

  constructor(operationType: string) {
    super("Unsupported operation type");
    this.operationType = operationType;
  }

  override toJSON(): FormattedError {
    const formatted = super.toJSON();
    formatted.path = [this.operationType];
    return formatted;
  }
}

export class InvalidListResultError extends ImplementationError {
  resultType: string;
  execField: ExecutionField;

  constructor(options: { execField: ExecutionField; resultType: string }) {
    super(
      `Incorrect result for list field \`${options.execField.path.join(".")}\`. Expected Array, got \`${options.resultType}\``,
    );
    this.execField = options.execField;
    this.resultType = options.resultType;
  }
}

export class ResultCountMismatchError extends ImplementationError {
  execField: ExecutionField;
  expectedCount: number;
  actualCount: number;

  constructor(options: {
    execField: ExecutionField;
    expectedCount: number;
    actualCount: number;
  }) {
    super(
      `Incorrect number of results for field \`${options.execField.path.join(".")}\`. Expected ${options.expectedCount}, got ${options.actualCount}.`,
    );
    this.execField = options.execField;
    this.expectedCount = options.expectedCount;
    this.actualCount = options.actualCount;
  }
}

export class UnknownLazyRejectionError extends ImplementationError {}

// Special error instance that does not get reported in errors
export const UNREPORTED_ERROR: ExecutionError = (() => {
  const e = new ExecutionError("__UNREPORTED_ERROR__");
  Object.freeze(e);
  return e;
})();

function describeListItemType(execField: ExecutionField): string {
  // Walk past list+nonnull wrappers and produce a graphql-js style type signature for the inner element type.
  let type: unknown = execField.type;
  // best-effort: import-free implementation
  const t = type as { toString?: () => string };
  return t.toString ? t.toString() : "<unknown>";
}
