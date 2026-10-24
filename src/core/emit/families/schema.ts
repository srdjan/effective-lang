// Emission of the Schema builtins: Schema operations, make, decode, and encode.

import type { Type } from "../../ir.ts";
import { type Doc, member } from "../doc.ts";
import {
  at,
  callArguments,
  type Emitted,
  emitted,
  free,
  type Kid,
  PREC,
} from "../emitted.ts";
import { internal, resolvedAs } from "../scope.ts";
import type { ExprOf } from "../shape.ts";
import { hasSchemaMetadata, schemaDoc, typeDoc } from "../types.ts";
import type { ExprCore } from "./context.ts";

export type SchemaStructuralKind = "schema";

export type SchemaLeafKind = "schema-make" | "schema-decode" | "schema-encode";

/** Emit a Schema operation. The switch is exhaustive: a new operation needs a case. */
export function schemaStructural(
  c: ExprCore,
  e: ExprOf<SchemaStructuralKind>,
  kid: Kid,
): Emitted {
  const schema = c.scope.effect("Schema");
  const args = e.arguments;
  const resultType = c.scope.resolve(e.type);
  const withSchemaView = (value: Emitted): Emitted =>
    resultType.kind === "schema" && hasSchemaMetadata(resultType)
      ? emitted([
        `${schema}.make<`,
        typeDoc(c.scope, resultType),
        ">(",
        at(value, PREC.member),
        ".ast)",
      ])
      : value;
  switch (e.op) {
    case "constructor-default": {
      const sourceType = resolvedAs(
        c.scope,
        args[0].type,
        "schema",
        "constructor default needs a Schema",
      );
      const effect = c.scope.effect("Effect");
      const callback = c.pure(args[1]);
      const effectful = isEffectfulCallback(args[1].type);
      return withSchemaView(emitted([
        `${schema}.make<(`,
        typeDoc(c.scope, sourceType),
        ' & { readonly "~type.make.in": ',
        typeDoc(c.scope, sourceType.makeInput ?? sourceType.decoded),
        ` } & ${schema}.WithoutConstructorDefault)>(`,
        at(kid(args[0]), PREC.member),
        ".ast).pipe(",
        `${schema}.withConstructorDefault(${effect}.${
          effectful ? "suspend" : "sync"
        }(() => `,
        at(callback, PREC.member),
        "())))",
      ]));
    }
    case "identity": {
      const type = resolvedAs(
        c.scope,
        e.type,
        "schema",
        "schema identity has wrong type",
      );
      return emitted([
        `${schema}.toType(`,
        schemaDoc(c.scope, type.decoded),
        ")",
      ]);
    }
    case "array":
    case "struct": {
      return withSchemaView(emitted([
        `${schema}.${e.op === "array" ? "Array" : "Struct"}`,
        callArguments([kid(args[0])]),
      ]));
    }
    case "null-to-missing-key": {
      const getter = c.scope.effect("SchemaGetter");
      const option = c.scope.effect("Option");
      const source = c.scope.temp();
      const value = c.scope.temp();
      return withSchemaView(emitted([
        "((",
        source,
        ": ",
        typeDoc(c.scope, args[0].type),
        ") => ",
        `${schema}.optionalKey(${schema}.NullOr(${source})).pipe(`,
        `${schema}.decodeTo(${schema}.optionalKey(${schema}.toType(${source})), { `,
        `decode: ${getter}.transformOptional(${option}.filter((${value}) => ${value} !== null)), `,
        `encode: ${getter}.transformOptional((${value}) => ${value})`,
        " })))(",
        free(kid(args[0])),
        ")",
      ]));
    }
    case "optional-key": {
      return withSchemaView(emitted([
        `${schema}.optionalKey`,
        callArguments([kid(args[0])]),
      ]));
    }
    case "option-from-optional-key": {
      return withSchemaView(emitted([
        `${schema}.OptionFromOptionalKey`,
        callArguments([kid(args[0])]),
      ]));
    }
    case "default-key":
    case "default-null-key":
    case "default-encoded-key": {
      const effect = c.scope.effect("Effect");
      const fallback = c.pure(args[1]);
      const callback = args[1].type;
      const effectful = isEffectfulCallback(callback);
      const issueFailure = callback.kind === "function" &&
        callback.effects.failures.includes("error:effect/SchemaIssue");
      const deferred: Doc = [
        `${effect}.${effectful ? "suspend" : "sync"}(() => `,
        at(fallback, PREC.member),
        "())",
      ];
      const issue = c.scope.temp();
      const defaultValue: Doc = issueFailure
        ? [
          `${effect}.mapError(`,
          deferred,
          ", (",
          issue,
          ") => new ",
          `${schema}.SchemaError(`,
          issue,
          "))",
        ]
        : deferred;
      if (e.op === "default-null-key") {
        const getter = c.scope.effect("SchemaGetter");
        const option = c.scope.effect("Option");
        const source = c.scope.temp();
        const value = c.scope.temp();
        const issueDefault: Doc = callback.kind === "function" &&
            callback.effects.failures.includes("error:effect/SchemaError")
          ? [
            `${effect}.mapError(`,
            deferred,
            `, (${issue}) => ${issue}.issue)`,
          ]
          : deferred;
        const options = args[2];
        const omit = options?.kind === "record" &&
          options.fields[0].value.kind === "literal" &&
          options.fields[0].value.value === "omit";
        return withSchemaView(emitted([
          "((",
          source,
          ": ",
          typeDoc(c.scope, args[0].type),
          ") => ",
          `${schema}.optionalKey(${schema}.NullOr(${source})).pipe(`,
          `${schema}.decodeTo(${schema}.toType(${source}), { `,
          `decode: ${getter}.transformOptionalEffect((${value}) => { `,
          `const ${issue} = ${option}.filter(${value}, (${value}) => ${value} !== null); `,
          `return ${option}.isSome(${issue}) ? ${effect}.succeed(${issue}) : ${effect}.map(`,
          issueDefault,
          `, ${option}.some); }), `,
          `encode: ${getter}.${omit ? "omit" : "passthrough"}() })))`,
          "(",
          free(kid(args[0])),
          ")",
        ]));
      }
      return withSchemaView(emitted([
        at(kid(args[0]), PREC.member),
        ".pipe(",
        `${schema}.${
          e.op === "default-encoded-key"
            ? "withDecodingDefaultKey"
            : "withDecodingDefaultTypeKey"
        }(`,
        defaultValue,
        ...(args[2] === undefined ? [] : [", ", free(kid(args[2]))]),
        "))",
      ]));
    }
    case "optional-transform": {
      const getter = c.scope.effect("SchemaGetter");
      const decode = c.pure(args[2]);
      const encode = c.pure(args[3]);
      const getterName = (index: number) =>
        isEffectfulCallback(args[index].type)
          ? "transformOptionalEffect"
          : "transformOptional";
      return withSchemaView(emitted([
        at(kid(args[0]), PREC.member),
        ".pipe(",
        `${schema}.decodeTo(`,
        free(kid(args[1])),
        ", { decode: ",
        `${getter}.${getterName(2)}(`,
        free(decode),
        "), encode: ",
        `${getter}.${getterName(3)}(`,
        free(encode),
        ") }))",
      ]));
    }
    case "optional-from-required": {
      const getter = c.scope.effect("SchemaGetter");
      const effect = c.scope.effect("Effect");
      const option = c.scope.effect("Option");
      const issue = c.scope.effect("SchemaIssue");
      const decode = c.pure(args[2]);
      const encode = c.pure(args[3]);
      const decodeEffectful = isEffectfulCallback(args[2].type);
      const encodeEffectful = isEffectfulCallback(args[3].type);
      const decodeValue = c.scope.temp();
      const encodeValue = c.scope.temp();
      const encodeResult: Doc = encodeEffectful
        ? [
          `${effect}.map(${effect}.suspend(() => `,
          at(encode, PREC.member),
          "(",
          encodeValue,
          `)), ${option}.some)`,
        ]
        : [
          `${option}.some(`,
          at(encode, PREC.member),
          "(",
          encodeValue,
          "))",
        ];
      return withSchemaView(emitted([
        at(kid(args[0]), PREC.member),
        ".pipe(",
        `${schema}.decodeTo(`,
        free(kid(args[1])),
        ", { decode: ",
        `${getter}.transformOptionalEffect((${decodeValue}) => `,
        `${option}.isSome(${decodeValue}) ? `,
        `${effect}.${decodeEffectful ? "suspend" : "sync"}(() => `,
        at(decode, PREC.member),
        "(",
        decodeValue,
        `.value)) : ${effect}.fail(new ${issue}.InvalidValue({ message: `,
        '"required encoded key is missing"',
        " })))",
        ", encode: ",
        `${getter}.${
          encodeEffectful ? "transformOptionalEffect" : "transformOptional"
        }((${encodeValue}) => `,
        encodeResult,
        ") }))",
      ]));
    }
    case "union": {
      return withSchemaView(
        emitted([`${schema}.Union`, callArguments([kid(args[0])])]),
      );
    }
    case "invalid": {
      const issue = c.scope.effect("SchemaIssue");
      return emitted([
        `new ${issue}.InvalidValue({ message: `,
        free(kid(args[0])),
        " })",
      ]);
    }
    case "at": {
      const issue = c.scope.effect("SchemaIssue");
      return emitted([
        `new ${issue}.Pointer([`,
        free(kid(args[0])),
        "], ",
        free(kid(args[1])),
        ")",
      ]);
    }
    case "both": {
      const issue = c.scope.effect("SchemaIssue");
      return emitted([
        `new ${issue}.Composite(`,
        at(kid(args[0]), PREC.member),
        ".ast, [",
        free(kid(args[1])),
        ", ",
        free(kid(args[2])),
        "])",
      ]);
    }
    case "recursive": {
      const body = c.scope.temp();
      const self = c.scope.temp();
      const callback = c.pure(args[0]);
      const type = typeDoc(c.scope, e.type);
      return emitted([
        "(() => { let ",
        body,
        ": ",
        type,
        "; const ",
        self,
        ": ",
        type,
        ` = ${schema}.suspend(() => `,
        body,
        "); ",
        body,
        " = ",
        at(callback, PREC.member),
        "(",
        self,
        "); return ",
        self,
        "; })()",
      ]);
    }
    case "transform": {
      const source = kid(args[0]);
      const target = kid(args[1]);
      const decode = c.pure(args[2]);
      const encode = c.pure(args[3]);
      const transformation = c.scope.effect("SchemaTransformation");
      const issue = c.scope.effect("SchemaIssue");
      const effect = c.scope.effect("Effect");
      const option = c.scope.effect("Option");
      const value = c.scope.temp();
      const result = c.scope.temp();
      const conversion = (
        callback: Emitted,
        issueMode: boolean,
        effectful: boolean,
      ): Doc =>
        issueMode
          ? [
            "(",
            value,
            ") => ",
            at(callback, PREC.member),
            "(",
            value,
            ")",
          ]
          : [
            "(",
            value,
            ") => ",
            `${effect}.flatMap(`,
            ...(effectful ? [] : [`${effect}.succeed(`]),
            at(callback, PREC.member),
            "(",
            value,
            effectful ? "), (" : ")), (",
            result,
            ") => ",
            `${option}.isSome(`,
            result,
            ") ? ",
            `${effect}.succeed(`,
            result,
            ".value) : ",
            `${effect}.fail(new ${issue}.InvalidValue({ message: \"schema transformation rejected\" }, `,
            value,
            ")))",
          ];
      const issueMode = (index: number) =>
        args[index].type.kind === "function" &&
        args[index].type.effects.failures.includes(
          "error:effect/SchemaIssue",
        );
      const effectful = (index: number) =>
        isEffectfulCallback(args[index].type);
      return withSchemaView(emitted([
        at(source, PREC.member),
        ".pipe(",
        `${schema}.decodeTo(`,
        free(target),
        ", ",
        `${transformation}.transformEffect({ decode: `,
        conversion(decode, issueMode(2), effectful(2)),
        ", encode: ",
        conversion(encode, issueMode(3), effectful(3)),
        " })))",
      ]));
    }
    default: {
      const missing: never = e.op;
      throw internal(`unhandled Schema operation ${missing}`);
    }
  }
}

