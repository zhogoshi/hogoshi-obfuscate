# obfuscate-hogoshi

Post-build obfuscator for a Next.js app.

Repository: https://github.com/zhogoshi/hogoshi-obfuscate

Package: [`obfuscate-hogoshi`](https://www.npmjs.com/package/obfuscate-hogoshi)

## What

After `next build`, it rewrites the `.next` output:

- client chunks are minified, then obfuscated
- CSS and HTML are minified
- optional gzip and brotli copies of static files

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

```bash
obfuscate-hogoshi .next --precompress
obfuscate-hogoshi .next --no-css --no-html
```

From a checkout of this repository, before the package is on npm:

```bash
node src/cli.js /path/to/app/.next
```

Run it only on a production build you are about to ship. Do not commit the rewritten `.next` folder.

Landing, template, storybook, and eneru/web run `pnpm exec obfuscate-hogoshi .next` in their Docker image after `next build`. Local `pnpm dev` does not. A new app from `create-hogoshi` inherits the template image, so that image does.
