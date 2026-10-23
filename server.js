// ============================================================
//  个人博客服务端（树莓派 SSH/SFTP 存储版）
//  - 数据（index/users/config/posts/uploads）通过 SSH/SFTP 存储在树莓派 /BLOG 目录
//  - 默认连接 wh.frp.one:58373，可通过环境变量覆盖
//  - 启动：node server.js（默认端口 3000）
// ============================================================

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  用户配置区（树莓派 SSH 连接信息）
// ============================================================
const CONFIG = {
    SSH_HOST: process.env.SSH_HOST || 'wh.frp.one',
    SSH_PORT: Number(process.env.SSH_PORT || 58373),
    SSH_USER: process.env.SSH_USER || 'pi',
    SSH_PASSWORD: process.env.SSH_PASSWORD || '123',
    SSH_BASE_DIR: process.env.SSH_BASE_DIR || '/BLOG', // 树莓派根目录下的 BLOG 目录
    SUPER_ADMIN: {
        username: 'xiaohai',
        password: '114514'
    },
    CACHE_TTL: 300
};

// ============================================================
//  SSH/SFTP 存储层
// ============================================================
let sftpClient = null;
let sftpConnecting = null;

function remotePath(relPath) {
    return CONFIG.SSH_BASE_DIR + '/' + relPath;
}

async function getSftp() {
    if (sftpClient && sftpClient.sftp) return sftpClient;
    if (sftpConnecting) return sftpConnecting;
    sftpConnecting = (async () => {
        const client = new SftpClient();
        await client.connect({
            host: CONFIG.SSH_HOST,
            port: CONFIG.SSH_PORT,
            username: CONFIG.SSH_USER,
            password: CONFIG.SSH_PASSWORD,
            readyTimeout: 60000,
            retries: 3,
            retry_factor: 1.5,
            retry_minTimeout: 2000,
            keepaliveInterval: 10000
        });
        // 确保 /BLOG、/BLOG/posts、/BLOG/uploads 存在
        for (const sub of ['', 'posts', 'uploads']) {
            try { await client.mkdir(remotePath(sub), true); } catch (e) { /* 已存在则忽略 */ }
        }
        sftpClient = client;
        const drop = () => { if (sftpClient === client) sftpClient = null; };
        client.on('close', drop);
        client.on('end', drop);
        return client;
    })();
    try {
        return await sftpConnecting;
    } finally {
        sftpConnecting = null;
    }
}

function isNotFound(err) {
    const msg = String((err && err.message) || '');
    return /no such file|not exist|enoent|eof|failure/i.test(msg);
}

