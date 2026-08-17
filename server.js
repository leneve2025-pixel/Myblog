const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  用户配置区（无需配置 BASE_PATH）
// ============================================================
const CONFIG = {
    DATA_REPO: process.env.REPO_NAME || 'leneve2025-pixel/Myblogdata',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    IMGBB_API_KEY: process.env.IMGBB_API_KEY || 'c236b3b6ca6d92c602ed045dcc21e7e1',
    SUPER_ADMIN: {
        username: 'xiaohai',
        password: '114514'
    },
    CACHE_TTL: 300
};

// ============================================================
//  核心逻辑
// ============================================================
const { DATA_REPO, GITHUB_TOKEN, IMGBB_API_KEY, SUPER_ADMIN, CACHE_TTL } = CONFIG;
if (!GITHUB_TOKEN || !DATA_REPO) {
    console.error('❌ 缺少 GITHUB_TOKEN 或 DATA_REPO');
    process.exit(1);
}

const [OWNER, REPO] = DATA_REPO.split('/');
const octokit = new Octokit({
    auth: GITHUB_TOKEN,
    request: { timeout: 10000 }
});

// ---------- 内存缓存 ----------
const cache = {
    index: null, indexTime: 0,
    users: null, usersTime: 0,
    config: null, configTime: 0,
    posts: {}
};

function isCacheValid(type) {
    const now = Date.now();
    if (type === 'index') return cache.index && (now - cache.indexTime) < CACHE_TTL * 1000;
    if (type === 'users') return cache.users && (now - cache.usersTime) < CACHE_TTL * 1000;
    if (type === 'config') return cache.config && (now - cache.configTime) < CACHE_TTL * 1000;
    return false;
}

function getPostCache(postId) {
    const entry = cache.posts[postId];
    if (entry && (Date.now() - entry.time) < CACHE_TTL * 1000) return entry.data;
    return null;
}

function setPostCache(postId, data) {
    cache.posts[postId] = { data, time: Date.now() };
}

function clearPostCache(postId) {
    delete cache.posts[postId];
}

const INDEX_PATH = 'index.json';
const POSTS_DIR = 'posts';
const USERS_PATH = 'users.json';
const CONFIG_PATH = 'config.json';

// ---------- 辅助函数 ----------
function generateId(title, content) {
    return crypto.createHash('md5').update(title + content).digest('hex').slice(0, 8);
}

async function getFileContent(path, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
            return Buffer.from(data.content, 'base64').toString('utf8');
        } catch (error) {
            if (i === retries - 1) throw error;
            if (error.status === 404) return null;
            console.warn(`⚠️ 获取文件 ${path} 失败 (${i+1}/${retries}):`, error.message);
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
    return null;
}

async function saveFileContent(path, content, message, sha = null) {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const params = { owner: OWNER, repo: REPO, path, message, content: encoded };
    if (sha) params.sha = sha;
    await octokit.repos.createOrUpdateFileContents(params);
    if (path === INDEX_PATH) { cache.index = null; cache.indexTime = 0; }
    if (path === USERS_PATH) { cache.users = null; cache.usersTime = 0; }
    if (path === CONFIG_PATH) { cache.config = null; cache.configTime = 0; }
    if (path.startsWith(POSTS_DIR)) {
        const postId = path.replace(`${POSTS_DIR}/`, '').replace('.json', '');
        clearPostCache(postId);
    }
}

async function deleteFile(path, sha, message) {
    await octokit.repos.deleteFile({ owner: OWNER, repo: REPO, path, message, sha });
    if (path.startsWith(POSTS_DIR)) {
        const postId = path.replace(`${POSTS_DIR}/`, '').replace('.json', '');
        clearPostCache(postId);
    }
}

// 读取客户端 cookie（无需额外依赖）
function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    const pair = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
    if (!pair) return null;
    try { return decodeURIComponent(pair.slice(name.length + 1)); } catch { return null; }
}

