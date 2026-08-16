const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  用户配置区（修改这里即可）
// ============================================================
const CONFIG = {
    DATA_REPO: process.env.REPO_NAME || 'leneve2025-pixel/Myblogdata',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    IMGBB_API_KEY: process.env.IMGBB_API_KEY || 'c236b3b6ca6d92c602ed045dcc21e7e1',
    SUPER_ADMIN: {
        username: 'xiaohai',
        password: '114514'
    }
};

// ============================================================
//  核心逻辑
// ============================================================
const { DATA_REPO, GITHUB_TOKEN, IMGBB_API_KEY, SUPER_ADMIN } = CONFIG;
if (!GITHUB_TOKEN || !DATA_REPO) {
    console.error('❌ 缺少 GITHUB_TOKEN 或 DATA_REPO');
    process.exit(1);
}
if (!IMGBB_API_KEY) {
    console.warn('⚠️ 缺少 IMGBB_API_KEY，图片上传将失败');
}

const [OWNER, REPO] = DATA_REPO.split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const INDEX_PATH = 'index.json';
const POSTS_DIR = 'posts';
const USERS_PATH = 'users.json';
const CONFIG_PATH = 'config.json';

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

// ---------- 索引 ----------
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

// ---------- 用户 ----------
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

// ---------- 配置 ----------
async function getConfig() {
    const content = await getFileContent(CONFIG_PATH);
    if (!content) {
        return { blogTitle: '我的博客', themeColor: '#4CAF50', wallpaper: '' };
    }
    try {
        const parsed = JSON.parse(content);
        if (!parsed.blogTitle) parsed.blogTitle = '我的博客';
        if (!parsed.themeColor) parsed.themeColor = '#4CAF50';
        if (!parsed.wallpaper) parsed.wallpaper = '';
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
    const content = await getFileContent(`${POSTS_DIR}/${postId}.json`);
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (!parsed.comments) parsed.comments = [];
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
}

async function deletePostFile(postId) {
    const path = `${POSTS_DIR}/${postId}.json`;
    const content = await getFileContent(path);
    if (!content) return;
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    await deleteFile(path, data.sha, `删除文章 ${postId}`);
}

// ---------- 初始化 ----------
async function initRepo() {
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
    } catch (err) {
        console.error('❌ 初始化失败:', err.message);
    }
}
initRepo();

// ---------- 中间件 ----------
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(session({
    secret: 'myblog-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

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
        if (!req.file) {
            return res.status(400).json({ error: '未上传文件' });
        }
        if (!IMGBB_API_KEY) {
            return res.status(500).json({ error: '服务器未配置图床密钥' });
        }
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
            console.error('ImgBB返回异常:', response.data);
            res.status(500).json({ error: '图床返回异常' });
        }
    } catch (err) {
        console.error('上传错误:', err.message);
        if (err.response) {
            console.error('ImgBB错误响应:', JSON.stringify(err.response.data));
        }
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
        await saveConfig(config, '更新配置');
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: '更新配置失败' });
    }
});

// ---------- 用户管理 ----------
app.get('/api/users', isSuperAdmin, async (req, res) => {
    try {
        const usersData = await getUsers();
        const safeUsers = usersData.users.map(u => ({
            username: u.username,
            role: u.role,
            displayName: u.displayName || u.username
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
            displayName: username
        });
        await saveUsers(usersData, `添加管理员 ${username}`);
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
        await saveUsers(usersData, `删除管理员 ${target}`);
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
        await saveUsers(usersData, `修改显示名 ${targetUsername}`);
        res.json({ success: true, displayName: targetUser.displayName });
    } catch (err) {
        res.status(500).json({ error: '修改显示名失败' });
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
        await saveUsers(usersData, `修改密码 ${targetUsername}`);
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
            userMap[u.username] = u.displayName || u.username;
        });
        const postsWithDisplay = index.posts.map(p => ({
            ...p,
            authorDisplay: userMap[p.author] || p.author || '未知'
        }));
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
        post.views = (post.views || 0) + 1;
        await savePostContent(req.params.id, post, '更新阅读数');
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

app.delete('/api/posts', isSuperAdmin, async (req, res) => {
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

// ---------- 评论 ----------
app.post('/api/posts/:id/comments', isAdmin, async (req, res) => {
    try {
        const postId = req.params.id;
        const { content } = req.body;
        if (!content || content.trim() === '') {
            return res.status(400).json({ error: '评论内容不能为空' });
        }
        const post = await getPostContent(postId);
        if (!post) return res.status(404).json({ error: '文章不存在' });

        const usersData = await getUsers();
        const user = usersData.users.find(u => u.username === req.user.username);
        const displayName = user ? (user.displayName || user.username) : req.user.username;

        const comment = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            author: req.user.username,
            authorDisplay: displayName,
            content: content.trim(),
            createdAt: Date.now()
        };
        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        await savePostContent(postId, post, `添加评论`);
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
        await savePostContent(postId, post, `删除评论`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除评论失败' });
    }
});

// ---------- 启动 ----------
app.listen(PORT, () => {
    console.log(`博客服务已启动: http://localhost:${PORT}`);
});