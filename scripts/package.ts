// Local release artifacts. ZIP entries use a fixed DOS date and sorted names,
// so identical source and locked dependencies produce identical VSIX bytes.
import { dirname, fromFileUrl, join, resolve } from "@std/path";

export const REQUIRED_DENO_VERSION = "2.9.8";
const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const encoder = new TextEncoder();

async function command(
  name: string,
  args: string[],
  cwd = ROOT,
): Promise<void> {
  const result = await new Deno.Command(name, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  if (!result.success) {
    throw new Error(
      `${name} ${args.join(" ")} failed:\n${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Uncompressed ZIP: no platform archiver, timestamp, or compression-version dependency. */
function archive(entries: readonly Entry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); // 1980-01-01, 00:00:00
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, entry.bytes);
    const directory = new Uint8Array(46 + name.length);
    const index = new DataView(directory.buffer);
    index.setUint32(0, 0x02014b50, true);
    index.setUint16(4, 20, true);
    index.setUint16(6, 20, true);
    directory.set(header.subarray(6, 28), 8);
    index.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    offset += header.length + entry.bytes.length;
    centralSize += directory.length;
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const bytes of [...local, ...central, end]) {
    output.set(bytes, position);
    position += bytes.length;
  }
  return output;
}

function collect(directory: string, prefix: string): Entry[] {
  const entries: Entry[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const path = join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory) entries.push(...collect(path, name));
    else if (entry.isFile) {
      entries.push({ name, bytes: Deno.readFileSync(path) });
    } else throw new Error(`Unexpected packaging input: ${path}`);
  }
  return entries;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(
    "<",
    "&lt;",
  );
}

/** Build the standalone CLI and complete extension, without publishing either. */
export async function packageRelease(
  outputDirectory: string,
): Promise<string[]> {
  if (Deno.version.deno !== REQUIRED_DENO_VERSION) {
    throw new Error(
      `Packaging requires Deno ${REQUIRED_DENO_VERSION}; found ${Deno.version.deno}.`,
    );
  }
  const out = resolve(outputDirectory);
  const extension = join(ROOT, "editors", "vscode");
  await command(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    extension,
  );
  Deno.mkdirSync(out, { recursive: true });
  const cli = join(out, "effective.js");
  const server = join(out, "effective-lsp.js");
  for (
    const [entry, target] of [["src/cli/main.ts", cli], [
      "src/lsp/main.ts",
      server,
    ]]
  ) {
    await command("deno", [
      "bundle",
      "--frozen-lockfile",
      "--platform",
      "deno",
      "--format",
      "esm",
      "--packages",
      "bundle",
      "-o",
      target,
      entry,
    ]);
    const bundled = Deno.readTextFileSync(target);
    const guard =
      `if (Deno.version.deno !== "${REQUIRED_DENO_VERSION}") {\n  console.error("Effective requires Deno ${REQUIRED_DENO_VERSION}; found " + Deno.version.deno + ".");\n  Deno.exit(2);\n}\n`;
    Deno.writeTextFileSync(target, guard + bundled);
  }
  const pkg = JSON.parse(
    Deno.readTextFileSync(join(extension, "package.json")),
  );
  const entries: Entry[] = [];
  for (
    const name of [
      "package.json",
      "extension.js",
      "language-configuration.json",
      "README.md",
    ]
  ) {
    entries.push({
      name: `extension/${name}`,
      bytes: Deno.readFileSync(join(extension, name)),
    });
  }
  entries.push(...collect(join(extension, "syntaxes"), "extension/syntaxes"));
  entries.push(
    ...collect(join(extension, "node_modules"), "extension/node_modules"),
  );
  entries.push({
    name: "extension/LICENSE",
    bytes: Deno.readFileSync(join(ROOT, "LICENSE")),
  });
  entries.push({
    name: "extension/server/effective-lsp.js",
    bytes: Deno.readFileSync(server),
  });
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id="${xml(pkg.name)}" Version="${
    xml(pkg.version)
  }" Publisher="${xml(pkg.publisher)}"/><DisplayName>${
    xml(pkg.displayName)
  }</DisplayName><Description xml:space="preserve">${
    xml(pkg.description)
  }</Description><Tags>effective,language</Tags><Categories>Programming Languages</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${
    xml(pkg.engines.vscode)
  }"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets>
</PackageManifest>
`;
  entries.push({
    name: "extension.vsixmanifest",
    bytes: encoder.encode(manifest),
  });
  entries.push({
    name: "[Content_Types].xml",
    bytes: encoder.encode(
      '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="txt" ContentType="text/plain"/></Types>',
    ),
  });
  const vsix = join(out, `effective-vscode-${pkg.version}.vsix`);
  Deno.writeFileSync(vsix, archive(entries));
  return [cli, server, vsix];
}

if (import.meta.main) {
  try {
    for (
      const path of await packageRelease(Deno.args[0] ?? join(ROOT, "dist"))
    ) console.log(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
