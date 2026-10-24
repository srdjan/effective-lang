// The package stays behind host:providers. Only Files and FileReadError cross
// the Effektive boundary.
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { FileReadError, Files, type Path, type Text } from "./files.ts";

export const FilesLive: Layer.Layer<Files> = Layer.effect(
  Files,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      read: (path: Path): Effect.Effect<Text, FileReadError> => {
        const candidate: unknown = path;
        if (
          typeof candidate !== "string" || candidate.length === 0 ||
          candidate.includes("\0")
        ) {
          return Effect.fail(
            new FileReadError({
              path: String(candidate),
              message: "invalid path",
            }),
          );
        }
        return fs.readFileString(candidate, "utf8").pipe(
          Effect.mapError((error) =>
            new FileReadError({ path: candidate, message: String(error) })
          ),
        );
      },
    };
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
