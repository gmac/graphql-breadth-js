import {
  Kind,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
  isAbstractType,
  isLeafType,
  getArgumentValues,
  GraphQLError,
  type DirectiveNode,
  type FieldNode,
  type FragmentSpreadNode,
  type GraphQLAbstractType,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLObjectType,
  type InlineFragmentNode,
  type SelectionNode,
  type ValueNode,
} from "graphql";
import { DocumentError, ExecutionError } from "../errors.js";
import { FieldResolver, ObjectKeyResolver } from "../field_resolvers.js";
import {
  ENTRYPOINT_RESOLVERS as INTROSPECTION_ENTRYPOINT_RESOLVERS,
  TYPENAME_RESOLVER as INTROSPECTION_TYPENAME_RESOLVER,
  TYPE_RESOLVERS as INTROSPECTION_TYPE_RESOLVERS,
} from "../introspection.js";
import { unwrapType } from "../util.js";
import { ExecutionField } from "./execution_field.js";
import { ExecutionScope } from "./execution_scope.js";
import type { Executor } from "./executor.js";
import type { ResolverMap } from "./types.js";

/**
 * Builds the breadth-first execution tree for a set of concrete scopes, and runs the
 * bottom-up planning pass. Planning happens once per static/concrete AST branch.
 * Abstract branches are omitted from planning and get built lazily once they
 * resolve into concrete type selections. ExecutionScopes always have a concrete type.
 *
 * Building an execution tree runs top-down, while calling each built resolver's
 * `plan()` method runs bottom-up. This pre-flight pass gives children the
 * opportunity to annotate their parents before the parents resolve.
 *
 * Execution trees are intentionally designed to only be navigated upward.
 * Looking down an execution tree will surface ambiguous abstract positions.
 */
export class ExecutionPlanner {
  private executor: Executor;
  private resolvers: ResolverMap;

  // Hide downward tree access. Navigation should not allow walking ahead into
  // parts that haven't executed; only behind into parts that have executed.
  private plannedScopesByField: Map<ExecutionField, ExecutionScope> = new Map();

  constructor(options: { executor: Executor; resolvers: ResolverMap }) {
    this.executor = options.executor;
    this.resolvers = options.resolvers;
  }

  plannedScopeFor(field: ExecutionField): ExecutionScope | undefined {
    return this.plannedScopesByField.get(field);
  }

  planScopes(scopes: ExecutionScope[]): ExecutionScope[] {
    const active = scopes.filter((s) => s.objects.length > 0);
    if (active.length === 0) return active;
    for (const scope of active) {
      const ordered = this.buildExecutionTree(scope);
      // bottom-up planning hooks
      for (let i = ordered.length - 1; i >= 0; i--) {
        const f = ordered[i]!;
        f.resolver.plan(f, this.executor.context);
      }
    }
    return active;
  }

  selectionsGroupedByKey(
    parentType: GraphQLCompositeType,
    selections: ReadonlyArray<SelectionNode>,
  ): Map<string, FieldNode[]> {
    const map = new Map<string, FieldNode[]>();
    this.collectFieldsByKey(map, parentType, selections);
    return map;
  }

  private collectFieldsByKey(
    map: Map<string, FieldNode[]>,
    parentType: GraphQLCompositeType,
    selections: ReadonlyArray<SelectionNode>,
  ): void {
    for (const node of selections) {
      if (this.nodeSkipped(node)) continue;

      switch (node.kind) {
        case Kind.FIELD: {
          const fieldNode = node as FieldNode;
          const key = (fieldNode.alias?.value ?? fieldNode.name.value);
          let list = map.get(key);
          if (!list) {
            list = [];
            map.set(key, list);
          }
          list.push(fieldNode);
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          const frag = node as InlineFragmentNode;
          const fragmentType = frag.typeCondition
            ? (this.executor.schema.getType(frag.typeCondition.name.value) as GraphQLCompositeType)
            : parentType;
          if (this.parentTypeIsPossible(fragmentType, parentType)) {
            this.collectFieldsByKey(map, parentType, frag.selectionSet.selections);
          }
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const spread = node as FragmentSpreadNode;
          const fragment = this.executor.fragments[spread.name.value];
          if (!fragment) continue;
          const fragmentType = this.executor.schema.getType(
            fragment.typeCondition.name.value,
          ) as GraphQLCompositeType;
          if (this.parentTypeIsPossible(fragmentType, parentType)) {
            this.collectFieldsByKey(map, parentType, fragment.selectionSet.selections);
          }
          break;
        }
        default:
          throw new DocumentError("Invalid selection node type");
      }
    }
  }

  private buildExecutionTree(
    scope: ExecutionScope,
    ordered: ExecutionField[] = [],
  ): ExecutionField[] {
    const selectionsByKey = this.selectionsGroupedByKey(scope.parentType, scope.selections);

    for (const [key, nodes] of selectionsByKey) {
      const field = this.buildExecutionField(key, nodes, scope);
      this.addExecutionFieldBranch(field, ordered);
    }

    return ordered;
  }

