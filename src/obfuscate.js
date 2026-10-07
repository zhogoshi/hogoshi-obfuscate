import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import vm from "node:vm";
import { minify as terserMinify } from "terser";
import JavaScriptObfuscator from "javascript-obfuscator";

const TEXT_EXTENSIONS = new Set([".js", ".css", ".html"]);
const SKIP_DIRS = new Set(["cache", "node_modules", "trace", ".vercel"]);
const RUNTIME_FILE = /(?:^|\/)(?:webpack|turbopack|polyfills|framework|main-app|main)[-.]/;
const COMPRESSIBLE = new Set([".js", ".css", ".svg", ".json", ".html", ".txt", ".webmanifest"]);

const WEBPACK_RESERVED = [
  "webpackChunk_N_E", "__webpack_require__", "__webpack_modules__", "__webpack_exports__",
  "__NEXT_DATA__", "__next", "__next_f",
];

const MIN_OBF_BYTES = 2048;
const MAX_OBF_BYTES = 1_200_000;

function walk(dir, files = [], extensions = TEXT_EXTENSIONS) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path, files, extensions);
      continue;
    }
    if (!extensions || extensions.has(extname(path))) files.push(path);
  }
  return files;
}


const CSS_WS = " \t\n\r\f";

function minifyCss(css) {
  let out = "";
  let depth = 0;
  let i = 0;
  const n = css.length;
  const prevChar = () => (out.length ? out[out.length - 1] : "");

  while (i < n) {
    const ch = css[i];

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (css[j] === "\\") { j += 2; continue; }
        if (css[j] === ch) break;
        j += 1;
      }
      out += css.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      if (end !== -1 && /^!|@preserve|@license/i.test(css.slice(i + 2, end).trim())) out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "u" && /^url\(/i.test(css.slice(i, i + 4)) && !/[A-Za-z0-9_-]$/.test(prevChar())) {
      const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"][^)]*?))\s*\)/i.exec(css.slice(i));
      if (m) {
        const inner = m[1] ?? m[2] ?? m[3] ?? "";
        out += /^[\w\-./%#?=&+:~]+$/.test(inner) ? `url(${inner})` : m[0];
        i += m[0].length;
        continue;
      }
    }

    if (CSS_WS.includes(ch)) {
      let j = i;
      while (j < n && CSS_WS.includes(css[j])) j += 1;
      const prev = prevChar();
      const next = css[j] ?? "";
      const dropBefore = "{};>,+~:,".includes(prev);
      const dropAfter = "{};>,+~,".includes(next);
      if (depth === 0 && (dropBefore || dropAfter)) { i = j; continue; }
      out += " ";
      i = j;
      continue;
    }

    if (ch === ";") {
      let j = i + 1;
      while (j < n && CSS_WS.includes(css[j])) j += 1;
      if (css[j] === "}" && depth === 0) { i += 1; continue; }
      out += ";";
      i += 1;
      continue;
    }

    if (ch === "#") {
      const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/.exec(css.slice(i));
      const prev = prevChar();
      if (m && depth === 0 && (prev === ":" || prev === "(")) {
        const h = m[1];
        if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5] && (h.length === 6 || h[6] === h[7])) {
          out += `#${h[0]}${h[2]}${h[4]}${h.length === 8 ? h[6] : ""}`;
          i += m[0].length;
          continue;
        }
      }
    }

    if (ch === "0" && css[i + 1] === "." && !/[A-Za-z0-9_.]/.test(prevChar())) {
      out += ".";
      i += 2;
      continue;
    }

    if (ch === "(") { depth += 1; out += ch; i += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); out += ch; i += 1; continue; }

    out += ch;
    i += 1;
  }
  return out.trim();
}


const HTML_RAW = /^<(pre|textarea|script|style)(?=[\s>/])/i;

function copyTag(html, i) {
  const n = html.length;
  let j = i + 1;
  while (j < n) {
    const c = html[j];
    if (c === '"' || c === "'") {
      j += 1;
      while (j < n && html[j] !== c) j += 1;
      j += 1;
      continue;
    }
    if (c === ">") return j + 1;
    j += 1;
  }
  return n;
}

