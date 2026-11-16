# obfuscate-hogoshi

Post-processes a finished Next build with one fixed template. https://github.com/zhogoshi/hogoshi-obfuscate

```bash
pnpm add -D obfuscate-hogoshi
pnpm build
obfuscate-hogoshi .next --mode=server-build --in-place
```

`--mode` is `server-build` (expects `BUILD_ID`, `static`, `server`) or `static-export` (expects `_next/static`). It is never guessed. HTML that a server creates later is not touched.

Pass `--out=<dir>` to publish elsewhere or `--in-place` to replace the source. Work happens in `<dir>.staging` and the source stays unchanged until the release gate passes. Other flags: `--maps-out=<dir>` keeps a private copy of the source maps, `--report=<file>` writes the inventory, the totals, and every skipped file with its reason, `--seed=<text>` fixes the release seed, `--precompress` writes `.gz` and `.br` last.

## The template

- Client JS: minified, then hardened with control-flow flattening (threshold 0.35), a string array with base64, rotation, shuffle, index shift, and call transforms, and shuffled short names. Identifier-like strings stay out of the table. No dead code, number noise, Unicode escapes, self-defending, or debugger traps. Property names are never renamed. A chunk over 1.5 MB or one whose output does not parse is kept minified and listed in the report.
- Bundler runtime files and chunk names are untouched.
- Classes: every class found in the build CSS gets a short name in CSS, HTML, client and server JS, and flight data. Bare words such as `flex` keep an `:is(.flex,.x)` alias in CSS. `recharts-`, `sonner`, `dark`, and `light` are kept. The kit `cn` reads a `__hogoshi_class_map__` string that the CLI fills, so `tailwind-merge` sees real names.
- CSS and HTML: conservative minification. HTML comments stay.
- All `.map` files and `sourceMappingURL` comments are removed.
- The seed comes from the CSS unless given. A per-file seed derives from it, so one source gives one output.

## Release gate

Changed JS must parse again, CSS braces must balance, local `/_next/` and CSS `url()` references must resolve, no map or `sourceMappingURL` may remain, and no renamed class may remain in CSS. A failed gate publishes nothing. Browser checks stay manual.

Virtualization is not implemented.

## Virtualization of marked functions

Wrap a function in `protect("hogoshi:vm", fn)` from `@hogoshi/ui` to compile it into bytecode run by a per-file interpreter with shuffled opcodes. The marker survives `next build` and is removed by the CLI.

- Supported: variables, loops, branches, `try`/`catch`, closures, optional chaining, logical and arithmetic operators, objects, arrays, templates, member calls, `new`, `typeof`, `delete`, regex literals.
- Not supported (the function stays plain and is listed in the report): `async`, generators, classes, destructuring, spread, `for...of`/`for...in`, `switch`, labels, `super`, `finally`, function declarations, `arguments`, writes to outer variables, and loop-scoped `let` captured by closures.
- Mark small, sensitive functions only; virtualized code is much slower than native.
