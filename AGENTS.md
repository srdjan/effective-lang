# Repository Guidelines

## Project Structure & Module Organization

This repository is currently empty apart from this guide. There is no established source tree, test suite, or asset directory. When adding the first implementation, keep source code, tests, and supporting assets in clearly named directories, and document the resulting layout in the README. Keep examples close to the feature they demonstrate or in a dedicated `examples/` directory.

## Build, Test, and Development Commands

No build system, package manager, or runnable commands are configured yet. Add a README with the exact install, run, build, and test commands when introducing tooling. Prefer a small set of repeatable commands that work from the repository root; avoid instructions that depend on an unrecorded local setup.

## Coding Style & Naming Conventions

Follow the formatter and linter selected for the implementation language, and commit their configuration. Use consistent indentation within each file and descriptive names that reflect each module's purpose. Name files and directories using one convention per language or toolchain. Avoid adding a style rule that the configured tools cannot check unless it is necessary for readability.

## Testing Guidelines

No testing framework or coverage threshold has been established. Add focused tests alongside new behavior and include the test command in the README. Use names that describe the behavior under test, and cover normal inputs, boundary cases, and failure paths where applicable. Do not claim a coverage target until the project adopts one.

## Commit & Pull Request Guidelines

This directory has no Git repository or commit history, so no project-specific commit convention can be inferred. Use short, imperative commit subjects that explain the change. Pull requests should summarize the purpose, list the commands used to verify the change, and link related issues when available. Include screenshots for visible interface changes, and call out any setup or configuration changes reviewers need to reproduce.