// ---------- 索引 ----------
async function getIndex() {
    if (isCacheValid('index')) return cache.index;
    const content = await getFileContent(INDEX_PATH);
    if (!content) return { posts: [] };
    try {
        const parsed = JSON.parse(content);
        if (!parsed.posts) parsed.posts = [];
        cache.index = parsed;
        cache.indexTime = Date.now();
        return parsed;
    } catch {
        return { posts: [] };
    }
}

async function saveIndex(index, message = '更新文章索引') {
    const existing = await getFileContent(INDEX_PATH);
    let sha = null;
    if (existing) {
        const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: INDEX_PATH });
        sha = data.sha;
    }
    await saveFileContent(INDEX_PATH, JSON.stringify(index, null, 2), message, sha);
}

// ---------- 用户 ----------
async function getUsers() {
    if (isCacheValid('users')) return cache.users;
    const content = await getFileContent(USERS_PATH);
    if (!content) return { users: [] };
    try {
        const parsed = JSON.parse(content);
        if (!parsed.users) parsed.users = [];
        cache.users = parsed;
        cache.usersTime = Date.now();
        return parsed;
    } catch {
        return { users: [] };
    }
}

async function saveUsers(usersData, message = '更新用户列表') {
    const existing = await getFileContent(USERS_PATH);
    let sha = null;
    if (existing) {
        const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: USERS_PATH });
        sha = data.sha;
    }
    await saveFileContent(USERS_PATH, JSON.stringify(usersData, null, 2), message, sha);
}

// ---------- 配置 ----------
async function getConfig() {
    if (isCacheValid('config')) return cache.config;
    const content = await getFileContent(CONFIG_PATH);
    if (!content) {
        return { blogTitle: '我的博客', themeColor: '#4CAF50', wallpaper: '' };
    }
    try {
        const parsed = JSON.parse(content);
        if (!parsed.blogTitle) parsed.blogTitle = '我的博客';
        if (!parsed.themeColor) parsed.themeColor = '#4CAF50';
        if (!parsed.wallpaper) parsed.wallpaper = '';
        cache.config = parsed;
        cache.configTime = Date.now();
        return parsed;
    } catch {
        return { blogTitle: '我的博客', themeColor: '#4CAF50', wallpaper: '' };
    }
}

async function saveConfig(config, message = '更新配置') {
    const existing = await getFileContent(CONFIG_PATH);
    let sha = null;
    if (existing) {
        const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: CONFIG_PATH });
        sha = data.sha;
    }
    await saveFileContent(CONFIG_PATH, JSON.stringify(config, null, 2), message, sha);
}

// ---------- 文章文件 ----------
async function getPostContent(postId) {
    const cached = getPostCache(postId);
    if (cached) return cached;
    const content = await getFileContent(`${POSTS_DIR}/${postId}.json`);
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (!parsed.comments) parsed.comments = [];
    setPostCache(postId, parsed);
    return parsed;
}

async function savePostContent(postId, postData, message) {
    const path = `${POSTS_DIR}/${postId}.json`;
    const existing = await getFileContent(path);
    let sha = null;
    if (existing) {
        const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
        sha = data.sha;
    }
    await saveFileContent(path, JSON.stringify(postData, null, 2), message, sha);
    setPostCache(postId, postData);
}

async function deletePostFile(postId) {
    const path = `${POSTS_DIR}/${postId}.json`;
    const content = await getFileContent(path);
    if (!content) return;
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    await deleteFile(path, data.sha, `删除文章 ${postId}`);
    clearPostCache(postId);
}

