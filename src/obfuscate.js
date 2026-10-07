import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import vm from "node:vm";
import JavaScriptObfuscator from "javascript-obfuscator";

const TEXT_EXTENSIONS = new Set([".js", ".css", ".html", ".rsc"]);
const SKIP_DIRS = new Set(["cache", "node_modules", "trace", ".vercel"]);
const RUNTIME_FILE = /(?:^|\/)(?:webpack|turbopack|polyfills|framework|main-app|main)[-.]/;
const RESERVED_CLASS = new Set(["dark", "light", "container"]);
const RESERVED_CLASS_PREFIX = ["hljs-", "language-", "prose", "shiki-"];
const RESERVED_VAR_PREFIX = ["--tw-", "--next", "--rsc", "--react"];

const TOKEN_HEAD = "αβγδεζηθικλμνξοπρστυφχψωабвгдежзийклмнопрстуфхцчшщъыьэюя";
const TOKEN_TAIL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" + TOKEN_HEAD;

function bijective(value, alphabet) {
  const base = alphabet.length;
  let out = "";
  while (value > 0) {
    out = alphabet[(value - 1) % base] + out;
    value = Math.floor((value - 1) / base);
  }
  return out;
}

function makeTokenGenerator(prefix = "") {
  let counter = randomBytes(2).readUInt16BE(0);
  return () => {
    const name =
      prefix + TOKEN_HEAD[counter % TOKEN_HEAD.length] + bijective(Math.floor(counter / TOKEN_HEAD.length) + 1, TOKEN_TAIL);
    counter += 1;
    return name;
  };
}

function walk(dir, files = []) {
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
      if (!SKIP_DIRS.has(entry)) walk(path, files);
      continue;
    }
    if (TEXT_EXTENSIONS.has(extname(path))) files.push(path);
  }
  return files;
}

function isClientScript(file, root) {
  const path = relative(root, file).replaceAll("\\", "/");
  return path.startsWith("static/chunks/") && path.endsWith(".js") && !RUNTIME_FILE.test(path);
}

function cssEscape(value) {
  return value.replace(/[^\p{L}\p{N}_-]/gu, "\\$&");
}

function unescapeCssIdent(value) {
  return value.replace(/\\(.)/g, "$1");
}

function shouldMangleClass(name) {
  if (name.length < 2 || name.startsWith("_") || name.includes("${")) return false;
  if (!/^[A-Za-z-]/.test(name)) return false;
  if (RESERVED_CLASS.has(name)) return false;
  if (!/[-:/.[\]0-9]/.test(name)) return false;
  return !RESERVED_CLASS_PREFIX.some((prefix) => name.startsWith(prefix));
}

function collectClasses(cssFiles) {
  const names = new Set();
  const pattern = /(?<![A-Za-z0-9])\.((?:\\.|[A-Za-z0-9_-])+)/g;
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    for (const match of css.matchAll(pattern)) {
      const name = unescapeCssIdent(match[1]);
      if (shouldMangleClass(name)) names.add(name);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function collectVariables(cssFiles) {
  const names = new Set();
  const pattern = /(?<![\w-])(--[A-Za-z][\w-]*)/g;
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    for (const match of css.matchAll(pattern)) {
      if (RESERVED_VAR_PREFIX.some((prefix) => match[1].startsWith(prefix))) continue;
      names.add(match[1]);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function collectSlots(files) {
  const names = new Set();
  const pattern = /data-slot\\?["']?\s*[:=,]\s*\\?["']?([A-Za-z][\w-]*)/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      if (!match[1].startsWith("_")) names.add(match[1]);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function makePairReplacer(pairs) {
  if (!pairs.length) return (text) => text;
  const sorted = [...pairs].sort((left, right) => right[0].length - left[0].length);
  const body = sorted.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_-])(?:${body})(?![A-Za-z0-9_-])`, "g");
  const map = new Map(pairs);
  return (text) => text.replace(re, (found) => map.get(found) ?? found);
}

function replaceSlots(text, pairs) {
  for (const [name, mangled] of pairs) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(data-slot\\\\?["']?\\s*[:=,]\\s*\\\\?["']?)${esc}(?![\\w-])`, "g");
    text = text.replace(re, `$1${mangled}`);
  }
  return text;
}

function endOfExpression(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      index = endOfString(source, index);
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    index += 1;
  }
  return index;
}

