# MyBlog — 树莓派 SSH 存储版

个人博客，Express + 树莓派（SSH/SFTP）存储，自托管部署。

## 架构

- **后端**：Node.js / Express，`server.js`
- **存储**：通过 SSH/SFTP 直连树莓派，数据存放在 **`/BLOG`** 目录（根目录下）
  - `index.json` 文章索引 / `users.json` 用户 / `config.json` 站点配置
  - `posts/` 文章与评论 / `uploads/` 上传图片
- **前端**：单文件 `public/index.html`，MD3 深色主题（#0F0F0F 背景 / #E8EAED 文字 / #1A73E8 品牌蓝），毛玻璃卡片，零外部 CDN 依赖（内联 SVG 图标）

## 连接配置（server.js 顶部 / 环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SSH_HOST` | `wh.frp.one` | 树莓派 SSH 地址（frp 隧道） |
| `SSH_PORT` | `58373` | SSH 端口 |
| `SSH_USER` | `xiaohai` | SSH 用户名 |
| `SSH_PASSWORD` | `123` | SSH 密码 |
| `SSH_BASE_DIR` | `/BLOG` | 树莓派存储根目录 |
| `PORT` | `3000` | 服务监听端口 |

树莓派上运行时建议 `SSH_HOST=127.0.0.1 SSH_PORT=22`（本机 SSH 直连，绕过 frp 往返）。

## 本地开发

```bash
npm install
npm start        # http://localhost:3000
```

## 部署到树莓派

```bash
node deploy.js   # 或双击 上传.bat
```

`deploy.js` 自动完成：创建 `/BLOG` 目录 → 安装 Node（如缺失）→ 上传代码到 `/BLOG/app` → 安装依赖（npmmirror 镜像 + IPv4 优先）→ 启动服务 → 健康检查验证。

## 默认管理员

- 用户名：`xiaohai`
- 密码：`114514`（登录后请在后台修改）

## 注意事项

- 树莓派需允许密码登录 SSH（`PasswordAuthentication yes`）。
- 服务当前以 `nohup` 方式运行（`/BLOG/app/server.log`）；如需开机自启可加 systemd 服务。
- 博客默认监听 `3000` 端口，内网访问 `http://<树莓派IP>:3000`；如需公网访问可另加 frp http 代理。