// ---------- 初始化 ----------
async function initRepo(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            let index = await getIndex();
            if (!index.posts) {
                index = { posts: [] };
                await saveIndex(index, '重建空索引');
            }
            const usersData = await getUsers();
            if (!usersData.users) usersData.users = [];
            const superExists = usersData.users.find(u => u.username === SUPER_ADMIN.username);
            if (!superExists) {
                usersData.users.push({
                    username: SUPER_ADMIN.username,
                    password: SUPER_ADMIN.password,
                    role: 'super_admin',
                    displayName: SUPER_ADMIN.username
                });
                await saveUsers(usersData, '添加超级管理员');
            }
            const config = await getConfig();
            await saveConfig(config, '初始化配置');
            console.log('✅ GitHub 仓库初始化完成');
            return;
        } catch (err) {
            console.error(`❌ 初始化尝试 ${i+1}/${retries} 失败:`, err.message);
            if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
        }
    }
}

setTimeout(() => {
    initRepo().catch(console.error);
}, 3000);

// ---------- 中间件 ----------
app.use(bodyParser.json({ limit: '10mb' }));

// ========== 关键：自动检测子路径 ==========
// 中间件：将请求路径前缀存储到 req.basePath
app.use((req, res, next) => {
    // 从请求路径中提取第一个路径段作为 basePath
    const pathSegments = req.path.split('/').filter(Boolean);
    if (pathSegments.length > 0) {
        const firstSegment = pathSegments[0];
        // 如果是 api 或 p，说明请求的是子路径下的 API 或页面
        if (firstSegment === 'api' || firstSegment === 'p') {
            // 需要找到真实的 basePath，从 Host 或 Referer 推断
            const referer = req.headers.referer || '';
            const match = referer.match(/https?:\/\/[^\/]+(\/[^\/]+)/);
            if (match && match[1]) {
                req.basePath = match[1];
            } else {
                req.basePath = '';
            }
        } else {
            req.basePath = '/' + firstSegment;
        }
    } else {
        req.basePath = '';
    }
    // 如果请求路径以 /api 或 /p 开头，且没有设置 basePath，尝试从请求路径推断
    if (!req.basePath && (req.path.startsWith('/api') || req.path.startsWith('/p'))) {
        // 这种情况是直接访问 /api/xxx，可能是根路径部署
        req.basePath = '';
    }
    next();
});

// 静态文件托管（从请求路径中提取 basePath）
app.use((req, res, next) => {
    // 如果是静态资源请求（.css, .js, .png 等），使用通用路径
    if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico)$/)) {
        // 直接从 public 目录提供
        const staticPath = req.path.replace(/^\/[^\/]+/, '');
        if (staticPath !== req.path) {
            // 重写路径，去掉第一个路径段
            req.url = staticPath;
        }
        return express.static('public')(req, res, next);
    }
    next();
});

// 对于 HTML 请求，提取 basePath 并传递到前端
app.get(/^\/([^\/]+)(\/|$)/, (req, res, next) => {
    const basePath = '/' + req.params[0];
    // 如果是 api 或 p 开头的路径，不处理
    if (['api', 'p'].includes(req.params[0])) {
        return next();
    }
    // 如果请求的是静态资源，不处理
    if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico)$/)) {
        return next();
    }
    // 否则，渲染 index.html，并在 HTML 中注入 basePath
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 根路径处理
app.get('/', (req, res) => {
    // 检测是否有子路径，从 referer 或直接访问
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 静态文件公共访问
app.use(express.static('public'));

// ---------- 会话（Cookie 持久化） ----------
app.set('trust proxy', 1); // 支持 Render 等反向代理下的 secure cookie
app.use(session({
    secret: 'myblog-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,       // JS 无法读取，防 XSS 窃取
        sameSite: 'lax',      // 防 CSRF
        secure: 'auto',       // HTTPS 下自动加 secure
        maxAge: 7 * 24 * 60 * 60 * 1000 // 登录态保留 7 天
    }
}));

// ============================================================
//  API 路由（路径自动适配）
// ============================================================

// 获取 basePath 的辅助函数
function getBasePath(req) {
    // 从请求头 Referer 提取
    const referer = req.headers.referer || '';
    const match = referer.match(/https?:\/\/[^\/]+(\/[^\/]+)/);
    if (match && match[1]) return match[1];
    // 从请求路径推断
    const path = req.path;
    const segments = path.split('/').filter(Boolean);
    if (segments.length > 0 && segments[0] !== 'api' && segments[0] !== 'p') {
        return '/' + segments[0];
    }
    return '';
}

// 包装路由，自动适配 basePath
function autoRoute(routePath, handler) {
    // 匹配带前缀和不带前缀两种情况
    app.get(routePath, handler);
    app.get(`/:prefix${routePath}`, handler);
    app.post(routePath, handler);
    app.post(`/:prefix${routePath}`, handler);
    app.put(routePath, handler);
    app.put(`/:prefix${routePath}`, handler);
    app.delete(routePath, handler);
    app.delete(`/:prefix${routePath}`, handler);
}

// ---------- 图片上传 ----------
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('只允许图片格式'), false);
        }
    }
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '未上传文件' });
        if (!IMGBB_API_KEY) return res.status(500).json({ error: '服务器未配置图床密钥' });
        const base64 = req.file.buffer.toString('base64');
        const formData = new FormData();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64);
        formData.append('name', req.file.originalname);

        const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: { ...formData.getHeaders() },
            timeout: 15000
        });
        if (response.data && response.data.data && response.data.data.url) {
            res.json({ success: true, url: response.data.data.url });
        } else {
            res.status(500).json({ error: '图床返回异常' });
        }
    } catch (err) {
        console.error('上传错误:', err.message);
        res.status(500).json({ error: '上传失败: ' + err.message });
    }
});