function endOfString(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && source[index + 1] === "{") {
      index = endOfExpression(source, index + 2);
      continue;
    }
    index += 1;
    if (ch === quote) return index;
  }
  return source.length;
}

function replaceString(literal, replacer) {
  const quote = literal[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return literal;
  const closed = literal.endsWith(quote);
  const body = literal.slice(1, closed ? -1 : undefined);
  const next = quote === "`" ? replaceTemplate(body, replacer) : replacer(body);
  return quote + next + (closed ? quote : "");
}

function replaceTemplate(body, replacer) {
  let out = "";
  let index = 0;
  while (index < body.length) {
    if (body[index] === "\\") {
      out += body.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (body[index] === "$" && body[index + 1] === "{") {
      const end = endOfExpression(body, index + 2);
      out += `\${${replaceInStrings(body.slice(index + 2, end - 1), replacer)}}`;
      index = end;
      continue;
    }
    const next = body.slice(index).search(/\$\{|\\/);
    const end = next === -1 ? body.length : index + next;
    out += replacer(body.slice(index, end));
    index = end;
  }
  return out;
}

function replaceInStrings(source, replacer) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      out += ch;
      index += 1;
      continue;
    }
    const end = endOfString(source, index);
    out += replaceString(source.slice(index, end), replacer);
    index = end;
  }
  return out;
}

function rewriteCss(css, classPairs, varPairs) {
  for (const [name, mangled] of classPairs) {
    const from = `.${cssEscape(name)}`;
    if (!css.includes(from)) continue;
    css = css.split(from).join(`.${cssEscape(mangled)}`);
  }
  for (const [name, mangled] of varPairs) {
    if (!css.includes(name)) continue;
    css = css.split(name).join(mangled);
  }
  return css;
}

const SCRIPT_RE = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
const PRE_RE = /(<(?:pre|textarea)\b[^>]*>)[\s\S]*?(<\/(?:pre|textarea)\s*>)/gi;

function rewriteAttribute(text, attr, replacer) {
  const re = new RegExp(`(?<![-\\w])${attr}(\\s*=\\s*)(["'])([\\s\\S]*?)\\3`, "gi");
  return text.replace(re, (_m, eq, quote, value) => `${attr}${eq}${quote}${replacer(value)}${quote}`);
}

