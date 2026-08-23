// Vitreus 定制打包：把 ignis server 打成鸿蒙可用的单 bundle
// 策略：
//   1. esbuild 全量 bundle（node_modules 内联，免装依赖）
//   2. __dirname 问题：bundle 运行时 __dirname = bundle 所在目录。
//      server 代码假设的目录结构是 <root>/apps/ignis-server/server/，
//      所以 bundle 放到同样深度：out/apps/ignis-server/server/index.js
//      伴随文件（build-info.json、demo-capacity.html、assets/、静态目录）也复制到对应位置
//   3. 手机沙箱里布置为：ignis/apps/ignis-server/server/index.js + ignis/packages/{ui,shim}/dist/...
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "ohos-out");
const SERVER_DIR = path.join(OUT, "apps", "ignis-server", "server");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SERVER_DIR, { recursive: true });

// 1. esbuild bundle（fsevents 是 macOS 可选依赖，Linux/OHOS 不装不打包）
execSync(
  `npx esbuild apps/ignis-server/server/index.js ` +
    `--bundle --platform=node --format=cjs ` +
    `--outfile=${JSON.stringify(path.join(SERVER_DIR, "index.js"))} ` +
    `--external:fsevents --loader:.node=empty`,
  { stdio: "inherit", cwd: ROOT },
);

// 2. 运行时伴随文件（__dirname 相对读取的）
// build-info.json 不复制仓库里的过期产物——以根 package.json 版本为准现场生成
// （上游这份文件只有发版 CI 会刷新，仓库内长期滞后）
const SEMVER = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
).version;
fs.writeFileSync(
  path.join(SERVER_DIR, "build-info.json"),
  JSON.stringify(
    { semver: SEMVER, build: "vitreus", version: SEMVER + "+vitreus" },
    null,
    2,
  ) + "\n",
);
fs.copyFileSync(
  path.join(ROOT, "apps/ignis-server/server/demo/demo-capacity.html"),
  path.join(SERVER_DIR, "demo-capacity.html"),
);
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/assets"),
  path.join(SERVER_DIR, "assets"),
  { recursive: true },
);
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/plugins"),
  path.join(SERVER_DIR, "plugins"),
  { recursive: true },
);
// demo-template（demo 模式用，占空间小，保留以防引用）
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/demo-template"),
  path.join(SERVER_DIR, "demo-template"),
  { recursive: true },
);

// 3. REPO_ROOT 相对静态目录：packages/ui/dist、packages/shim/dist、images/favicon
fs.cpSync(
  path.join(ROOT, "packages/ui/dist"),
  path.join(OUT, "packages/ui/dist"),
  { recursive: true },
);
fs.cpSync(
  path.join(ROOT, "packages/shim/dist"),
  path.join(OUT, "packages/shim/dist"),
  { recursive: true },
);
// shim dist 同样是上游 CI 才重编的旧产物：window.__ignis.version 烤死在构建时。
// 页面关于栏显示的就是它——打包时自动对齐到根 package.json 版本，一劳永逸。
{
  const shimOut = path.join(OUT, "packages/shim/dist/shim-loader.js");
  let s = fs.readFileSync(shimOut, "utf-8");
  const m = s.match(/window\.__ignis = \{ version: "([^"]+)", build: "[^"]+" \}/);
  if (m && m[1] !== SEMVER) {
    s = s.split('version: "' + m[1] + '"').join('version: "' + SEMVER + '"');
    fs.writeFileSync(shimOut, s);
    console.log("shim 版本串已对齐: " + m[1] + " -> " + SEMVER);
  }
}
fs.mkdirSync(path.join(OUT, "images"), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, "images/favicon.png"),
  path.join(OUT, "images/favicon.png"),
);

console.log("\n=== ohos-out 布局 ===");
execSync(`find ${OUT} -type f | head -30`, { stdio: "inherit", cwd: ROOT });
console.log("\n总大小:");
execSync(`du -sh ${OUT}`, { stdio: "inherit", cwd: ROOT });
