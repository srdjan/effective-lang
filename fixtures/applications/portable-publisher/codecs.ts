import { Effect, Layer, Option, Schema } from "effect";
import { Payload } from "./platform.ts";
import {
  type ArticleCodec,
  ArticleJson,
  storedArticleSchema,
} from "./storage.ts";

const serializer: ArticleCodec = {
  encode: (article) => Effect.succeed(Payload.make(JSON.stringify(article))),
  decode: (payload) =>
    Effect.sync(() => {
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        return Option.none();
      }
      return Schema.decodeUnknownOption(storedArticleSchema)(value);
    }),
};

export const ArticleJsonLive: Layer.Layer<ArticleJson> = Layer.succeed(
  ArticleJson,
)({ acquire: () => Effect.succeed(serializer) });
