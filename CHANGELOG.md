# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three things are versioned independently: the application (`package.json`), the `.devbackup` container format (`formatVersion` in the manifest), and each provider's payload schema (`providers.<id>` in the manifest).

## [Unreleased]

### Added

- Repository scaffold: pnpm workspace, TypeScript strict configuration, ESLint/Prettier, Vitest projects.
- Discovery research notes for Claude Code local storage and Electron security.