export function schemaLeaf(
  c: ExprCore,
  e: ExprOf<SchemaLeafKind>,
  children: readonly Emitted[],
): Emitted {
  switch (e.kind) {
    case "schema-make":
    case "schema-decode":
    case "schema-encode": {
      if (e.kind === "schema-make") {
        return emitted(member(
          at(children[0], PREC.member),
          "makeEffect",
          callArguments([
            c.adaptedInput(children[1], e.input.type, "make"),
          ]),
        ));
      }
      const schema = c.scope.effect("Schema");
      const schemaType = c.scope.resolve(e.schema.type);
      const inputType = schemaType.kind === "schema"
        ? (e.kind === "schema-decode" ? schemaType.encoded : schemaType.decoded)
        : e.input.type;
      const input = c.adaptedInput(
        children[1],
        inputType,
        e.kind === "schema-decode" ? "encoded" : "decoded",
        e.kind === "schema-decode",
      );
      return emitted([
        `${schema}.${
          e.kind === "schema-decode" ? "decodeUnknownEffect" : "encodeEffect"
        }(`,
        free(children[0]),
        ")(",
        free(input),
        ")",
      ]);
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

/**
 * True for a function type that runs as an effect. Unlike `isEffectfulFunction`,
 * it does not resolve aliases.
 */
function isEffectfulCallback(type: Type): boolean {
  return type.kind === "function" && type.execution === "effect";
}
