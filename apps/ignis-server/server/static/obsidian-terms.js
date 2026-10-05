const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const acorn = require("acorn");
const config = require("../config");

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

let resolved;

function parse(source) {
  return acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
}

function walk(node, visit) {
  if (!node || typeof node.type !== "string") {
    return;
  }

  visit(node);

  for (const key of Object.keys(node)) {
    const child = node[key];

    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item, visit);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visit);
    }
  }
}

function isStringLiteral(node) {
  return !!node && node.type === "Literal" && typeof node.value === "string";
}

function memberName(node) {
  if (!node || node.type !== "MemberExpression") {
    return null;
  }

  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }

  if (node.computed && isStringLiteral(node.property)) {
    return node.property.value;
  }

  return null;
}

function isCallOn(node, method, firstArg) {
  return (
    !!node &&
    node.type === "CallExpression" &&
    memberName(node.callee) === method &&
    isStringLiteral(node.arguments[0]) &&
    node.arguments[0].value === firstArg
  );
}

function extractTermsFromRenderer(source) {
  let terms = null;

  walk(parse(source), (node) => {
    if (
      terms !== null ||
      node.type !== "BinaryExpression" ||
      !EQUALITY_OPERATORS.has(node.operator)
    ) {
      return;
    }

    if (
      isStringLiteral(node.left) &&
      isCallOn(node.right, "sendSync", "terms")
    ) {
      terms = node.left.value;
    } else if (
      isStringLiteral(node.right) &&
      isCallOn(node.left, "sendSync", "terms")
    ) {
      terms = node.right.value;
    }
  });

  return terms;
}

function extractTermsFromMain(source) {
  const ast = parse(source);
  const topLevelStrings = new Map();

  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") {
      continue;
    }

    for (const declarator of statement.declarations) {
      if (
        declarator.id.type === "Identifier" &&
        isStringLiteral(declarator.init)
      ) {
        topLevelStrings.set(declarator.id.name, declarator.init.value);
      }
    }
  }

  let handler = null;

  walk(ast, (node) => {
    if (handler === null && isCallOn(node, "on", "terms")) {
      handler = node.arguments[1] || null;
    }
  });

  if (!handler) {
    return null;
  }

  let terms = null;

  walk(handler, (node) => {
    if (
      terms !== null ||
      node.type !== "AssignmentExpression" ||
      memberName(node.left) !== "returnValue"
    ) {
      return;
    }

    if (node.right.type === "Identifier") {
      terms = topLevelStrings.get(node.right.name) ?? null;
    }
  });

  return terms;
}

function extractFromAsset(assetsPath, name, extract) {
  let source;

  try {
    source = fs.readFileSync(path.join(assetsPath, name), "utf-8");
  } catch {
    return null;
  }

  try {
    return extract(source);
  } catch (e) {
    console.warn(
      `[ignis] Obsidian terms: could not parse ${name}: ${e.message}`,
    );
    return null;
  }
}

function resolveObsidianTermsUncached({
  assetsPath = config.obsidianAssetsPath,
  override = config.obsidianTermsOverride,
} = {}) {
  if (override) {
    console.log("[ignis] Obsidian terms: using OBSIDIAN_TERMS_STRING");
    return override;
  }

  const fromRenderer = extractFromAsset(
    assetsPath,
    "app.js",
    extractTermsFromRenderer,
  );
  const fromMain = extractFromAsset(
    assetsPath,
    "main.js",
    extractTermsFromMain,
  );

  if (fromRenderer !== null && fromMain !== null && fromRenderer !== fromMain) {
    console.warn(
      "[ignis] Obsidian terms: app.js and main.js disagree, using app.js",
    );
  }

  if (fromRenderer !== null) {
    console.log("[ignis] Obsidian terms: extracted from app.js");
    return fromRenderer;
  }

  if (fromMain !== null) {
    console.warn(
      "[ignis] Obsidian terms: not found in app.js, using the main.js value",
    );
    return fromMain;
  }

  console.log("[ignis] Obsidian terms: no handshake in the served Obsidian");
  return null;
}

function getObsidianTerms() {
  if (resolved === undefined) {
    resolved = resolveObsidianTerms();
  }

  return resolved;
}

// ---- Vitreus：条款串落盘缓存 ----
// 为什么：extractTermsFromRenderer 用 acorn 对整份 app.js（数 MB）做完整 AST 解析，
// 在手机上 Node 以 --jitless（纯解释）运行时要占用主线程数秒；而它发生在 listen 回调里，
// 期间 WebView 的首批请求全部排队——真机冷启动进网页要白等 ~6 秒的主因（热启动 <0.1s，
// 因为结果已 memo）。条款串只取决于组件包内容，按内容哈希缓存到资源目录，冷启动命中直接读。
const TERMS_CACHE_FILE = ".vitreus-terms-cache.json";

function contentKey(assetsPath) {
  const h = crypto.createHash("sha1");
  let any = false;

  for (const name of ["app.js", "main.js"]) {
    try {
      h.update(name + "\0");
      h.update(fs.readFileSync(path.join(assetsPath, name)));
      any = true;
    } catch {
      h.update("missing");
    }
  }

  return any ? h.digest("hex") : null;
}

function resolveObsidianTerms(opts = {}) {
  const assetsPath = opts.assetsPath ?? config.obsidianAssetsPath;
  const override = opts.override ?? config.obsidianTermsOverride;

  if (override) {
    return resolveObsidianTermsUncached(opts);
  }

  const t0 = Date.now();
  let key = null;
  const cacheFile = path.join(assetsPath, TERMS_CACHE_FILE);

  try {
    key = contentKey(assetsPath);
    if (key !== null && fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (c && c.key === key && "terms" in c) {
        console.log(`[ignis] Obsidian terms: cache hit (${Date.now() - t0}ms)`);
        return c.terms;
      }
    }
  } catch (e) {
    console.warn(`[ignis] Obsidian terms: cache read failed: ${e.message}`);
  }

  const terms = resolveObsidianTermsUncached(opts);
  console.log(`[ignis] Obsidian terms: parsed in ${Date.now() - t0}ms`);

  if (key !== null) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ key, terms }));
    } catch (e) {
      console.warn(`[ignis] Obsidian terms: cache write failed: ${e.message}`);
    }
  }

  return terms;
}

module.exports = {
  getObsidianTerms,
  resolveObsidianTerms,
  extractTermsFromRenderer,
  extractTermsFromMain,
};
