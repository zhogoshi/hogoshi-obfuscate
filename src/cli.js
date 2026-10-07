#!/usr/bin/env node
import { obfuscateBuild } from "./obfuscate.js";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("-"));
const profile = args.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length) ?? "balanced";
const minifyHtml = !args.includes("--no-minify-html");

if (!target || target.startsWith("-")) {
  console.error("Usage: obfuscate-hogoshi <next-build-dir> [--profile=fast|balanced|paranoid] [--no-minify-html]");
  process.exit(1);
}

const result = await obfuscateBuild(target, { profile, minifyHtml });
const delta = result.bytesBefore - result.bytesAfter;
console.log(
  `Obfuscated ${result.files} files (${profile}), ${result.classes} classes, ${result.variables} vars, ${result.slots} slots, ${result.scripts} scripts` +
    (result.skipped.length ? ` (skipped: ${result.skipped.length})` : "") +
    ` — ${(result.bytesBefore / 1024).toFixed(1)}KB → ${(result.bytesAfter / 1024).toFixed(1)}KB (${delta >= 0 ? "-" : "+"}${Math.abs(delta / 1024).toFixed(1)}KB)`,
);