#!/usr/bin/env node
import { optimizeBuild } from "./obfuscate.js";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("-"));
const flag = (name) => args.includes(`--${name}`);

if (!target) {
  console.error("Usage: obfuscate-hogoshi <next-build-dir> [--no-css] [--no-html] [--precompress]");
  process.exit(1);
}

const result = await optimizeBuild(target, {
  css: !flag("no-css"),
  html: !flag("no-html"),
  precompress: flag("precompress"),
});

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
for (const [label, s] of [["js", result.js], ["css", result.css], ["html", result.html]]) {
  if (s.files) console.log(`  ${label}: ${s.files} files, ${kb(s.before)} -> ${kb(s.after)}`);
}
if (result.js.obfuscated) console.log(`  obfuscated: ${result.js.obfuscated} chunks`);
if (result.js.skipped.length) console.log(`  skipped: ${result.js.skipped.length}`);
if (result.precompressed) {
  const p = result.precompressed;
  console.log(`  precompress: ${p.files} files, ${kb(p.before)} -> gzip ${kb(p.gzip)} / brotli ${kb(p.brotli)}`);
}