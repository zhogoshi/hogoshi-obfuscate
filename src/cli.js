#!/usr/bin/env node
import { build } from "./build.js";

const USAGE = `Usage: obfuscate-hogoshi <build-dir> --mode=server-build|static-export (--out=<dir> | --in-place)
  [--maps-out=<dir>] [--report=<file>] [--seed=<text>] [--precompress]`;

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("-"));
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (!target) {
  console.error(USAGE);
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;

try {
  const report = await build(target, {
    mode: value("mode"),
    out: value("out"),
    inPlace: flag("in-place"),
    mapsOut: value("maps-out"),
    report: value("report"),
    precompress: flag("precompress"),
    seed: value("seed"),
  });
  for (const [kind, after] of Object.entries(report.after)) {
    const before = report.before[kind];
    console.log(`  ${kind}: ${after.files} files, raw ${kb(before.raw)} -> ${kb(after.raw)}, gzip ${kb(before.gzip)} -> ${kb(after.gzip)}, brotli ${kb(before.brotli)} -> ${kb(after.brotli)}`);
  }
  console.log(`  classes: ${report.renamedClasses} renamed`);
  console.log(`  hardened: ${report.hardened.length} files`);
  for (const { path, functions } of report.virtualized) console.log(`  virtualized ${functions} in ${path}`);
  for (const { path, reason } of report.skipped) console.log(`  skipped ${path}: ${reason}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(USAGE);
  process.exit(1);
}
