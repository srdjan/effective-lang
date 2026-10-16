# Repository Guidelines

## Project Structure & Module Organization

Source code is in `src/core/`. Tests and test helpers are in `tests/`. Test inputs are in `fixtures/`. Design and plans are in `docs/`. The README describes each directory and the fixture conventions.

## Build, Test, and Development Commands

The README lists the exact commands. Run `deno task check` from the repository root before each commit. It runs the format check, the lint, the type check, and all tests. Use Deno 2.9.7.

## Coding Style & Naming Conventions

Follow the formatter and linter selected for the implementation language, and commit their configuration. Use consistent indentation within each file and descriptive names that reflect each module's purpose. Name files and directories using one convention per language or toolchain. Avoid adding a style rule that the configured tools cannot check unless it is necessary for readability.

## Testing Guidelines

Tests use `Deno.test` and `@std/assert`. A fast test runs in under one second. A test that starts a subprocess goes in a file named `*_slow_test.ts`. Error fixtures follow the marker convention in the README. Do not claim a coverage target until the project adopts one.

## Commit & Pull Request Guidelines

This directory has no Git repository or commit history, so no project-specific commit convention can be inferred. Use short, imperative commit subjects that explain the change. Pull requests should summarize the purpose, list the commands used to verify the change, and link related issues when available. Include screenshots for visible interface changes, and call out any setup or configuration changes reviewers need to reproduce.
