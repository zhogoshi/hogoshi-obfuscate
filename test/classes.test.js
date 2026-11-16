import assert from "node:assert/strict";
import test from "node:test";
import { collectClasses, createNames, createRewriter, rewriteCss, SENTINEL } from "../src/classes.js";

const css = ".flex{display:flex}.items-center{align-items:center}.\\32xl\\:flex{display:flex}.w-1\\/2{width:50%}.recharts-wrapper{x:0}.content-\\[\\'\\ \\'\\]{z:1}@keyframes a{12.5%{opacity:.5}}.group-hover\\:x:is(:where(.group):hover *){y:1}";

const setup = () => {
  const classes = collectClasses([css]);
  const names = createNames(classes, { length: 16 });
  return { classes, names, rewriter: createRewriter(names) };
};

test("collects unescaped classes and skips kept, numeric, and keyframe selectors", () => {
  const { classes } = setup();
  assert.deepEqual([...classes].sort(), ["2xl:flex", "flex", "group", "group-hover:x", "items-center", "w-1/2"]);
});

test("names are long, unique, and start with a letter", () => {
  const { names } = setup();
  const values = [...names.values()];
  assert.equal(new Set(values).size, values.length);
  for (const value of values) assert.match(value, /^[A-Za-z][A-Za-z0-9]{15}$/);
});

test("css keeps an alias for bare words and renames the rest", () => {
  const { names } = setup();
  const out = rewriteCss(css, names);
  assert.ok(out.includes(`:is(.flex,.${names.get("flex")})`));
  assert.ok(out.includes(`.${names.get("items-center")}{`));
  assert.ok(out.includes(".recharts-wrapper"));
  assert.ok(out.includes("12.5%{opacity:.5}"));
});

test("js renames class strings, className values, and templates but not plain values", () => {
  const { names, rewriter } = setup();
  const out = rewriter.js('a({className:"flex",display:"flex",x:"flex items-center",y:`w-1/2 ${z} items-center`,w:`p-${z}`});');
  assert.ok(out.includes(`className:"${names.get("flex")}"`));
  assert.ok(out.includes('display:"flex"'));
  assert.ok(out.includes(`x:"${names.get("flex")} ${names.get("items-center")}"`));
  assert.ok(out.includes(`${names.get("w-1/2")} \${z} ${names.get("items-center")}`));
  assert.ok(out.includes("w:`p-${z}`"));
});

test("js injects the class table at the sentinel", () => {
  const { names, rewriter } = setup();
  const out = rewriter.js(`const t="${SENTINEL}";`);
  assert.ok(out.includes(`flex ${names.get("flex")}`));
});

test("html rewrites class attributes and flight payloads in scripts", () => {
  const { names, rewriter } = setup();
  const out = rewriter.html('<div class="flex items-center"></div><script>self.__next_f.push([1,"0:{\\"className\\":\\"w-1/2\\"}"])</script>');
  assert.ok(out.includes(`class="${names.get("flex")} ${names.get("items-center")}"`));
  assert.ok(out.includes(names.get("w-1/2")));
  assert.ok(!out.includes("w-1/2"));
});

test("html matches entity-escaped class tokens", () => {
  const { names, rewriter } = setup();
  const out = rewriter.html('<div class="flex w-1/2 [&amp;&gt;span]:x"></div>');
  assert.ok(out.includes(names.get("flex")));
  assert.ok(out.includes("[&amp;&gt;span]:x"));
});

test("names are stable for one salt and differ for another", () => {
  const classes = collectClasses([css]);
  assert.deepEqual([...createNames(classes, { salt: "a" })], [...createNames(classes, { salt: "a" })]);
  assert.notDeepEqual([...createNames(classes, { salt: "a" })], [...createNames(classes, { salt: "b" })]);
});