  private addExecutionFieldBranch(field: ExecutionField, ordered: ExecutionField[]): void {
    field.scope.fields.set(field.key, field);
    ordered.push(field);

    const returnType = unwrapType(field.type);
    if (isAbstractType(returnType) || isLeafType(returnType)) return;

    const nextScope = new ExecutionScope({
      executor: this.executor,
      parentType: returnType as GraphQLObjectType,
      parentField: field,
      selections: field.selections(),
      objects: [],
      results: [],
    });
    this.plannedScopesByField.set(field, nextScope);
    this.buildExecutionTree(nextScope, ordered);
  }

  private parentTypeIsPossible(
    fragmentType: GraphQLCompositeType,
    parentType: GraphQLCompositeType,
  ): boolean {
    if (fragmentType === parentType) return true;
    if (isAbstractType(fragmentType)) {
      return this.executor.schema
        .getPossibleTypes(fragmentType as GraphQLAbstractType)
        .some((t) => t === parentType);
    }
    return false;
  }

  private nodeSkipped(
    node: FieldNode | InlineFragmentNode | FragmentSpreadNode | SelectionNode,
  ): boolean {
    const directives = (node as { directives?: ReadonlyArray<DirectiveNode> }).directives;
    if (!directives || directives.length === 0) return false;
    for (const directive of directives) {
      if (directive.name.value === "skip") {
        if (this.ifArgumentValue(directive)) return true;
      } else if (directive.name.value === "include") {
        if (!this.ifArgumentValue(directive)) return true;
      }
      // unknown directives are ignored — this port has no custom directive resolvers
    }
    return false;
  }

  private ifArgumentValue(directive: DirectiveNode): boolean {
    const arg = directive.arguments?.[0];
    if (!arg) return false;
    return !!this.evaluateBooleanValue(arg.value);
  }

  private evaluateBooleanValue(value: ValueNode): boolean | null {
    if (value.kind === Kind.BOOLEAN) return value.value;
    if (value.kind === Kind.VARIABLE) {
      const v = this.executor.variables[value.name.value];
      return typeof v === "boolean" ? v : null;
    }
    return null;
  }

  private buildExecutionField(
    key: string,
    nodes: ReadonlyArray<FieldNode>,
    scope: ExecutionScope,
  ): ExecutionField {
    const firstNode = nodes[0] as FieldNode;
    const nodeName = firstNode.name.value;

    let definition: GraphQLField<unknown, unknown> | undefined;
    let resolver: FieldResolver | null = null;

    if (nodeName === "__typename") {
      definition = TypeNameMetaFieldDef as GraphQLField<unknown, unknown>;
      resolver = INTROSPECTION_TYPENAME_RESOLVER;
    } else if (
      nodeName === "__schema" &&
      scope.parentType === this.executor.schema.getQueryType()
    ) {
      definition = SchemaMetaFieldDef as GraphQLField<unknown, unknown>;
      resolver = INTROSPECTION_ENTRYPOINT_RESOLVERS["__schema"] ?? null;
    } else if (
      nodeName === "__type" &&
      scope.parentType === this.executor.schema.getQueryType()
    ) {
      definition = TypeMetaFieldDef as GraphQLField<unknown, unknown>;
      resolver = INTROSPECTION_ENTRYPOINT_RESOLVERS["__type"] ?? null;
    } else {
      definition = scope.parentType.getFields()[nodeName];
      if (!definition) {
        throw new DocumentError(
          `No field '${nodeName}' on type '${scope.parentType.name}'`,
        );
      }
      // Introspection types (__Schema, __Type, __Field, __InputValue, __EnumValue, __Directive)
      // get their dispatch before user resolvers, matching the Ruby pattern.
      resolver =
        (INTROSPECTION_TYPE_RESOLVERS[scope.parentType.name]?.[nodeName] as
          | FieldResolver
          | undefined) ?? null;
    }

    if (!resolver) {
      resolver =
        (this.resolvers[scope.parentType.name]?.[nodeName] as FieldResolver | undefined) ??
        null;
    }
    if (!resolver) resolver = this.executor.defaultFieldResolver;
    if (!resolver) {
      // last-resort: hash key resolver mirroring graphql-js's defaultFieldResolver
      resolver = new ObjectKeyResolver(nodeName);
    }

    let args: Record<string, unknown> = {};
    const argumentErrors: ExecutionError[] = [];
    try {
      args = getArgumentValues(definition, firstNode, this.executor.variables);
    } catch (e) {
      if (e instanceof GraphQLError) {
        argumentErrors.push(ExecutionError.from(e.message, { cause: e }));
      } else {
        throw e;
      }
    }

    return new ExecutionField(key, {
      nodes: Object.freeze([...nodes]) as ReadonlyArray<FieldNode>,
      scope,
      definition,
      resolver,
      args,
      argumentErrors,
    });
  }
}