async function readRemote(relPath) {
    const client = await getSftp();
    try {
        const buf = await client.get(remotePath(relPath));
        return buf.toString('utf8');
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

async function writeRemote(relPath, content) {
    const client = await getSftp();
    await client.put(Buffer.from(content, 'utf8'), remotePath(relPath));
}

async function deleteRemote(relPath) {
    const client = await getSftp();
    try {
        await client.delete(remotePath(relPath));
    } catch (err) {
        if (!isNotFound(err)) throw err;
    }
}

async function listRemote(relPath) {
    const client = await getSftp();
    const list = await client.list(remotePath(relPath));
    return list.filter(i => i.type === '-').map(i => i.name);
}

// ============================================================
//  内存缓存
// ============================================================
const cache = {
    index: null, indexTime: 0,
    users: null, usersTime: 0,
    config: null, configTime: 0,
    posts: {}
};

function isCacheValid(type) {
    const now = Date.now();
    if (type === 'index') return cache.index && (now - cache.indexTime) < CONFIG.CACHE_TTL * 1000;
    if (type === 'users') return cache.users && (now - cache.usersTime) < CONFIG.CACHE_TTL * 1000;
    if (type === 'config') return cache.config && (now - cache.configTime) < CONFIG.CACHE_TTL * 1000;
    return false;
}

function getPostCache(postId) {
    const entry = cache.posts[postId];
    if (entry && (Date.now() - entry.time) < CONFIG.CACHE_TTL * 1000) return entry.data;
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
    const content = await readRemote(INDEX_PATH);
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

async function saveIndex(index) {
    await writeRemote(INDEX_PATH, JSON.stringify(index, null, 2));
    cache.index = index;
    cache.indexTime = Date.now();
}

// ---------- 用户 ----------
async function getUsers() {
    if (isCacheValid('users')) return cache.users;
    const content = await readRemote(USERS_PATH);
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

async function saveUsers(usersData) {
    await writeRemote(USERS_PATH, JSON.stringify(usersData, null, 2));
    cache.users = usersData;
    cache.usersTime = Date.now();
}

// ---------- 配置 ----------
async function getConfig() {
    if (isCacheValid('config')) return cache.config;
    const content = await readRemote(CONFIG_PATH);
    if (!content) {
        return { blogTitle: '我的博客', themeColor: '#1A73E8', wallpaper: '' };
    }
    try {
        const parsed = JSON.parse(content);
        if (!parsed.blogTitle) parsed.blogTitle = '我的博客';
        if (!parsed.themeColor) parsed.themeColor = '#1A73E8';
        if (!parsed.wallpaper) parsed.wallpaper = '';
        cache.config = parsed;
        cache.configTime = Date.now();
        return parsed;
    } catch {
        return { blogTitle: '我的博客', themeColor: '#1A73E8', wallpaper: '' };
    }
}

async function saveConfig(config) {
    await writeRemote(CONFIG_PATH, JSON.stringify(config, null, 2));
    cache.config = config;
    cache.configTime = Date.now();
}

// ---------- 文章文件 ----------
async function getPostContent(postId) {
    const cached = getPostCache(postId);
    if (cached) return cached;
    const content = await readRemote(`${POSTS_DIR}/${postId}.json`);
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (!parsed.comments) parsed.comments = [];
    setPostCache(postId, parsed);
    return parsed;
}

async function savePostContent(postId, postData) {
    await writeRemote(`${POSTS_DIR}/${postId}.json`, JSON.stringify(postData, null, 2));
    setPostCache(postId, postData);
}

async function deletePostFile(postId) {
    await deleteRemote(`${POSTS_DIR}/${postId}.json`);
    clearPostCache(postId);
}

// ---------- 初始化 ----------
async function initStorage(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            let index = await getIndex();
            if (!index.posts) {
                index = { posts: [] };
                await saveIndex(index);
            }
            const usersData = await getUsers();
            if (!usersData.users) usersData.users = [];
            const superExists = usersData.users.find(u => u.username === CONFIG.SUPER_ADMIN.username);
            if (!superExists) {
                usersData.users.push({
                    username: CONFIG.SUPER_ADMIN.username,
                    password: CONFIG.SUPER_ADMIN.password,
                    role: 'super_admin',
                    displayName: CONFIG.SUPER_ADMIN.username
                });
                await saveUsers(usersData);
            }
            const config = await getConfig();
            await saveConfig(config);
            console.log(`✅ 树莓派存储初始化完成（${CONFIG.SSH_HOST}:${CONFIG.SSH_PORT} → ${CONFIG.SSH_BASE_DIR}）`);
            return;
        } catch (err) {
            console.error(`❌ 初始化尝试 ${i + 1}/${retries} 失败:`, err.message);
            if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
        }
    }
}

setTimeout(() => {
    initStorage().catch(console.error);
}, 2000);

// ============================================================
//  中间件
// ============================================================
app.use(bodyParser.json({ limit: '10mb' }));

// 会话（Cookie 持久化）
app.set('trust proxy', 1);
app.use(session({
    secret: 'myblog-pi-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/upload', isAdmin, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '未上传文件' });
        const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
        const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext;
        const client = await getSftp();
        await client.put(req.file.buffer, remotePath('uploads/' + name));
        res.json({ success: true, url: '/uploads/' + name });
    } catch (err) {
        console.error('上传错误:', err.message);
        res.status(500).json({ error: '上传失败: ' + err.message });
    }
});

// 图片访问（通过 SFTP 读取返回）
app.get('/uploads/:name', async (req, res) => {
    try {
        const name = path.basename(req.params.name);
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).json({ error: '非法文件名' });
        const client = await getSftp();
        const buf = await client.get(remotePath('uploads/' + name));
        const ext = path.extname(name).toLowerCase();
        const mime = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon', '.avif': 'image/avif'
        }[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (err) {
        if (isNotFound(err)) return res.status(404).json({ error: '图片不存在' });
        console.error('读取图片错误:', err.message);
        res.status(500).json({ error: '读取图片失败' });
    }
});

// ============================================================
//  辅助函数
// ============================================================
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

// ============================================================
//  API 路由
// ============================================================

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: 'ssh', host: CONFIG.SSH_HOST, port: CONFIG.SSH_PORT, base: CONFIG.SSH_BASE_DIR });
});

// ---------- 认证 ----------
app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/status', async (req, res) => {
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
app.get('/api/config', async (req, res) => {
    try {
        const config = await getConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: '获取配置失败' });
    }
});

app.put('/api/config', isSuperAdmin, async (req, res) => {
    try {
        const { blogTitle, themeColor, wallpaper } = req.body;
        const config = await getConfig();
        if (blogTitle !== undefined) config.blogTitle = blogTitle.trim() || '我的博客';
        if (themeColor !== undefined) config.themeColor = themeColor;
        if (wallpaper !== undefined) config.wallpaper = wallpaper;
        await saveConfig(config);
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: '更新配置失败' });
    }
});