// 也支持带前缀的上传
app.post('/:prefix/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '未上传文件' });
        if (!IMGBB_API_KEY) return res.status(500).json({ error: '服务器未配置图床密钥' });
        const base64 = req.file.buffer.toString('base64');
        const formData = new FormData();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64);
        formData.append('name', req.file.originalname);

        const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: { ...formData.getHeaders() },
            timeout: 15000
        });
        if (response.data && response.data.data && response.data.data.url) {
            res.json({ success: true, url: response.data.data.url });
        } else {
            res.status(500).json({ error: '图床返回异常' });
        }
    } catch (err) {
        console.error('上传错误:', err.message);
        res.status(500).json({ error: '上传失败: ' + err.message });
    }
});

// ---------- 辅助 ----------
async function findUserByUsername(username) {
    const usersData = await getUsers();
    return usersData.users.find(u => u.username === username);
}

async function isAdmin(req, res, next) {
    try {
        if (!req.session.username) return res.status(401).json({ error: '未登录' });
        const user = await findUserByUsername(req.session.username);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
            return res.status(403).json({ error: '权限不足' });
        }
        req.user = user;
        next();
    } catch (err) {
        res.status(500).json({ error: '服务器错误' });
    }
}

async function isSuperAdmin(req, res, next) {
    try {
        if (!req.session.username) return res.status(401).json({ error: '未登录' });
        const user = await findUserByUsername(req.session.username);
        if (!user || user.role !== 'super_admin') {
            return res.status(403).json({ error: '需要超级管理员权限' });
        }
        req.user = user;
        next();
    } catch (err) {
        res.status(500).json({ error: '服务器错误' });
    }
}

// ---------- API 路由（自动适配路径） ----------
// 使用正则匹配，同时支持 /api/xxx 和 /xxx/api/xxx

