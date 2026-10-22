// Helpers for the identity strings of declarations (`type:users#User`) and
// capabilities (`cap:users#Users.find`). Each helper returns undefined for a
// malformed identity, so the editor queries never throw. The emitter wraps these
// helpers and turns undefined into an internal failure.

import type {
  CapabilityId,
  ErrorId,
  LocalId,
  ServiceId,
  TypeId,
  ValueId,
} from "./ir.ts";

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

/** The identity of a closed builtin instance: `value:<module>#$builtin/<name>/<hash>`. */
export function builtinInstanceId(
  module: string,
  name: string,
  hash: string,
): ValueId {
  return `value:${module}#$builtin/${name}/${hash}`;
}

/** The builtin name of an instance identity, or undefined for any other identity. */
export function builtinInstanceName(id: string): string | undefined {
  if (!isValueId(id)) return undefined;
  const rest = id.slice(id.indexOf("#") + 1);
  if (!rest.startsWith("$builtin/")) return undefined;
  return rest.split("/")[1];
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

/** `cap:m#S.method` to `service:m#S`. */
export function serviceOfCapability(
  capability: CapabilityId,
): ServiceId | undefined {
  const hash = capability.indexOf("#");
  if (hash < 0) return undefined;
  const dot = capability.indexOf(".", hash);
  if (dot < 0) return undefined;
  return `service:${capability.slice(4, dot)}`;
}

/** The name after the `#` of an identity, for messages. */
export function shortName(id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? id : id.slice(hash + 1);
}
