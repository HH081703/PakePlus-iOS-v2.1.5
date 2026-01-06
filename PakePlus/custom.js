window.addEventListener("DOMContentLoaded",()=>{const t=document.createElement("script");t.src="https://www.googletagmanager.com/gtag/js?id=G-W5GKHM0893",t.async=!0,document.head.appendChild(t);const n=document.createElement("script");n.textContent="window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'G-W5GKHM0893');",document.body.appendChild(n)});const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const port = 3000;
const CDN_SERVER = 'https://xxz-xyzw-res.hortorgames.com';

// 支持pkg打包：判断是否在打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;

// 空模块加载器 - 用于mock不存在的bundle JS文件
const EMPTY_MODULE = `(function r(e,n,t){function i(u,f,c){if(!n[u]){if(!e[u]){var l=u;if(u.includes("./")&&(l=(l=u.split("/"))[l.length-1]),!e[l]){var _="function"==typeof __require&&__require;if(!f&&_)return _(l,!0);if(o)return o(l,!0);throw new Error("Cannot find module '"+u+"'")}u=l}var p=n[u]={exports:{}};e[u][0].call(p.exports,function(r){return i(e[u][1][r]||r,void 0,r.includes("./")?void 0:r)},p,p.exports,r,e,n,t)}return c&&n[u]&&!n[c]&&(n[c]=n[u]),n[u].exports}for(var o="function"==typeof __require&&__require,u=0;u<t.length;u++)i(t[u]);return i})({},{},[]);`;

// 生成包含FairyGUI包定义的config.json
function generateEmptyConfig(bundleName) {
    // 为 UI bundle 生成 FairyGUI 包路径
    const fakeUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const isFguiBundle = bundleName.startsWith('ui_');
    
    const config = {
        paths: {},
        types: [],
        uuids: [],
        scenes: {},
        redirect: [],
        deps: [],
        packs: {},
        name: bundleName,
        importBase: "import",
        nativeBase: "native",
        debug: false,
        isZip: false,
        encrypted: false,
        versions: {
            import: [],
            native: []
        }
    };
    
    // 为 FairyGUI bundle 添加包路径（游戏会检查这个）
    if (isFguiBundle) {
        config.paths[fakeUuid] = [bundleName, 0]; // [包名, 类型索引]
        config.types = ["cc.Asset"];
        config.uuids = [fakeUuid];
    }
    
    return JSON.stringify(config, null, 2);
}

// 动态从 settings.js 读取 remoteBundles 和 bundleVers
const settingsPath = path.join(baseDir, 'settings.js');
let remoteBundles = [];
let bundleVers = {};
try {
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    
    // 提取 remoteBundles
    const remoteBundlesMatch = settingsContent.match(/remoteBundles:\s*\[([^\]]+)\]/);
    if (remoteBundlesMatch && remoteBundlesMatch[1]) {
        const matches = remoteBundlesMatch[1].match(/"([^"]+)"/g);
        if (matches) {
            remoteBundles = matches.map(m => m.replace(/"/g, ''));
        }
    }
    
    // 提取 bundleVers - 匹配到对象结尾（倒数第二个}）
    const bundleVersMatch = settingsContent.match(/bundleVers:\s*\{([^}]+)\}/);
    if (bundleVersMatch && bundleVersMatch[1]) {
        const pairs = bundleVersMatch[1].match(/(\w+):\s*"([^"]+)"/g);
        if (pairs) {
            pairs.forEach(pair => {
                const [key, value] = pair.split(':').map(s => s.trim().replace(/"/g, ''));
                bundleVers[key] = value;
            });
        }
    }
    
    console.log(`📦 读取到 ${Object.keys(bundleVers).length} 个 bundle 版本号`);
} catch (e) {
    console.error('❌ Error reading settings.js:', e);
    process.exit(1);
}

// 构建白名单：核心bundles + 所有remoteBundles
const WHITELIST = new Set([
    'internal', 'main', 'game', 'miniGameRes', 'miniGameScripts', 'TEST_REMOTE_MODULE',
    ...remoteBundles
]);

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.ico': 'image/x-icon',
    '.bin': 'application/octet-stream'
};

function isWhitelisted(requestPath) {
    if (!requestPath.startsWith('/assets/')) return false;
    const parts = requestPath.split('/');
    if (parts.length < 3) return false;
    const bundleName = parts[2];
    return WHITELIST.has(bundleName);
}

