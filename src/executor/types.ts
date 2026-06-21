// A few resolver-related types shared across executor modules.

import type { FieldResolver } from "../field_resolvers.ts";
import type { GraphQLNamedType } from "graphql";

export type TypeResolverFn = (
  obj: unknown,
  context: unknown,
) => GraphQLNamedType | null | undefined;

export type ResolverEntry = FieldResolver | TypeResolverFn;

export type ResolverMap = Record<string, Record<string, ResolverEntry>>;
