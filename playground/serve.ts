// Builds the playground, then serves the output on 127.0.0.1:8790 (plan
// section 8). Run it with `deno task playground:serve`.

import { serveDir } from "@std/http/file-server";
import { join } from "@std/path";
import { build, describeBuildError, REPOSITORY_ROOT } from "./build.ts";

const OUT_DIR = join(REPOSITORY_ROOT, "playground", "dist");
const HOSTNAME = "127.0.0.1";
const PORT = 8790;

if (import.meta.main) {
  const result = await build(OUT_DIR);
  if (!result.ok) {
    console.error(describeBuildError(result.error));
    Deno.exit(1);
  }
  const { appBytes, appGzipBytes } = result.value;
  console.log(`app.js: ${appBytes} bytes, ${appGzipBytes} bytes after gzip`);
  console.log(`http://${HOSTNAME}:${PORT}/`);
  Deno.serve(
    { hostname: HOSTNAME, port: PORT, onListen: () => {} },
    (request) => serveDir(request, { fsRoot: OUT_DIR, quiet: true }),
  );
}
