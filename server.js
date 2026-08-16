const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  ★★★ 用户配置区（修改这里即可） ★★★
// ============================================================

const CONFIG = {
    // ---------- GitHub 数据仓库（存放文章和用户数据） ----------
    DATA_REPO: process.env.REPO_NAME || 'leneve2025-pixel/Myblogdatal',

    // ---------- GitHub 访问令牌 ----------
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',

    // ---------- 超级管理员账号 ----------
    SUPER_ADMIN: {
        username: 'xiaohai',
        password: '114514'
    }
};

// ============================================================
//  以下代码无需修改
// ============================================================

const { DATA_REPO, GITHUB_TOKEN, SUPER_ADMIN } = CONFIG;
if (!GITHUB_TOKEN || !DATA_REPO) {
    console.error('❌ 缺少 GITHUB_TOKEN 或 DATA_REPO');
    process.exit(1);
}
const [OWNER, REPO] = DATA_REPO.split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const INDEX_PATH = 'index.json';
const POSTS_DIR = 'posts';
const USERS_PATH = 'users.json';
const CONFIG_PATH = 'config.json';   // 新增：存储博客标题等配置

// ---------- 辅助函数 ----------
function generateId(title, content) {
    return crypto.createHash('md5').update(title + content).digest('hex').slice(0, 8);
}