function wrapApi(path, middleware, handler) {
    // 兼容两种写法：
    //   wrapApi(path, handler)               -> 无鉴权中间件
    //   wrapApi(path, middleware, handler)   -> 带鉴权中间件（原 3 参数写法，旧实现会丢失 handler，已修复）
    let mw = null, h = null;
    if (handler === undefined) {
        h = middleware;   // 2 参数形式
    } else {
        mw = middleware;  // 3 参数形式
        h = handler;
    }

    if (mw) {
        app.get(path, mw, h);
        app.post(path, mw, h);
        app.put(path, mw, h);
        app.delete(path, mw, h);
    } else {
        app.get(path, h);
        app.post(path, h);
        app.put(path, h);
        app.delete(path, h);
    }

    // 子路径前缀重分发（/xxx/api/... -> /api/...）
    app.get(/^\/([^\/]+)\/api\/.*/, (req, res) => {
        const newPath = req.path.replace(/^\/[^\/]+\/api/, '/api');
        req.url = newPath;
        app.handle(req, res);
    });
    app.post(/^\/([^\/]+)\/api\/.*/, (req, res) => {
        const newPath = req.path.replace(/^\/[^\/]+\/api/, '/api');
        req.url = newPath;
        app.handle(req, res);
    });
    app.put(/^\/([^\/]+)\/api\/.*/, (req, res) => {
        const newPath = req.path.replace(/^\/[^\/]+\/api/, '/api');
        req.url = newPath;
        app.handle(req, res);
    });
    app.delete(/^\/([^\/]+)\/api\/.*/, (req, res) => {
        const newPath = req.path.replace(/^\/[^\/]+\/api/, '/api');
        req.url = newPath;
        app.handle(req, res);
    });
}

// ---------- 认证 ----------
wrapApi('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await findUserByUsername(username);
        if (!user || user.password !== password) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        req.session.username = username;
        res.json({
            success: true,
            user: {
                username: user.username,
                role: user.role,
                displayName: user.displayName || user.username
            }
        });
    } catch (err) {
        res.status(500).json({ error: '登录失败' });
    }
});

wrapApi('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

wrapApi('/api/auth/status', async (req, res) => {
    try {
        if (!req.session.username) return res.json({ isAdmin: false, user: null });
        const user = await findUserByUsername(req.session.username);
        if (!user) return res.json({ isAdmin: false, user: null });
        res.json({
            isAdmin: true,
            user: {
                username: user.username,
                role: user.role,
                displayName: user.displayName || user.username
            }
        });
    } catch (err) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// ---------- 配置 ----------
wrapApi('/api/config', async (req, res) => {
    try {
        const config = await getConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: '获取配置失败' });
    }
});

wrapApi('/api/config', isSuperAdmin, async (req, res) => {
    try {
        const { blogTitle, themeColor, wallpaper } = req.body;
        const config = await getConfig();
        if (blogTitle !== undefined) config.blogTitle = blogTitle.trim() || '我的博客';
        if (themeColor !== undefined) config.themeColor = themeColor;
        if (wallpaper !== undefined) config.wallpaper = wallpaper;
        await saveConfig(config, '更新配置');
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: '更新配置失败' });
    }
});

// ---------- 启动引导（合并 配置 + 文章列表 + 登录态，减少多次往返） ----------
wrapApi('/api/bootstrap', async (req, res) => {
    try {
        const [config, index, usersData] = await Promise.all([
            getConfig(),
            getIndex(),
            getUsers()
        ]);
        const userMap = {};
        (usersData.users || []).forEach(u => {
            userMap[u.username] = {
                displayName: u.displayName || u.username,
                avatar: u.avatar || ''
            };
        });
        const posts = (index.posts || []).map(p => {
            const user = userMap[p.author];
            return {
                ...p,
                authorDisplay: user ? user.displayName : (p.author || '未知'),
                authorAvatar: user ? user.avatar : ''
            };
        });
        let auth = { isAdmin: false, user: null };
        if (req.session && req.session.username) {
            const user = (usersData.users || []).find(u => u.username === req.session.username);
            if (user) {
                auth = {
                    isAdmin: true,
                    user: {
                        username: user.username,
                        role: user.role,
                        displayName: user.displayName || user.username
                    }
                };
            }
        }
        res.json({ config, posts, auth });
    } catch (err) {
        console.error('bootstrap 错误:', err.message);
        res.status(500).json({ error: '初始化失败: ' + err.message });
    }
});

