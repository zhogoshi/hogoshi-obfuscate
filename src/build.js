import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { renameAssets } from "./assets.js";
import { collectClasses, createNames, createRewriter, DEFAULT_KEEP, parseCode } from "./classes.js";
import { verify } from "./gate.js";
import { inventory, measure, classify, walk } from "./inventory.js";
import { compact, harden, isModule, stripSourceMapComments, unescapeSpaces } from "./js.js";
import { minifyCss, minifyHtml } from "./minify.js";
import { MARKER, virtualize } from "./vm/virtualize.js";

export const MODES = ["server-build", "static-export"];

const LAYOUT = {
  "server-build": ["BUILD_ID", "static", "server"],
  "static-export": ["_next/static"],
};

function assertLayout(root, mode) {
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  const missing = LAYOUT[mode].filter((entry) => !existsSync(join(root, entry)));
  if (missing.length) throw new Error(`${root} is not a ${mode} layout, missing: ${missing.join(", ")}`);
}

const MAX_HARDEN_BYTES = 1_500_000;

const readSheets = (root) => walk(root).filter((rel) => classify(rel) === "css").map((rel) => readFileSync(join(root, rel), "utf8"));

function createClassRewriter(root, seed) {
  const sheets = readSheets(root);
  const names = createNames(collectClasses(sheets, DEFAULT_KEEP), { salt: seed });
  return { ...createRewriter(names), names };
}

function guard(rel, transform, source) {
  try {
    return transform(source);
  } catch (error) {
    throw new Error(`${rel}: ${error instanceof Error ? error.message : "failed"}`);
  }
}

function hardenFile(rel, code, module, seed, skipped) {
  if (Buffer.byteLength(code) > MAX_HARDEN_BYTES) {
    skipped.push({ path: rel, reason: "larger than the hardening limit" });
    return code;
  }
  try {
    const output = unescapeSpaces(harden(code, module, createHash("sha256").update(`${seed}\0${rel}`).digest("hex")));
    parseCode(output);
    return output;
  } catch (error) {
    skipped.push({ path: rel, reason: error instanceof Error ? error.message : "failed" });
    return code;
  }
}

async function transform(root, seed) {
  const virtualized = [];
  const rewriter = createClassRewriter(root, seed);
  const changed = new Set();
  const hardened = [];
  const skipped = [];

  for (const rel of walk(root)) {
    const kind = classify(rel);
    const path = join(root, rel);
    if (kind === "map") {
      rmSync(path);
      continue;
    }
    if (!["client-js", "runtime-js", "server-js", "css", "html", "flight"].includes(kind)) continue;

    const original = readFileSync(path, "utf8");
    let text = stripSourceMapComments(original);

    if (kind === "client-js") {
      const module = isModule(original);
      text = guard(rel, rewriter.js, text);
      if (text.includes(MARKER)) {
        const result = guard(rel, (code) => virtualize(code, seed), text);
        text = result.code;
        if (result.count) virtualized.push({ path: rel, functions: result.count });
        for (const reason of result.skipped) skipped.push({ path: rel, reason: `not virtualized, ${reason}` });
      }
      text = await compact(text, module);
      const next = hardenFile(rel, text, module, seed, skipped);
      if (next !== text) hardened.push(rel);
      text = next;
    } else if (kind === "server-js") {
      text = guard(rel, rewriter.js, text);
    } else if (kind === "css") {
      text = minifyCss(guard(rel, rewriter.css, text));
    } else if (kind === "html") {
      text = minifyHtml(guard(rel, rewriter.html, text));
    } else if (kind === "flight") {
      text = rewriter.flight(text);
    }

    if (text !== original) {
      writeFileSync(path, text);
      changed.add(rel);
    }
  }
  return { changed, hardened, virtualized, skipped, names: rewriter.names };
}

function precompress(root) {
  for (const rel of walk(root)) {
    if (!/\.(?:js|css|html|svg|json|txt|webmanifest)$/.test(rel) || !/(?:^|\/)static\//.test(rel)) continue;
    const content = readFileSync(join(root, rel));
    writeFileSync(join(root, `${rel}.gz`), gzipSync(content, { level: 9 }));
    writeFileSync(join(root, `${rel}.br`), brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }));
  }
}

function archiveMaps(root, target) {
  for (const rel of walk(root)) {
    if (classify(rel) !== "map") continue;
    const destination = join(target, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, rel), destination);
  }
}

export async function build(source, options) {
  const root = resolve(source);
  assertLayout(root, options.mode);
  if (Boolean(options.out) === Boolean(options.inPlace)) throw new Error("pass exactly one of --out=<dir> or --in-place");

  const staging = `${root}.staging`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(root, staging, { recursive: true, filter: (path) => relative(root, path) !== "cache" });

  try {
    if (options.mapsOut) archiveMaps(staging, resolve(options.mapsOut));
    const before = measure(staging);
    const seed = options.seed ?? createHash("sha256").update(readSheets(staging).join("\0")).digest("hex");
    const result = await transform(staging, seed);
    const renames = renameAssets(staging, seed);
    const relocate = (rel) => rel.split("/").map((part) => renames.get(part) ?? part).join("/");
    const { names, skipped } = result;
    const changed = new Set([...result.changed].map(relocate));
    const hardened = result.hardened.map(relocate);
    const virtualized = result.virtualized.map((entry) => ({ ...entry, path: relocate(entry.path) }));
    const problems = verify(staging, { mode: options.mode, changed, names });
    if (problems.length) throw new Error(`release gate failed:\n${problems.slice(0, 20).map((problem) => `  ${problem}`).join("\n")}`);

    if (options.precompress) precompress(staging);
    const after = measure(staging);
    const report = { mode: options.mode, renamedClasses: names.size, hardened, virtualized, skipped, before, after, files: inventory(staging) };

    const target = options.out ? resolve(options.out) : root;
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    if (options.report) writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
