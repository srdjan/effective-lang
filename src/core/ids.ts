// Helpers for the identity strings of declarations (`type:users#User`) and
// capabilities (`cap:users#Users.find`). Each helper returns undefined for a
// malformed identity, so the editor queries never throw. The emitter wraps these
// helpers and turns undefined into an internal failure.

import type { CapabilityId, ErrorId, LocalId, TypeId, ValueId } from "./ir.ts";

/** The prefixes of declaration identities. A provider has a value identity. */
export type DeclarationPrefix = "type" | "error" | "service" | "value";

/** The identity of a declaration, such as `type:users#User`. */
export function declarationId<P extends DeclarationPrefix>(
  prefix: P,
  module: string,
  name: string,
): `${P}:${string}` {
  return `${prefix}:${module}#${name}`;
}

/** True for an identity such as `type:users#User`. */
export function isTypeId(id: string): id is TypeId {
  return id.startsWith("type:");
}

/** True for an identity such as `error:users#NotFound`. */
export function isErrorId(id: string): id is ErrorId {
  return id.startsWith("error:");
}

/** True for an identity such as `value:users#find`. */
export function isValueId(id: string): id is ValueId {
  return id.startsWith("value:");
}

/** True for an identity such as `local:users#find/x`. */
export function isLocalId(id: string): id is LocalId {
  return id.startsWith("local:");
}

/** The module part of an identity such as `type:users#User`. */
export function moduleOfId(id: string): string | undefined {
  const colon = id.indexOf(":");
  const hash = id.indexOf("#");
  if (colon < 0 || hash < colon) return undefined;
  return id.slice(colon + 1, hash);
}

/** The declared name in an identity such as `type:users#User`. */
export function nameOfId(id: string): string | undefined {
  const hash = id.indexOf("#");
  if (hash < 0) return undefined;
  const rest = id.slice(hash + 1);
  const dot = rest.indexOf(".");
  return dot < 0 ? rest : rest.slice(0, dot);
}

/** The method name in a capability such as `cap:users#Users.find`. */
export function methodOfCapability(
  capability: CapabilityId,
): string | undefined {
  const dot = capability.indexOf(".", capability.indexOf("#"));
  if (dot < 0) return undefined;
  return capability.slice(dot + 1);
}
