import {
  astFromValue,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  print,
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLObjectType,
} from "graphql";
import type { ExecutionField } from "./executor/execution_field.js";
import type { ResolverMap } from "./executor/types.js";
import { FieldResolver, MethodResolver } from "./field_resolvers.js";

/**
 * Introspection runtime for the breadth executor.
 *
 * Schema metadata is read directly from the live `GraphQLSchema` — graphql-js
 * already defines the `__Schema`/`__Type`/`__Field`/etc. object types and
 * exposes the `SchemaMetaFieldDef`/`TypeMetaFieldDef`/`TypeNameMetaFieldDef`
 * meta fields. We provide breadth-aware resolvers and dispatch tables that the
 * planner consults before falling through to user resolvers.
 */

class TypenameResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.resolveAll(execField.scope.parentType.name);
  }
}

class SchemaEndpointResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.resolveAll(execField.executor.schema);
  }
}

class TypeEndpointResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const name = execField.arguments["name"] as string;
    return execField.resolveAll(execField.executor.schema.getType(name) ?? null);
  }
}

type OperationKind = "query" | "mutation" | "subscription";

class SchemaRootTypeResolver extends FieldResolver {
  private operation: OperationKind;

  constructor(operation: OperationKind) {
    super();
    this.operation = operation;
  }

  override resolve(execField: ExecutionField): unknown[] {
    const schema = execField.executor.schema;
    let t: GraphQLObjectType | null | undefined;
    switch (this.operation) {
      case "query":
        t = schema.getQueryType();
        break;
      case "mutation":
        t = schema.getMutationType();
        break;
      case "subscription":
        t = schema.getSubscriptionType();
        break;
    }
    return execField.resolveAll(t ?? null);
  }
}

class SchemaTypesResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.resolveAll(Object.values(execField.executor.schema.getTypeMap()));
  }
}

class SchemaDirectivesResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.resolveAll(execField.executor.schema.getDirectives());
  }
}

class TypeKindResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((type) => {
      if (isScalarType(type)) return "SCALAR";
      if (isObjectType(type)) return "OBJECT";
      if (isInterfaceType(type)) return "INTERFACE";
      if (isUnionType(type)) return "UNION";
      if (isEnumType(type)) return "ENUM";
      if (isInputObjectType(type)) return "INPUT_OBJECT";
      if (isListType(type)) return "LIST";
      if (isNonNullType(type)) return "NON_NULL";
      return null;
    });
  }
}

class TypeFieldsResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const includeDeprecated = !!execField.arguments["includeDeprecated"];
    return execField.mapObjects((type) => {
      if (!isObjectType(type) && !isInterfaceType(type)) return null;
      const fields = Object.values(type.getFields());
      return includeDeprecated ? fields : fields.filter((f) => !f.deprecationReason);
    });
  }
}

class TypeInterfacesResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((type) => {
      if (!isObjectType(type) && !isInterfaceType(type)) return null;
      return type.getInterfaces();
    });
  }
}

class TypePossibleTypesResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const schema = execField.executor.schema;
    return execField.mapObjects((type) => {
      if (!isAbstractType(type)) return null;
      return schema.getPossibleTypes(type);
    });
  }
}

class TypeEnumValuesResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const includeDeprecated = !!execField.arguments["includeDeprecated"];
    return execField.mapObjects((type) => {
      if (!isEnumType(type)) return null;
      const values = type.getValues();
      return includeDeprecated ? values : values.filter((v) => !v.deprecationReason);
    });
  }
}

class TypeInputFieldsResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const includeDeprecated = !!execField.arguments["includeDeprecated"];
    return execField.mapObjects((type) => {
      if (!isInputObjectType(type)) return null;
      const fields = Object.values(type.getFields());
      return includeDeprecated ? fields : fields.filter((f) => !f.deprecationReason);
    });
  }
}

class TypeOfTypeResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((type) => {
      if (isListType(type) || isNonNullType(type)) return type.ofType;
      return null;
    });
  }
}

class TypeSpecifiedByUrlResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((type) => {
      if (!isScalarType(type)) return null;
      return type.specifiedByURL ?? null;
    });
  }
}

class TypeIsOneOfResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((type) => {
      if (!isInputObjectType(type)) return null;
      return (type as { isOneOf?: boolean }).isOneOf ?? null;
    });
  }
}

class ArgumentsResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    const includeDeprecated = !!execField.arguments["includeDeprecated"];
    return execField.mapObjects((owner) => {
      const args = (owner as { args?: ReadonlyArray<GraphQLArgument> }).args ?? [];
      return includeDeprecated ? args : args.filter((a) => !a.deprecationReason);
    });
  }
}

class InputValueDefaultValueResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((input) => {
      const i = input as GraphQLArgument | GraphQLInputField;
      if (i.defaultValue === undefined) return null;
      const ast = astFromValue(i.defaultValue, i.type);
      return ast ? print(ast) : null;
    });
  }
}

class IsDeprecatedResolver extends FieldResolver {
  override resolve(execField: ExecutionField): unknown[] {
    return execField.mapObjects((obj) => {
      const reason = (obj as { deprecationReason?: string | null }).deprecationReason;
      return !!reason;
    });
  }
}

export const TYPENAME_RESOLVER: FieldResolver = new TypenameResolver();

export const ENTRYPOINT_RESOLVERS: Record<string, FieldResolver> = Object.freeze({
  __schema: new SchemaEndpointResolver(),
  __type: new TypeEndpointResolver(),
});

export const TYPE_RESOLVERS: ResolverMap = Object.freeze({
  __Schema: {
    description: new MethodResolver("description"),
    directives: new SchemaDirectivesResolver(),
    mutationType: new SchemaRootTypeResolver("mutation"),
    queryType: new SchemaRootTypeResolver("query"),
    subscriptionType: new SchemaRootTypeResolver("subscription"),
    types: new SchemaTypesResolver(),
  },
  __Type: {
    description: new MethodResolver("description"),
    enumValues: new TypeEnumValuesResolver(),
    fields: new TypeFieldsResolver(),
    inputFields: new TypeInputFieldsResolver(),
    interfaces: new TypeInterfacesResolver(),
    isOneOf: new TypeIsOneOfResolver(),
    kind: new TypeKindResolver(),
    name: new MethodResolver("name"),
    ofType: new TypeOfTypeResolver(),
    possibleTypes: new TypePossibleTypesResolver(),
    specifiedByURL: new TypeSpecifiedByUrlResolver(),
  },
  __Field: {
    args: new ArgumentsResolver(),
    deprecationReason: new MethodResolver("deprecationReason"),
    description: new MethodResolver("description"),
    isDeprecated: new IsDeprecatedResolver(),
    name: new MethodResolver("name"),
    type: new MethodResolver("type"),
  },
  __InputValue: {
    defaultValue: new InputValueDefaultValueResolver(),
    deprecationReason: new MethodResolver("deprecationReason"),
    description: new MethodResolver("description"),
    isDeprecated: new IsDeprecatedResolver(),
    name: new MethodResolver("name"),
    type: new MethodResolver("type"),
  },
  __EnumValue: {
    deprecationReason: new MethodResolver("deprecationReason"),
    description: new MethodResolver("description"),
    isDeprecated: new IsDeprecatedResolver(),
    name: new MethodResolver("name"),
  },
  __Directive: {
    args: new ArgumentsResolver(),
    description: new MethodResolver("description"),
    isRepeatable: new MethodResolver("isRepeatable"),
    locations: new MethodResolver("locations"),
    name: new MethodResolver("name"),
  },
});