// ---------- 启动引导 ----------
app.get('/api/bootstrap', async (req, res) => {
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
app.get('/api/users', isSuperAdmin, async (req, res) => {
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

app.post('/api/users', isSuperAdmin, async (req, res) => {
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
        await saveUsers(usersData);
        res.json({ success: true, user: { username, role: 'admin', displayName: username } });
    } catch (err) {
        res.status(500).json({ error: '创建用户失败' });
    }
});

app.delete('/api/users/:username', isSuperAdmin, async (req, res) => {
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
        await saveUsers(usersData);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ---------- 显示名 ----------
app.put('/api/users/:username/displayname', async (req, res) => {
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
        await saveUsers(usersData);
        res.json({ success: true, displayName: targetUser.displayName });
    } catch (err) {
        res.status(500).json({ error: '修改显示名失败' });
    }
});

// ---------- 头像 ----------
app.put('/api/users/:username/avatar', async (req, res) => {
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
        await saveUsers(usersData);
        res.json({ success: true, avatar: targetUser.avatar });
    } catch (err) {
        console.error('修改头像错误:', err);
        res.status(500).json({ error: '修改头像失败' });
    }
});

// ---------- 密码 ----------
app.put('/api/users/:username/password', async (req, res) => {
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
        await saveUsers(usersData);
        res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
        res.status(500).json({ error: '修改密码失败' });
    }
});

// ---------- 文章 ----------
app.get('/api/posts', async (req, res) => {
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

app.get('/api/posts/:id', async (req, res) => {
    try {
        const post = await getPostContent(req.params.id);
        if (!post) return res.status(404).json({ error: '文章不存在' });
        const usersData = await getUsers();
        const user = usersData.users.find(u => u.username === post.author);
        post.authorDisplay = user ? (user.displayName || user.username) : (post.author || '未知');
        post.authorAvatar = user ? (user.avatar || '') : '';
        post.views = (post.views || 0) + 1;
        // 阅读数异步落库：不阻塞文章打开
        savePostContent(req.params.id, post).catch(e => console.error('更新阅读数失败:', e.message));
        res.json({ post });
    } catch (err) {
        console.error('获取文章详情错误:', err.message);
        res.status(500).json({ error: '获取文章失败: ' + err.message });
    }
});

app.post('/api/posts', isAdmin, async (req, res) => {
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
        await savePostContent(id, newPost);
        index.posts.push({
            id, title,
            author: req.user.username,
            createdAt: newPost.createdAt,
            cover: newPost.cover,
        });
        await saveIndex(index);
        const usersData = await getUsers();
        const user = usersData.users.find(u => u.username === req.user.username);
        newPost.authorDisplay = user ? (user.displayName || user.username) : req.user.username;
        newPost.authorAvatar = user ? (user.avatar || '') : '';

        const fullUrl = `${req.protocol}://${req.get('host')}/p/${id}`;
        res.json({ post: newPost, url: fullUrl });
    } catch (err) {
        console.error('发布文章错误:', err);
        res.status(500).json({ error: '发布失败' });
    }
});

app.delete('/api/posts/:id', isAdmin, async (req, res) => {
    try {
        const index = await getIndex();
        const idx = index.posts.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: '文章不存在' });
        const postMeta = index.posts[idx];
        if (req.user.role !== 'super_admin' && postMeta.author !== req.user.username) {
            return res.status(403).json({ error: '只能删除自己的文章' });
        }
        index.posts.splice(idx, 1);
        await saveIndex(index);
        await deletePostFile(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

app.delete('/api/posts', isSuperAdmin, async (req, res) => {
    try {
        await saveIndex({ posts: [] });
        try {
            const files = await listRemote(POSTS_DIR);
            for (const name of files) {
                if (name.endsWith('.json')) {
                    await deleteRemote(`${POSTS_DIR}/${name}`);
                }
            }
        } catch (e) {}
        res.json({ success: true, message: '所有文章已清空' });
    } catch (err) {
        res.status(500).json({ error: '清空文章失败' });
    }
});

// ---------- 评论 ----------
app.post('/api/posts/:id/comments', async (req, res) => {
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
            const usersData = await getUsers();
            const user = usersData.users.find(u => u.username === req.session.username);
            comment.author = req.session.username;
            comment.authorDisplay = user ? (user.displayName || user.username) : req.session.username;
            comment.isGuest = false;
        } else {
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
        await savePostContent(postId, post);
        res.json({ success: true, comment });
    } catch (err) {
        console.error('添加评论错误:', err);
        res.status(500).json({ error: '添加评论失败' });
    }
});

app.delete('/api/posts/:postId/comments/:commentId', isAdmin, async (req, res) => {
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
        await savePostContent(postId, post);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除评论失败' });
    }
});

// ---------- 文章页 ----------
app.get('/p/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 启动 ----------
app.listen(PORT, () => {
    console.log(`博客服务已启动: http://localhost:${PORT}`);
    console.log(`数据存储: SSH(${CONFIG.SSH_HOST}:${CONFIG.SSH_PORT}) → ${CONFIG.SSH_BASE_DIR}`);
});
