# Change Log

## [0.1.0]

- Masks are applied to every visible editor, not only the active one, so two documents side by side are both masked (#10)
- New command `Symbol Masks: Import prettify-symbols-mode substitutions` converts `prettifySymbolsMode.substitutions` into `symbolMasks.masks`, after asking whether to append, replace, or just preview (#2)
- New `multiline` pattern flag so `^` and `$` match at line boundaries
- Fixed: with several patterns for one language, each pattern used to erase the decorations of the ones before it
- Fixed: decoration types are disposed instead of leaked when masks change or an editor is hidden
- `npm test` runs the converter's unit tests in plain node

## [0.0.4]

- Fix iterative symbol rendering when multiple documents are opened

## [0.0.1]

- Initial release
