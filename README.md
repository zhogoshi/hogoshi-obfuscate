# obfuscate-hogoshi

Rewrites a Next `.next` build. https://github.com/zhogoshi/hogoshi-obfuscate

Client chunks are minified, then obfuscated. CSS and HTML are minified. [`obfuscate-hogoshi`](https://www.npmjs.com/package/obfuscate-hogoshi) on npm.

```bash
pnpm add -D obfuscate-hogoshi
pnpm build
obfuscate-hogoshi .next
```

`--precompress` writes gzip and brotli. `--no-css --no-html` skips those. From this checkout: `node src/cli.js /path/to/app/.next`.