const server = http.createServer((req, res) => {
    let requestPath = url.parse(req.url).pathname;
    if (requestPath === '/') requestPath = '/index.html';

    const localFilePath = path.join(baseDir, requestPath);
    const ext = path.extname(localFilePath);
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    // 智能缓存策略
    function getCacheControl(requestPath) {
        // HTML文件：短期缓存（5分钟），允许验证
        if (requestPath.endsWith('.html')) {
            return 'public, max-age=300, must-revalidate';
        }
        // JS插件文件（toolbox, shark等）：中期缓存（1小时），可能会更新
        if (requestPath.match(/\/(toolbox|shark-extension|settings|game-defines|main)\.js$/)) {
            return 'public, max-age=3600, must-revalidate';
        }
        // 游戏核心资源（cocos, index.js等）：长期缓存（1天）
        if (requestPath.match(/\/(cocos2d-js-min|index\.\w+)\.js$/)) {
            return 'public, max-age=86400, immutable';
        }
        // 静态资源（图片、音频、字体等）：长期缓存（30天）
        if (requestPath.match(/\.(png|jpg|jpeg|gif|webp|mp3|ogg|woff|woff2|ttf|bin)$/)) {
            return 'public, max-age=2592000, immutable';
        }
        // config.json：中期缓存（1小时）
        if (requestPath.endsWith('.json')) {
            return 'public, max-age=3600, must-revalidate';
        }
        // CSS：中期缓存（1小时）
        if (requestPath.endsWith('.css')) {
            return 'public, max-age=3600, must-revalidate';
        }
        // 默认：短期缓存（5分钟）
        return 'public, max-age=300';
    }
    
    const cacheControl = getCacheControl(requestPath);
    res.setHeader('Cache-Control', cacheControl);

    // 先尝试本地文件
    fs.access(localFilePath, fs.constants.R_OK, (err) => {
        if (!err) {
            // 本地文件存在,直接返回
            fs.readFile(localFilePath, (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Server Error');
                    console.log(`[❌ READ ERROR] ${requestPath}`);
                } else {
                    res.writeHead(200, { 'Content-Type': mimeType });
                    res.end(data);
                    // 对于game/main显示文件大小
                    if (requestPath.includes('/game/') || requestPath.includes('/main/')) {
                        console.log(`[本地] ${requestPath} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
                    } else {
                        console.log(`[本地] ${requestPath}`);
                    }
                }
            });
        } else {
            // ⚠️ 文件不存在 - 记录详细信息
            if (requestPath.includes('/game/') || requestPath.includes('/main/')) {
                console.log(`[⚠️ ACCESS FAILED] ${requestPath} -> ${localFilePath}`);
            }
            // 本地没有,检查是否在白名单内
            if (isWhitelisted(requestPath)) {
                // ⚠️ game和main的JS文件必须从本地加载，不能返回空模块
                // internal、UI bundles的JS可以返回空模块
                const isGameOrMain = requestPath.includes('/game/') || requestPath.includes('/main/');
                
                // 对于白名单中的 .js 文件,检查是否为核心bundle
                if (requestPath.endsWith('.js') || requestPath.endsWith('/index.js')) {
                    if (isGameOrMain) {
                        // game和main的JS必须存在，返回404说明有严重问题
                        res.writeHead(404);
                        res.end('Critical bundle JS file not found: ' + requestPath);
                        console.log(`[❌ 核心JS缺失] ${requestPath}`);
                        return;
                    }
                    
                    // internal和UI bundles返回空模块
                    res.writeHead(200, { 'Content-Type': 'text/javascript' });
                    res.end(EMPTY_MODULE);
                    console.log(`[空模块] ${requestPath}`);
                    return;
                }
                
                // 对于其他文件(config.json等),尝试从CDN代理
                // 构建正确的CDN URL (需要添加版本号)
                let cdnPath;
                if (requestPath.endsWith('/config.json')) {
                    // 从 /assets/bundleName/config.json 提取 bundleName
                    const bundleName = requestPath.split('/')[2];
                    // 查找版本号并构建正确的路径
                    if (bundleVers[bundleName]) {
                        const version = bundleVers[bundleName];
                        cdnPath = `/remote/${bundleName}/config.${version}.json`;
                    } else {
                        // 没有版本号，使用原路径
                        cdnPath = requestPath.replace('/assets/', '/remote/');
                    }
                } else {
                    // 非config.json文件，直接替换路径
                    cdnPath = requestPath.replace('/assets/', '/remote/');
                }
                
                const cdnUrl = 'https://xxz-xyzw-res.hortorgames.com' + cdnPath;
                
                // 对boss相关资源，使用服务器代理模式以便检查内容
                const isBossResource = requestPath.includes('/boss_') || requestPath.includes('/baobaoshe');
                
                if (isBossResource) {
                    console.log(`[🎯 BOSS资源] ${requestPath} -> ${cdnUrl}`);
                    
                    // 使用https模块代理请求
                    https.get(cdnUrl, (cdnRes) => {
                        const chunks = [];
                        cdnRes.on('data', chunk => chunks.push(chunk));
                        cdnRes.on('end', () => {
                            const data = Buffer.concat(chunks);
                            console.log(`[✅ BOSS资源] ${requestPath} (${(data.length / 1024).toFixed(2)} KB, Status: ${cdnRes.statusCode})`);
                            
                            // 检查是否有错误
                            if (cdnRes.statusCode !== 200) {
                                console.log(`[⚠️  BOSS资源错误] ${requestPath} - CDN返回状态码 ${cdnRes.statusCode}`);
                            }
                            
                            // 返回给客户端
                            res.writeHead(cdnRes.statusCode, cdnRes.headers);
                            res.end(data);
                        });
                    }).on('error', (err) => {
                        console.log(`[❌ BOSS资源失败] ${requestPath} - ${err.message}`);
                        res.writeHead(502);
                        res.end('CDN Error');
                    });
                } else {
                    // 其他资源：302重定向让客户端直连CDN（更快，支持浏览器缓存）
                    // 重定向本身也缓存，避免重复查询服务器
                    res.writeHead(302, {
                        'Location': cdnUrl,
                        'Cache-Control': 'public, max-age=86400' // 重定向缓存1天
                    });
                    res.end();
                    console.log(`[客户端直连CDN] ${requestPath}`);
                }
            } else {
                // 不在白名单中 - 直接返回404
                res.writeHead(404);
                res.end('Not Found');
                console.log(`[404] ${requestPath}`);
            }
        }
    });
});

server.listen(port, () => {
    console.log('============================================');
    console.log('咸鱼之王H5');
    console.log('基于v2.0.7 settings (动态读取)');
    console.log('============================================');
    console.log(`🌐 服务器: http://localhost:${port}`);
    console.log(`📦 CDN服务器: ${CDN_SERVER}/remote`);
    console.log(`✅ 白名单bundles: ${WHITELIST.size} 个`);
    console.log(`📝 策略: .js文件返回空模块, 其他文件CDN代理`);
    console.log('按 Ctrl+C 停止服务器');
    console.log('============================================');
});
