// Vitreus 定制打包：把 ignis server 打成鸿蒙可用的单 bundle
// 策略：
//   1. esbuild 全量 bundle（node_modules 内联，免装依赖）
//   2. __dirname 问题：bundle 运行时 __dirname = bundle 所在目录。
//      server 代码假设的目录结构是 <root>/apps/ignis-server/server/，
//      所以 bundle 放到同样深度：out/apps/ignis-server/server/index.js
//      伴随文件（build-info.json、assets/、静态目录）也复制到对应位置
//   3. 手机沙箱里布置为：ignis/apps/ignis-server/server/index.js + ignis/packages/{ui,shim}/dist/...
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { forkVersion, fork } = require("./scripts/vitreus-fork-version");

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
    `--external:fsevents --loader:.node=empty ` +
    `--define:process.env.IGNIS_ALLOW_LAN_PROXY='"true"'`,
  { stdio: "inherit", cwd: ROOT },
);

// 2. 运行时伴随文件（__dirname 相对读取的）
// build-info.json 不复制仓库里的过期产物——以根 package.json 版本为准现场生成
// （上游这份文件只有发版 CI 会刷新，仓库内长期滞后）
const SEMVER = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
).version;
// 版本口径：semver 保留上游基线，version 走 vitreus 分支口径
// （<upstream>-mod），避免自编译产物被误认成上游版本
const FORK_VERSION = forkVersion();
fs.writeFileSync(
  path.join(SERVER_DIR, "build-info.json"),
  JSON.stringify(
    {
      semver: SEMVER,
      build: fork.name + "." + fork.revision,
      version: FORK_VERSION,
      upstream: SEMVER,
      fork: fork.name,
      forkRevision: fork.revision,
    },
    null,
    2,
  ) + "\n",
);
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/assets"),
  path.join(SERVER_DIR, "assets"),
  { recursive: true },
);
// 0.8.11: 上游 buildIndexHtml 移入 server/static/，模板路径用 __dirname/../assets
// （源码树=server/assets）。esbuild 内联后 __dirname=server/，解析成
// apps/ignis-server/assets ——补一份镜像让两种布局都成立（~40KB）
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/assets"),
  path.join(OUT, "apps", "ignis-server", "assets"),
  { recursive: true },
);
fs.cpSync(
  path.join(ROOT, "apps/ignis-server/server/plugins"),
  path.join(SERVER_DIR, "plugins"),
  {
    recursive: true,
    // 测试文件不随设备包走：设备侧没有测试运行器，纯占体积；同时仓库内
    // vitest 会扫到 ohos-out 里的副本，而产物树缺少 obsidian-account/ 等
    // 源码侧依赖，于是产生一条与源码无关的幻影失败。
    filter: (src) => !/\.test\.[cm]?js$/.test(src),
  },
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
// shim dist 的 window.__ignis.version 是构建期烤死的字符串，关于栏显示的就是它，
// 打包时统一对齐到 vitreus 分支口径。
{
  const shimOut = path.join(OUT, "packages/shim/dist/shim-loader.js");
  let s = fs.readFileSync(shimOut, "utf-8");
  const m = s.match(/window\.__ignis = \{ version: "([^"]+)", build: "[^"]+" \}/);
  if (m && m[1] !== FORK_VERSION) {
    s = s.split('version: "' + m[1] + '"').join('version: "' + FORK_VERSION + '"');
    fs.writeFileSync(shimOut, s);
    console.log("shim 版本串已对齐: " + m[1] + " -> " + FORK_VERSION);
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
