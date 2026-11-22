# mend

[![make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in one
of four formats: unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and JSON text-editor tool calls. It finds each edit's
lines at the first of three matching tiers (exact, trailing-whitespace, then
indentation-insensitive), and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-`/absent to read from standard input.
`--format` picks `unified`, `search-replace`, `v4a`, `json`, or `auto`
(the default, which detects the format). `--check` reports what would
change without writing anything; `--strict` matches lines exactly.

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`. Exit 2 reports a usage, missing-patch, format,
or parse error. See `SPEC.md` in the competition kit for the full contract.

Node 22, standard library only. No network or model calls at run time.

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