function minifyChunk(chunk) {
  return chunk.replace(/<!--(?!\[if)[\s\S]*?-->/g, "").replace(/\s+/g, " ");
}

function minifyHtmlText(text) {
  let out = "";
  let last = 0;
  PRE_RE.lastIndex = 0;
  let match;
  while ((match = PRE_RE.exec(text)) !== null) {
    out += minifyChunk(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + minifyChunk(text.slice(last));
}

function rewriteHtmlSegment(text, classReplacer, varReplacer, minify) {
  let out = rewriteAttribute(text, "class", classReplacer);
  out = rewriteAttribute(out, "style", varReplacer);
  return minify ? minifyHtmlText(out) : out;
}

function processHtml(html, classReplacer, varReplacer, scriptReplacer, minify) {
  let out = "";
  let last = 0;
  SCRIPT_RE.lastIndex = 0;
  let match;
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    out += rewriteHtmlSegment(html.slice(last, match.index), classReplacer, varReplacer, minify);
    out += match[1] + replaceInStrings(match[2], scriptReplacer) + match[3];
    last = match.index + match[0].length;
  }
  return out + rewriteHtmlSegment(html.slice(last), classReplacer, varReplacer, minify);
}

function parses(code) {
  try {
    new vm.Script(code);
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return false;
  }
  const dir = mkdtempSync(join(tmpdir(), "hogoshi-check-"));
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

const PROFILES = {
  fast: { identifiers: "mangled", strings: 0, wrappers: 1, splitStrings: false, numbers: false, cff: false, deadCode: false, selfDefending: false },
  balanced: { identifiers: "hexadecimal", strings: 0.75, wrappers: 1, splitStrings: false, numbers: true, cff: false, deadCode: false, selfDefending: false },
  paranoid: { identifiers: "hexadecimal", strings: 1, wrappers: 2, splitStrings: true, numbers: true, cff: true, deadCode: true, selfDefending: true },
};

const MAX_SCRIPT_BYTES = 3_000_000;
const CFF_MAX_BYTES = 400_000;
const DEAD_CODE_MAX_BYTES = 150_000;

function obfuscateScript(code, profile) {
  const size = Buffer.byteLength(code);
  if (size > MAX_SCRIPT_BYTES) throw new Error(`chunk too big: ${size} bytes`);
  return JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    simplify: true,
    identifierNamesGenerator: profile.identifiers,
    renameGlobals: false,
    transformObjectKeys: false,
    stringArray: profile.strings > 0,
    stringArrayThreshold: profile.strings,
    stringArrayEncoding: ["base64"],
    stringArrayWrappersCount: profile.wrappers,
    stringArrayWrappersType: "function",
    splitStrings: profile.splitStrings,
    splitStringsChunkLength: 10,
    numbersToExpressions: profile.numbers,
    controlFlowFlattening: profile.cff && size < CFF_MAX_BYTES,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: profile.deadCode && size < DEAD_CODE_MAX_BYTES,
    deadCodeInjectionThreshold: 0.4,
    selfDefending: profile.selfDefending,
    debugProtection: false,
    unicodeEscapeSequence: false,
    reservedNames: ["^webpack", "^__webpack", "^__next", "^next", "^self$"],
    reservedStrings: ["/_next/", "__NEXT_DATA__", "next/dist", "__next_f"],
  }).getObfuscatedCode();
}

export async function obfuscateBuild(root, options = {}) {
  const profileName = options.profile ?? "balanced";
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile ${profileName}`);
  const minifyHtml = options.minifyHtml !== false;

  const files = walk(root);
  const cssFiles = files.filter((file) => file.endsWith(".css"));

  const nextClass = makeTokenGenerator();
  const nextVar = makeTokenGenerator("--");
  const nextSlot = makeTokenGenerator();

  const classPairs = collectClasses(cssFiles).map((name) => [name, nextClass()]);
  const varPairs = collectVariables(cssFiles).map((name) => [name, nextVar()]);
  const slotPairs = collectSlots(files).map((name) => [name, nextSlot()]);

  const classReplacer = makePairReplacer(classPairs);
  const varReplacer = makePairReplacer(varPairs);
  const scriptReplacer = makePairReplacer(classPairs.concat(varPairs));

  let bytesBefore = 0;
  let bytesAfter = 0;
  let scripts = 0;
  const skipped = [];

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    let text = replaceSlots(original, slotPairs);

    if (file.endsWith(".css")) {
      text = rewriteCss(text, classPairs, varPairs);
    } else if (file.endsWith(".html")) {
      text = processHtml(text, classReplacer, varReplacer, scriptReplacer, minifyHtml);
    } else {
      text = replaceInStrings(text, scriptReplacer);
    }

    if (isClientScript(file, root)) {
      try {
        const obfuscated = obfuscateScript(text, profile);
        if (!parses(obfuscated)) throw new Error("output does not parse");
        text = obfuscated;
        scripts += 1;
      } catch (error) {
        skipped.push(relative(root, file));
        console.error(`skip script ${relative(root, file)}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }

    if (text !== original) {
      writeFileSync(file, text);
      rmSync(`${file}.map`, { force: true });
    }

    bytesBefore += Buffer.byteLength(original);
    bytesAfter += Buffer.byteLength(text);
  }

  return { files: files.length, classes: classPairs.length, variables: varPairs.length, slots: slotPairs.length, scripts, skipped, bytesBefore, bytesAfter };
}
