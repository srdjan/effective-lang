// The ports of the command-line tool. The core never touches the file system.
// The CLI reaches the file system, the subprocess runner, and the file watcher
// only through `CliIo`, so that tests run `main` with in-memory doubles.

import type { ReadError, Result } from "../core/mod.ts";

export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileFailure {
  readonly message: string;
}

export interface CliFs {
  readText(path: string): Result<string, ReadError>;
  /** Writes the file and creates its directories. */
  writeText(path: string, text: string): Result<void, FileFailure>;
  kind(path: string): "file" | "directory" | "missing";
  list(path: string): Result<readonly DirectoryEntry[], FileFailure>;
  /** The absolute form of a directory, with links resolved, as `deno check` prints it. */
  absolute(path: string): string;
}

/** One run of `deno check`. */
export interface DenoCheckRequest {
  /** The absolute project directory. The command runs there. */
  readonly cwd: string;
  /** The text of the configuration file. The runner writes it where it likes and removes it. */
  readonly config: string;
  /** Root-relative paths of the files to check. */
  readonly files: readonly string[];
}

export interface DenoCheckRun {
  readonly code: number;
  /** What `deno check` printed on stderr, without color codes. */
  readonly stderr: string;
}

export interface CliIo {
  /** Writes text as given. The caller adds the line ends. */
  stdout(text: string): void;
  stderr(text: string): void;
  readonly fs: CliFs;
  denoCheck(
    request: DenoCheckRequest,
  ): Promise<Result<DenoCheckRun, FileFailure>>;
  /**
   * Batches of root-relative paths that changed, already debounced. The
   * sequence ends when the watcher stops.
   */
  watch(root: string): AsyncIterable<readonly string[]>;
}
