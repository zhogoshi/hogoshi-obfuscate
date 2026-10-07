#!/usr/bin/env node
import { obfuscateBuild } from "./obfuscate.js";

const target = process.argv[2];
if (!target || target.startsWith("-")) {
  console.error("Usage: obfuscate-hogoshi <next-build-dir>");
  process.exit(1);
}

const result = await obfuscateBuild(target);
console.log(
  `Obfuscated ${result.files} files, ${result.classes} classes, ${result.variables} variables, ${result.slots} slots, ${result.scripts} scripts`,
);
