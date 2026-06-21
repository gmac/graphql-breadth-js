import {
  Kind,
  isAbstractType,
  isLeafType,
  isNonNullType,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLAbstractType,
  type GraphQLCompositeType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type SelectionNode,
} from "graphql";
import { DocumentError, ImplementationError, UNREPORTED_ERROR, type FormattedError, type ExecutionError } from "../errors.js";
import { UNDEFINED, isListLike, unwrapNonNull, unwrapType } from "../util.js";

/**
 * Walks the executor's assembled result tree in depth-first order to
 * collect errors in the shape a GraphQL client expects. Errors were *inlined*
 * into the result tree during primary execution and may have over-reported.
 *
 * This formatter reconciles the spec view by traversing the result data depth-first
 * following the executed selection set. Any invalidated positions are collected
 * as a pathed error, then replaced with null and bubbled.
 *
 * The end result are spec-compliant errors following a depth-based pattern.
 * This formatter only runs when errors were _actually_ encountered during
 * execution (unhappy path).
 */
export class ErrorResultFormatter {
  private invalidatedResults: Map<unknown, ExecutionError>;
  private abstractResultTypes: Map<unknown, GraphQLObjectType>;
  private schema: GraphQLSchema;
  private fragments: Record<string, FragmentDefinitionNode>;

  private errors: FormattedError[] = [];
  private path: Array<string | number> = [];

  constructor(options: {
    invalidatedResults: Map<unknown, ExecutionError>;
    abstractResultTypes: Map<unknown, GraphQLObjectType>;
    schema: GraphQLSchema;
    fragments: Record<string, FragmentDefinitionNode>;
  }) {
    this.invalidatedResults = options.invalidatedResults;
    this.abstractResultTypes = options.abstractResultTypes;
    this.schema = options.schema;
    this.fragments = options.fragments;
  }

  formatObject(
    parentType: GraphQLObjectType,
    selections: ReadonlyArray<SelectionNode>,
    data: Record<string, unknown> | null,
  ): [Record<string, unknown> | null, FormattedError[]] {
    if (this.invalidatedResults.size === 0) return [data, []];

    if (data && this.invalidatedResults.has(data)) {
      this.addFormattedError(this.invalidatedResults.get(data)!);
      return [null, this.errors];
    }

    const result = this.propagateObjectScopeErrors(data, parentType, selections);
    return [result, this.errors];
  }

  private propagateObjectScopeErrors(
    rawObject: Record<string, unknown> | null,
    parentType: GraphQLObjectType,
    selections: ReadonlyArray<SelectionNode>,
  ): Record<string, unknown> | null {
    if (rawObject == null) return null;

    for (const node of selections) {
      switch (node.kind) {
        case Kind.FIELD: {
          const fieldKey = (node.alias?.value ?? node.name.value) as string;
          this.path.push(fieldKey);
          try {
            const fieldDef = parentType.getFields()[node.name.value];
            if (!fieldDef) continue;
            const nodeType = fieldDef.type;
            const namedType = unwrapType(nodeType);

            const rawValue = Object.hasOwn(rawObject, fieldKey)
              ? rawObject[fieldKey]
              : UNDEFINED;
            if (rawValue === UNDEFINED) continue;

            const invalidated = this.invalidatedResults.get(rawValue);
            let newValue: unknown;
            if (invalidated) {
              this.addFormattedError(invalidated);
              newValue = null;
            } else if (isListLike(nodeType)) {
              newValue = this.propagateListScopeErrors(
                rawValue as unknown[] | null,
                nodeType,
                (node as FieldNode).selectionSet?.selections ?? [],
              );
            } else if (isLeafType(namedType)) {
              newValue = rawValue;
            } else if (rawValue == null) {
              newValue = null;
            } else {
              newValue = this.propagateObjectScopeErrors(
                rawValue as Record<string, unknown>,
                this.concreteObjectTypeFor(rawValue, namedType as GraphQLCompositeType),
                (node as FieldNode).selectionSet?.selections ?? [],
              );
            }
            rawObject[fieldKey] = newValue;

            if (isNonNullType(nodeType) && rawObject[fieldKey] == null) return null;
          } finally {
            this.path.pop();
          }
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          const fragmentType = node.typeCondition
            ? (this.schema.getType(node.typeCondition.name.value) as GraphQLCompositeType)
            : parentType;
          if (!this.resultOfType(parentType, fragmentType)) continue;
          if (this.propagateObjectScopeErrors(rawObject, parentType, node.selectionSet.selections) == null) {
            return null;
          }
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragment = this.fragments[node.name.value];
          if (!fragment) continue;
          const fragmentType = this.schema.getType(fragment.typeCondition.name.value) as GraphQLCompositeType;
          if (!this.resultOfType(parentType, fragmentType)) continue;
          if (this.propagateObjectScopeErrors(rawObject, parentType, fragment.selectionSet.selections) == null) {
            return null;
          }
          break;
        }
        default:
          throw new DocumentError("Invalid selection node type");
      }
    }

    return rawObject;
  }

  private propagateListScopeErrors(
    rawList: unknown[] | null,
    currentNodeType: GraphQLOutputType,
    selections: ReadonlyArray<SelectionNode>,
  ): unknown[] | null {
    if (rawList == null) return null;
    const itemNodeType = (unwrapNonNull(currentNodeType) as { ofType: GraphQLOutputType }).ofType;
    const namedType = unwrapType(itemNodeType);

    for (let index = 0; index < rawList.length; index++) {
      const raw = rawList[index];
      this.path.push(index);
      try {
        const invalidated = this.invalidatedResults.get(raw);
        let result: unknown;
        if (invalidated) {
          this.addFormattedError(invalidated);
          result = null;
        } else if (isListLike(itemNodeType)) {
          result = this.propagateListScopeErrors(raw as unknown[] | null, itemNodeType, selections);
        } else if (isLeafType(namedType)) {
          result = raw;
        } else if (raw == null) {
          result = null;
        } else {
          result = this.propagateObjectScopeErrors(
            raw as Record<string, unknown>,
            this.concreteObjectTypeFor(raw, namedType as GraphQLCompositeType),
            selections,
          );
        }
        if (result == null && isNonNullType(itemNodeType)) return null;
        rawList[index] = result;
      } finally {
        this.path.pop();
      }
    }
    return rawList;
  }

  // Resolves the concrete runtime type for a composite-typed result. Returns
  // the declared type when concrete, or looks the result up in
  // `abstractResultTypes` (populated by the executor) when the declared type
  // is abstract.
  private concreteObjectTypeFor(
    result: unknown,
    declaredType: GraphQLCompositeType,
  ): GraphQLObjectType {
    if (!isAbstractType(declaredType)) return declaredType as GraphQLObjectType;
    const concrete = this.abstractResultTypes.get(result);
    if (!concrete) {
      throw new ImplementationError("No type annotation recorded for abstract result");
    }
    return concrete;
  }

  private resultOfType(
    currentType: GraphQLObjectType,
    inquiryType: GraphQLCompositeType,
  ): boolean {
    if (isAbstractType(inquiryType)) {
      return this.schema
        .getPossibleTypes(inquiryType as GraphQLAbstractType)
        .some((t) => t === currentType);
    }
    return currentType === inquiryType;
  }

  private addFormattedError(error: ExecutionError): void {
    error.each((err) => {
      if (err === UNREPORTED_ERROR) return;
      const e = err.toJSON();
      e.path = [...this.path];
      this.errors.push(e);
    });
  }
}