async function getFileContent(path) {
    try {
        const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
        return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

async function saveFileContent(path, content, message, sha = null) {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const params = { owner: OWNER, repo: REPO, path, message, content: encoded };
    if (sha) params.sha = sha;
    await octokit.repos.createOrUpdateFileContents(params);
}

async function deleteFile(path, sha, message) {
    await octokit.repos.deleteFile({ owner: OWNER, repo: REPO, path, message, sha });
}

// ---------- 索引操作 ----------
async function getIndex() {
    const content = await getFileContent(INDEX_PATH);
    if (!content) return { posts: [] };
    try {
        const parsed = JSON.parse(content);
        if (!parsed.posts) parsed.posts = [];
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

// ---------- 用户操作 ----------
async function getUsers() {
    const content = await getFileContent(USERS_PATH);
    if (!content) return { users: [] };
    try {
        const parsed = JSON.parse(content);
        if (!parsed.users) parsed.users = [];
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

// ---------- 文章文件操作 ----------
async function getPostContent(postId) {
    const content = await getFileContent(`${POSTS_DIR}/${postId}.json`);
    if (!content) return null;
    return JSON.parse(content);
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
}

async function deletePostFile(postId) {
    const path = `${POSTS_DIR}/${postId}.json`;
    const content = await getFileContent(path);
    if (!content) return;
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    await deleteFile(path, data.sha, `删除文章 ${postId}`);
}

// ---------- 配置操作（博客标题等） ----------
async function getConfig() {
    const content = await getFileContent(CONFIG_PATH);
    if (!content) return { blogTitle: '我的博客' };
    try {
        return JSON.parse(content);
    } catch {
        return { blogTitle: '我的博客' };
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

// ---------- 初始化仓库 ----------
async function initRepo() {
    try {
        // 初始化索引
        let index = await getIndex();
        if (!index.posts) {
            index = { posts: [] };
            await saveIndex(index, '重建空索引');
            console.log('✅ 已重建空索引');
        }
        // 初始化用户
        const usersData = await getUsers();
        if (!usersData.users) usersData.users = [];
        const superExists = usersData.users.find(u => u.username === SUPER_ADMIN.username);
        if (!superExists) {
            usersData.users.push({
                username: SUPER_ADMIN.username,
                password: SUPER_ADMIN.password,
                role: 'super_admin',
            });
            await saveUsers(usersData, '添加超级管理员');
        }
        // 初始化配置
        const config = await getConfig();
        if (!config.blogTitle) {
            config.blogTitle = '我的博客';
            await saveConfig(config, '初始化博客标题');
        }
        console.log('✅ GitHub 仓库初始化完成');
    } catch (err) {
        console.error('❌ 初始化失败:', err.message);
    }
}
initRepo();

// ---------- 中间件 ----------
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
    secret: 'myblog-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ---------- 用户辅助 ----------
async function findUserByUsername(username) {
    const usersData = await getUsers();
    return usersData.users.find(u => u.username === username);
}

// ---------- 权限中间件 ----------
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

// ---------- API 路由 ----------
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await findUserByUsername(username);
        if (!user || user.password !== password) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        req.session.username = username;
        res.json({ success: true, user: { username: user.username, role: user.role } });
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
        res.json({ isAdmin: true, user: { username: user.username, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// ---------- 配置 API ----------
app.get('/api/config', async (req, res) => {
    try {
        const config = await getConfig();
        res.json({ blogTitle: config.blogTitle || '我的博客' });
    } catch (err) {
        res.status(500).json({ error: '获取配置失败' });
    }
});

app.put('/api/config', isSuperAdmin, async (req, res) => {
    try {
        const { blogTitle } = req.body;
        if (!blogTitle || blogTitle.trim() === '') {
            return res.status(400).json({ error: '标题不能为空' });
        }
        const config = await getConfig();
        config.blogTitle = blogTitle.trim();
        await saveConfig(config, `修改博客标题为 "${blogTitle.trim()}"`);
        res.json({ success: true, blogTitle: config.blogTitle });
    } catch (err) {
        res.status(500).json({ error: '修改标题失败' });
    }
});

// ---------- 用户管理 ----------
app.get('/api/users', isSuperAdmin, async (req, res) => {
    try {
        const usersData = await getUsers();
        const safeUsers = usersData.users.map(u => ({ username: u.username, role: u.role }));
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
        usersData.users.push({ username, password, role: 'admin' });
        await saveUsers(usersData, `添加管理员 ${username}`);
        res.json({ success: true, user: { username, role: 'admin' } });
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
        await saveUsers(usersData, `删除管理员 ${target}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ---------- 修改密码 ----------
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
        await saveUsers(usersData, `修改密码 ${targetUsername}`);
        res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
        res.status(500).json({ error: '修改密码失败' });
    }
});

// ---------- 文章管理 ----------
app.get('/api/posts', async (req, res) => {
    try {
        const index = await getIndex();
        res.json({ posts: index.posts });
    } catch (err) {
        res.status(500).json({ error: '获取文章列表失败' });
    }
});

app.get('/api/posts/:id', async (req, res) => {
    try {
        const post = await getPostContent(req.params.id);
        if (!post) return res.status(404).json({ error: '文章不存在' });
        post.views = (post.views || 0) + 1;
        await savePostContent(req.params.id, post, '更新阅读数');
        res.json({ post });
    } catch (err) {
        res.status(500).json({ error: '获取文章失败' });
    }
});

app.post('/api/posts', isAdmin, async (req, res) => {
    try {
        const { title, content } = req.body;
        if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
        const id = generateId(title, content);
        const index = await getIndex();
        if (index.posts.find(p => p.id === id)) {
            return res.status(400).json({ error: '文章已存在' });
        }
        const newPost = {
            id, title, content,
            createdAt: Date.now(),
            views: 0,
            author: req.user.username,
        };
        await savePostContent(id, newPost, `创建文章 ${title}`);
        index.posts.push({
            id, title,
            author: req.user.username,
            createdAt: newPost.createdAt,
        });
        await saveIndex(index, `添加文章 ${title}`);
        res.json({ post: newPost });
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
        await saveIndex(index, `删除文章 ${req.params.id}`);
        await deletePostFile(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ========== 新增：清空所有文章（仅超级管理员） ==========
app.delete('/api/posts', isSuperAdmin, async (req, res) => {
    try {
        // 1. 清空索引
        await saveIndex({ posts: [] }, '清空所有文章');
        // 2. 删除所有文章文件（通过列出 posts 目录下的文件然后逐个删除，但 GitHub API 无批量删除，需先获取所有文件列表）
        // 简单做法：直接尝试删除 posts 目录（但目录本身不能删除，只能删除内部文件）
        // 更可靠：获取 posts 目录内容，逐个删除文件
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
        } catch (e) {
            // 如果 posts 目录不存在或为空，忽略错误
            console.warn('清空文章文件时忽略:', e.message);
        }
        res.json({ success: true, message: '所有文章已清空' });
    } catch (err) {
        console.error('清空文章失败:', err);
        res.status(500).json({ error: '清空文章失败' });
    }
});

// ---------- 启动 ----------
app.listen(PORT, () => {
    console.log(`博客服务已启动: http://localhost:${PORT}`);
});