function minifyHtml(html) {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      const body = html.slice(i + 4, end === -1 ? n : end);
      const keep = /^\s*(\[if|#|!|\/?\$)/.test(body) || body.includes("$");
      if (keep) out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const raw = html[i] === "<" && HTML_RAW.exec(html.slice(i));
    if (raw) {
      const tag = raw[1].toLowerCase();
      const openEnd = copyTag(html, i);
      const m = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(openEnd));
      const stop = m ? openEnd + m.index + m[0].length : n;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    if (html[i] === "<") {
      const stop = copyTag(html, i);
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const next = html.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += html.slice(i, stop).replace(/\s+/g, " ");
    i = stop;
  }
  return out;
}


function checkSyntax(code, module = false) {
  if (!module) {
    try {
      new vm.Script(code);
      return true;
    } catch {
      return false;
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "slim-check-"));
  try {
    const file = join(dir, "chunk.mjs");
    writeFileSync(file, code);
    execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function terserPass(code, module) {
  const result = await terserMinify(code, {
    module,
    compress: { passes: 2, defaults: true, drop_debugger: true },
    mangle: { toplevel: false, reserved: WEBPACK_RESERVED },
    format: { comments: "some", ecma: 2020 },
  });
  if (typeof result.code !== "string" || result.code.length === 0) throw new Error("empty terser output");
  return result.code;
}

function obfuscatePass(code, module) {
  const obfuscated = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    simplify: true,
    target: "browser",
    identifierNamesGenerator: "mangled",
    renameGlobals: false,
    transformObjectKeys: false,
    stringArray: true,
    stringArrayThreshold: 1,
    stringArrayEncoding: ["base64"],
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "variable",
    splitStrings: false,
    numbersToExpressions: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    unicodeEscapeSequence: false,
    reservedNames: ["^webpack", "^__webpack", "^__next", "^next", "^self$", "^__NEXT_DATA__$"],
    reservedStrings: ["/_next/", "__NEXT_DATA__", "next/dist", "__next_f"],
  }).getObfuscatedCode();
  if (module) return obfuscated;
  return `(()=>{${obfuscated}})();`;
}

async function optimizeJs(original, { rel, module, stats }) {
  try {
    let next = await terserPass(original, module);
    if (!checkSyntax(next, module)) throw new Error("terser output does not parse");
    const size = Buffer.byteLength(next);
    if (size >= MIN_OBF_BYTES && size <= MAX_OBF_BYTES) {
      try {
        const obfuscated = obfuscatePass(next, module);
        if (checkSyntax(obfuscated, module)) {
          next = obfuscated;
          stats.js.obfuscated += 1;
        } else {
          console.error(`obfuscator output invalid, keeping terser: ${rel}`);
        }
      } catch (error) {
        console.error(`obfuscator failed, keeping terser: ${rel}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    return next;
  } catch (error) {
    stats.js.skipped.push(rel);
    console.error(`skip ${rel}: ${error instanceof Error ? error.message : "unknown"}`);
    return original;
  }
}


function precompressStatic(root) {
  let files = 0, before = 0, gzip = 0, brotli = 0;
  for (const file of walk(root, [], null)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (!rel.startsWith("static/") || !COMPRESSIBLE.has(extname(file))) continue;
    const content = readFileSync(file);
    const gz = gzipSync(content, { level: 9 });
    const br = brotliCompressSync(content, { params: { [zc.BROTLI_PARAM_QUALITY]: 6 } });
    writeFileSync(`${file}.gz`, gz);
    writeFileSync(`${file}.br`, br);
    files += 1;
    before += content.length;
    gzip += gz.length;
    brotli += br.length;
  }
  return { files, before, gzip, brotli };
}


export async function optimizeBuild(root, options = {}) {
  const doCss = options.css !== false;
  const doHtml = options.html !== false;

  const stats = {
    js: { files: 0, before: 0, after: 0, obfuscated: 0, skipped: [] },
    css: { files: 0, before: 0, after: 0 },
    html: { files: 0, before: 0, after: 0 },
    precompressed: null,
  };

  for (const file of walk(root)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const ext = extname(file);
    const original = readFileSync(file, "utf8");
    let text = original;

    if (ext === ".js" && rel.startsWith("static/") && !RUNTIME_FILE.test(rel)) {
      const module = /^\s*(?:import|export)[\s{("']/m.test(original);
      text = await optimizeJs(original, { rel, module, stats });
      if (text !== original) {
        writeFileSync(file, text);
        rmSync(`${file}.map`, { force: true });
      }
      stats.js.files += 1;
      stats.js.before += Buffer.byteLength(original);
      stats.js.after += Buffer.byteLength(text);
    } else if (ext === ".css" && doCss) {
      text = minifyCss(original);
      if (text !== original) {
        writeFileSync(file, text);
        rmSync(`${file}.map`, { force: true });
      }
      stats.css.files += 1;
      stats.css.before += Buffer.byteLength(original);
      stats.css.after += Buffer.byteLength(text);
    } else if (ext === ".html" && doHtml) {
      text = minifyHtml(original);
      if (text !== original) writeFileSync(file, text);
      stats.html.files += 1;
      stats.html.before += Buffer.byteLength(original);
      stats.html.after += Buffer.byteLength(text);
    }
  }

  if (options.precompress === true) stats.precompressed = precompressStatic(root);
  return stats;
}
