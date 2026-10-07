# obfuscate-hogoshi

Post-build obfuscator for a Next.js app.

Repository: https://github.com/zhogoshi/hogoshi-obfuscate

Package: [`obfuscate-hogoshi`](https://www.npmjs.com/package/obfuscate-hogoshi)

## What

After `next build`, it rewrites the `.next` output:

- class names such as `text-fg` and `md:grid`
- CSS variables such as `--fg`
- `data-slot` values
- client chunk source, with `javascript-obfuscator`

The Turbopack and webpack runtime files are left alone so the app can still start.

## Why

Next does not take the Vite plugins used by a React SPA. This runs on the finished build, so CSS, HTML, and JS stay in agreement.

## Install

```bash
pnpm add -D obfuscate-hogoshi
```

## Use

```bash
pnpm build
obfuscate-hogoshi .next
```

The default profile is `balanced`. `fast` keeps the build smaller. `paranoid` adds heavier transforms on chunks that stay valid.

```bash
obfuscate-hogoshi .next --profile=fast
obfuscate-hogoshi .next --profile=paranoid
```

From a checkout of this repository, before the package is on npm:

```bash
node src/cli.js /path/to/app/.next
```

Run it only on a production build you are about to ship. Do not commit the rewritten `.next` folder.
