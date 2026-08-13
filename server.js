const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 管理员账号 ----------
const ADMIN_USER = 'xiaohai';
const ADMIN_PASS = '114514';

// ---------- MongoDB 连接 ----------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/blog';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.error('MongoDB 连接失败:', err));

// ---------- 文章模型 ----------
const postSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    title: String,
    content: String,
    createdAt: Number,
    views: { type: Number, default: 0 },
});
const Post = mongoose.model('Post', postSchema);

// ---------- 中间件 ----------
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
    secret: 'myblog-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ---------- 辅助函数 ----------
function generateId(title, content) {
    return crypto.createHash('md5').update(title + content).digest('hex').slice(0, 8);
}

// ---------- API ----------
app.get('/api/posts', async (req, res) => {
    try {
        const posts = await Post.find().lean();
        res.json({ posts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/posts/:id', async (req, res) => {
    try {
        const post = await Post.findOne({ id: req.params.id });
        if (!post) return res.status(404).json({ error: '文章不存在' });
        post.views = (post.views || 0) + 1;
        await post.save();
        res.json({ post: post.toObject() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });

    const newId = generateId(title, content);
    const existing = await Post.findOne({ id: newId });
    if (existing) return res.status(400).json({ error: '文章已存在（标题和内容完全相同）' });

    const newPost = new Post({
        id: newId,
        title,
        content,
        createdAt: Date.now(),
        views: 0,
    });
    await newPost.save();
    res.json({ post: newPost.toObject() });
});

app.delete('/api/posts/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    const result = await Post.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: '文章不存在' });
    res.json({ success: true });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: '用户名或密码错误' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
    res.json({ isAdmin: !!req.session.isAdmin });
});

app.listen(PORT, () => {
    console.log(`博客服务已启动: http://localhost:${PORT}`);
});