// ---------- 用户管理 ----------
wrapApi('/api/users', isSuperAdmin, async (req, res) => {
    try {
        const usersData = await getUsers();
        const safeUsers = usersData.users.map(u => ({
            username: u.username,
            role: u.role,
            displayName: u.displayName || u.username,
            avatar: u.avatar || ''
        }));
        res.json({ users: safeUsers });
    } catch (err) {
        res.status(500).json({ error: '加载用户列表失败' });
    }
});

wrapApi('/api/users', isSuperAdmin, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
        const usersData = await getUsers();
        if (usersData.users.find(u => u.username === username)) {
            return res.status(400).json({ error: '用户名已存在' });
        }
        usersData.users.push({
            username,
            password,
            role: 'admin',
            displayName: username,
            avatar: ''
        });
        await saveUsers(usersData, `添加管理员 ${username}`);
        res.json({ success: true, user: { username, role: 'admin', displayName: username } });
    } catch (err) {
        res.status(500).json({ error: '创建用户失败' });
    }
});

wrapApi('/api/users/:username', isSuperAdmin, async (req, res) => {
    try {
        const target = req.params.username;
        if (target === req.user.username) return res.status(400).json({ error: '不能删除自己' });
        const usersData = await getUsers();
        const idx = usersData.users.findIndex(u => u.username === target);
        if (idx === -1) return res.status(404).json({ error: '用户不存在' });
        if (usersData.users[idx].role === 'super_admin') {
            return res.status(403).json({ error: '不能删除超级管理员' });
        }
        usersData.users.splice(idx, 1);
        await saveUsers(usersData, `删除管理员 ${target}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ---------- 显示名 ----------
wrapApi('/api/users/:username/displayname', async (req, res) => {
    try {
        if (!req.session.username) return res.status(401).json({ error: '未登录' });
        const currentUser = await findUserByUsername(req.session.username);
        if (!currentUser) return res.status(401).json({ error: '会话无效' });

        const targetUsername = req.params.username;
        const { displayName } = req.body;
        if (!displayName || displayName.trim() === '') {
            return res.status(400).json({ error: '显示名不能为空' });
        }

        if (currentUser.role !== 'super_admin' && currentUser.username !== targetUsername) {
            return res.status(403).json({ error: '只能修改自己的显示名' });
        }

        const usersData = await getUsers();
        const targetUser = usersData.users.find(u => u.username === targetUsername);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });

        targetUser.displayName = displayName.trim();
        await saveUsers(usersData, `修改显示名 ${targetUsername}`);
        res.json({ success: true, displayName: targetUser.displayName });
    } catch (err) {
        res.status(500).json({ error: '修改显示名失败' });
    }
});

// ---------- 头像 ----------
wrapApi('/api/users/:username/avatar', async (req, res) => {
    try {
        if (!req.session.username) return res.status(401).json({ error: '未登录' });
        const currentUser = await findUserByUsername(req.session.username);
        if (!currentUser) return res.status(401).json({ error: '会话无效' });

        const targetUsername = req.params.username;
        const { avatar } = req.body;
        if (!avatar || avatar.trim() === '') {
            return res.status(400).json({ error: '头像 URL 不能为空' });
        }

        if (currentUser.role !== 'super_admin' && currentUser.username !== targetUsername) {
            return res.status(403).json({ error: '只能修改自己的头像' });
        }

        const usersData = await getUsers();
        const targetUser = usersData.users.find(u => u.username === targetUsername);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });

        targetUser.avatar = avatar.trim();
        await saveUsers(usersData, `修改头像 ${targetUsername}`);
        res.json({ success: true, avatar: targetUser.avatar });
    } catch (err) {
        console.error('修改头像错误:', err);
        res.status(500).json({ error: '修改头像失败' });
    }
});

// ---------- 密码 ----------
wrapApi('/api/users/:username/password', async (req, res) => {
    try {
        if (!req.session.username) return res.status(401).json({ error: '未登录' });
        const currentUser = await findUserByUsername(req.session.username);
        if (!currentUser) return res.status(401).json({ error: '会话无效' });

        const targetUsername = req.params.username;
        const { oldPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 3) {
            return res.status(400).json({ error: '新密码长度至少3位' });
        }
        if (currentUser.role !== 'super_admin' && currentUser.username !== targetUsername) {
            return res.status(403).json({ error: '只能修改自己的密码' });
        }

        const usersData = await getUsers();
        const targetUser = usersData.users.find(u => u.username === targetUsername);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });

        if (currentUser.role !== 'super_admin' && currentUser.username === targetUsername) {
            if (targetUser.password !== oldPassword) {
                return res.status(401).json({ error: '旧密码错误' });
            }
        }

        targetUser.password = newPassword;
        await saveUsers(usersData, `修改密码 ${targetUsername}`);
        res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
        res.status(500).json({ error: '修改密码失败' });
    }
});

// ---------- 文章 ----------
wrapApi('/api/posts', async (req, res) => {
    try {
        const index = await getIndex();
        const usersData = await getUsers();
        const userMap = {};
        usersData.users.forEach(u => {
            userMap[u.username] = {
                displayName: u.displayName || u.username,
                avatar: u.avatar || ''
            };
        });
        const postsWithDisplay = index.posts.map(p => {
            const user = userMap[p.author];
            return {
                ...p,
                authorDisplay: user ? user.displayName : (p.author || '未知'),
                authorAvatar: user ? user.avatar : ''
            };
        });
        res.json({ posts: postsWithDisplay });
    } catch (err) {
        console.error('获取文章列表错误:', err.message);
        res.status(500).json({ error: '获取文章列表失败' });
    }
});

wrapApi('/api/posts/:id', async (req, res) => {
    try {
        const post = await getPostContent(req.params.id);
        if (!post) return res.status(404).json({ error: '文章不存在' });
        const usersData = await getUsers();
        const user = usersData.users.find(u => u.username === post.author);
        post.authorDisplay = user ? (user.displayName || user.username) : (post.author || '未知');
        post.authorAvatar = user ? (user.avatar || '') : '';
        post.views = (post.views || 0) + 1;
        // 阅读数异步落库：不阻塞文章打开，避免每次打开都等一次 GitHub 写入
        savePostContent(req.params.id, post, '更新阅读数').catch(e => console.error('更新阅读数失败:', e.message));
        res.json({ post });
    } catch (err) {
        console.error('获取文章详情错误:', err.message);
        res.status(500).json({ error: '获取文章失败: ' + err.message });
    }
});

wrapApi('/api/posts', isAdmin, async (req, res) => {
    try {
        const { title, content, cover } = req.body;
        if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
        const id = generateId(title, content);
        const index = await getIndex();
        if (index.posts.find(p => p.id === id)) {
            return res.status(400).json({ error: '文章已存在' });
        }
        const newPost = {
            id, title, content,
            cover: cover || '',
            createdAt: Date.now(),
            views: 0,
            author: req.user.username,
            comments: []
        };
        await savePostContent(id, newPost, `创建文章 ${title}`);
        index.posts.push({
            id, title,
            author: req.user.username,
            createdAt: newPost.createdAt,
            cover: newPost.cover,
        });
        await saveIndex(index, `添加文章 ${title}`);
        const usersData = await getUsers();
        const user = usersData.users.find(u => u.username === req.user.username);
        newPost.authorDisplay = user ? (user.displayName || user.username) : req.user.username;
        newPost.authorAvatar = user ? (user.avatar || '') : '';

        // 获取 basePath
        const referer = req.headers.referer || '';
        const basePathMatch = referer.match(/https?:\/\/[^\/]+(\/[^\/]+)/);
        const basePath = basePathMatch ? basePathMatch[1] : '';
        const fullUrl = `${req.protocol}://${req.get('host')}${basePath}/p/${id}`;

        res.json({
            post: newPost,
            url: fullUrl
        });
    } catch (err) {
        console.error('发布文章错误:', err);
        res.status(500).json({ error: '发布失败' });
    }
});

wrapApi('/api/posts/:id', isAdmin, async (req, res) => {
    try {
        const index = await getIndex();
        const idx = index.posts.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: '文章不存在' });
        const postMeta = index.posts[idx];
        if (req.user.role !== 'super_admin' && postMeta.author !== req.user.username) {
            return res.status(403).json({ error: '只能删除自己的文章' });
        }
        index.posts.splice(idx, 1);
        await saveIndex(index, `删除文章 ${req.params.id}`);
        await deletePostFile(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

wrapApi('/api/posts', isSuperAdmin, async (req, res) => {
    try {
        await saveIndex({ posts: [] }, '清空所有文章');
        try {
            const { data: files } = await octokit.repos.getContent({
                owner: OWNER,
                repo: REPO,
                path: POSTS_DIR,
            });
            if (Array.isArray(files)) {
                for (const file of files) {
                    if (file.type === 'file' && file.name.endsWith('.json')) {
                        await octokit.repos.deleteFile({
                            owner: OWNER,
                            repo: REPO,
                            path: `${POSTS_DIR}/${file.name}`,
                            message: `清空文章: 删除 ${file.name}`,
                            sha: file.sha,
                        });
                    }
                }
            }
        } catch (e) {}
        res.json({ success: true, message: '所有文章已清空' });
    } catch (err) {
        res.status(500).json({ error: '清空文章失败' });
    }
});

// ---------- 评论（支持未登录匿名评论） ----------
wrapApi('/api/posts/:id/comments', async (req, res) => {
    try {
        const postId = req.params.id;
        const { content, authorName } = req.body;
        if (!content || content.trim() === '') {
            return res.status(400).json({ error: '评论内容不能为空' });
        }
        const post = await getPostContent(postId);
        if (!post) return res.status(404).json({ error: '文章不存在' });

        const comment = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            content: content.trim().slice(0, 1000),
            createdAt: Date.now()
        };

        if (req.session && req.session.username) {
            // 已登录：使用账号身份
            const usersData = await getUsers();
            const user = usersData.users.find(u => u.username === req.session.username);
            comment.author = req.session.username;
            comment.authorDisplay = user ? (user.displayName || user.username) : req.session.username;
            comment.isGuest = false;
        } else {
            // 未登录：匿名评论，用户名默认 X（可用 cookie 记住自定义昵称）
            let guestName = ((authorName || '').toString().trim().slice(0, 24)) || getCookie(req, 'guest_name') || 'X';
            if (!guestName) guestName = 'X';
            res.cookie('guest_name', guestName, {
                maxAge: 365 * 24 * 60 * 60 * 1000,
                httpOnly: false,
                sameSite: 'lax'
            });
            comment.author = 'guest';
            comment.authorDisplay = guestName;
            comment.isGuest = true;
        }

        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        await savePostContent(postId, post, '添加评论');
        res.json({ success: true, comment });
    } catch (err) {
        console.error('添加评论错误:', err);
        res.status(500).json({ error: '添加评论失败' });
    }
});

wrapApi('/api/posts/:postId/comments/:commentId', isAdmin, async (req, res) => {
    try {
        const { postId, commentId } = req.params;
        const post = await getPostContent(postId);
        if (!post) return res.status(404).json({ error: '文章不存在' });

        const idx = post.comments.findIndex(c => c.id === commentId);
        if (idx === -1) return res.status(404).json({ error: '评论不存在' });

        const comment = post.comments[idx];
        if (req.user.role !== 'super_admin' && comment.author !== req.user.username) {
            return res.status(403).json({ error: '无权删除此评论' });
        }

        post.comments.splice(idx, 1);
        await savePostContent(postId, post, `删除评论`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除评论失败' });
    }
});

// ---------- 梯子路径 ----------
app.get('/p/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/:prefix/p/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 启动 ----------
app.listen(PORT, () => {
    console.log(`博客服务已启动: http://localhost:${PORT}`);
    console.log(`访问地址: http://localhost:${PORT}/ (会自动识别子路径)`);
});