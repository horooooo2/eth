/**
 * 生成 EdgeOne Pages 直传目录：静态前端 + 带 onRequest 的 /api Cloud Function。
 *
 * 体积要点：只保留一份 [[default]].js 全量包（apiGateway 内按 path 分发），
 * 不再把同一份 1MB+ bundle 复制到每个子路由文件。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.join(__dirname, '..');
const projectRoot = path.join(backendRoot, '..');
const edgeoneRoot = path.join(projectRoot, 'whale-tracker-edgeone');
const deployRoot = path.join(projectRoot, 'whale-tracker-deploy');
const frontendDist = path.join(projectRoot, 'whale-tracker-frontend', 'dist');
const publicDir = path.join(deployRoot, 'public');
const apiOutDir = path.join(edgeoneRoot, 'cloud-functions', 'api');
const bundleFile = path.join(apiOutDir, '[[default]].js');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeText(dest, contents) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents, 'utf8');
}

const staticSrc = fs.existsSync(frontendDist) ? frontendDist : publicDir;
if (!fs.existsSync(path.join(staticSrc, 'index.html'))) {
  throw new Error(`找不到前端产物：${staticSrc}`);
}

fs.rmSync(edgeoneRoot, { recursive: true, force: true });
fs.mkdirSync(apiOutDir, { recursive: true });
copyDir(staticSrc, edgeoneRoot);
fs.mkdirSync(apiOutDir, { recursive: true });

const iifeFile = path.join(apiOutDir, '_bundle.iife.js');
const buildOptions = {
  entryPoints: [path.join(backendRoot, 'edgeone-handler.js')],
  bundle: true,
  platform: 'node',
  format: 'iife',
  globalName: 'WhaleTrackerHandler',
  minify: true,
  legalComments: 'none',
  outfile: iifeFile,
  logLevel: 'info',
};

let built = false;
try {
  const esbuild = require('esbuild');
  esbuild.buildSync(buildOptions);
  built = true;
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (!built) {
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'esbuild',
      path.join(backendRoot, 'edgeone-handler.js'),
      '--bundle',
      '--platform=node',
      '--format=iife',
      '--global-name=WhaleTrackerHandler',
      '--minify',
      '--legal-comments=none',
      `--outfile=${iifeFile}`,
    ],
    { cwd: backendRoot, stdio: 'inherit', shell: true },
  );
  if (result.status !== 0) throw new Error('esbuild 打包失败');
}

if (!fs.existsSync(iifeFile)) {
  throw new Error(`未生成 ${iifeFile}`);
}

const bundled = `${fs.readFileSync(iifeFile, 'utf8')}

export async function onRequest(context) {
  return WhaleTrackerHandler.onRequest(context);
}
export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
export const onRequestOptions = onRequest;
export default onRequest;
`;
fs.writeFileSync(bundleFile, bundled, 'utf8');
fs.unlinkSync(iifeFile);

writeText(
  path.join(edgeoneRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: 'whale-tracker-edgeone',
      private: true,
      type: 'module',
    },
    null,
    2,
  )}\n`,
);

writeText(
  path.join(edgeoneRoot, 'edgeone.json'),
  `${JSON.stringify(
    {
      headers: [
        {
          source: '/index.html',
          headers: [{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' }],
        },
        {
          source: '/assets/*',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const edgeFnSrc = path.join(backendRoot, 'edge-functions', 'poly-fed.js');
if (fs.existsSync(edgeFnSrc)) {
  copyFile(edgeFnSrc, path.join(edgeoneRoot, 'edge-functions', 'poly-fed.js'));
}

writeText(
  path.join(edgeoneRoot, 'DEPLOY.txt'),
  `巨鲸追踪 · EdgeOne Pages 部署（直传）

请上传本文件夹的全部内容，根目录必须同时有：
- index.html
- assets/
- cloud-functions/api/[[default]].js
- edge-functions/
- edgeone.json
- package.json

不要只传 public，也不要再套一层 whale-tracker-edgeone 目录。

部署后先打开：
  https://你的域名/api/health
应返回 {"ok":true,"service":"whale-tracker",...}

美联储定价（若 /api/markets 里 fed.items 为空）：
  https://你的域名/poly-fed
应返回含 items 的 JSON。这是边缘函数，用来绕过国内机房访问不了 Polymarket 的问题。

若 health 仍是 404：当前「直接上传」项目可能不会编译 Node 云函数。
需要新建一个「导入 Git 仓库」项目，或改用有 Node 的服务器跑 whale-tracker-deploy。
`,
);

const libFiles = [
  'server.js',
  'lib/createApp.js',
  'lib/apiGateway.js',
  'lib/cache.js',
  'lib/config.js',
  'lib/calendar.js',
  'lib/calendarFeed.js',
  'lib/markets.js',
  'lib/hyperliquid.js',
  'lib/onchain.js',
  'lib/exchangeLabels.js',
  'lib/newsService.js',
  'lib/whales.js',
  'lib/news.js',
  'routes/markets.js',
  'routes/whales.js',
  'routes/news.js',
];
for (const rel of libFiles) {
  const src = path.join(backendRoot, rel);
  if (fs.existsSync(src)) copyFile(src, path.join(deployRoot, rel));
}
for (const name of ['whales.json', 'whales-stable.json', 'whales-hf.json']) {
  const src = path.join(backendRoot, 'config', name);
  if (fs.existsSync(src)) copyFile(src, path.join(deployRoot, 'config', name));
}
copyDir(staticSrc, publicDir);

const nodeDeployTxt = `巨鲸追踪 · 生产部署

一、有 Node 服务器（推荐，功能最完整）
1. 进入 whale-tracker-deploy 目录
2. npm install --omit=dev
3. npm start
   或 PORT=3000 node server.js
浏览器访问 http://服务器IP:3000
健康检查 http://服务器IP:3000/api/health

二、EdgeOne Pages（当前站点 *.edgeone.cool）
请上传 whale-tracker-edgeone 整个文件夹（必须含 cloud-functions）。
详见 whale-tracker-edgeone/DEPLOY.txt

config/whales.json 为监控地址；cache/ 运行后自动生成。
`;
fs.writeFileSync(path.join(deployRoot, 'DEPLOY.txt'), nodeDeployTxt, 'utf8');
copyFile(path.join(deployRoot, 'DEPLOY.txt'), path.join(backendRoot, 'DEPLOY.txt'));

const apiSize = fs.statSync(bundleFile).size;
const staticSize = (() => {
  let sum = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'cloud-functions' || entry.name === 'edge-functions') continue;
        walk(p);
      } else sum += fs.statSync(p).size;
    }
  };
  walk(edgeoneRoot);
  return sum;
})();
console.log(`EdgeOne 目录已生成: ${edgeoneRoot}`);
console.log(
  `体积：API [[default]].js ${(apiSize / 1024).toFixed(0)} KB；静态约 ${(staticSize / 1024).toFixed(0)} KB`,
);
console.log('请将该文件夹整体上传到 EdgeOne（根目录需有 index.html 和 cloud-functions）。');
