// ============================================================
//  部署脚本：上传博客代码到树莓派 /BLOG 并重启服务
//  用法：node deploy.js
//  连接信息可用环境变量覆盖：
//    SSH_HOST / SSH_PORT / SSH_USER / SSH_PASSWORD / SSH_BASE_DIR
//  流程：创建 /BLOG → 安装 Node（如缺）→ 上传代码 → 装依赖 → 启动 → 验证
// ============================================================

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const CFG = {
    host: process.env.SSH_HOST || 'wh.frp.one',
    port: Number(process.env.SSH_PORT || 58373),
    username: process.env.SSH_USER || 'xiaohai',
    password: process.env.SSH_PASSWORD || '123',
    baseDir: process.env.SSH_BASE_DIR || '/BLOG'
};

const APP_DIR = CFG.baseDir + '/app';   // 代码目录：/BLOG/app
const FILES = ['server.js', 'package.json', 'deploy.js'];

function log(msg) { console.log(`[deploy] ${msg}`); }

function connect() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => resolve(conn));
        conn.on('error', reject);
        conn.connect({
            host: CFG.host,
            port: CFG.port,
            username: CFG.username,
            password: CFG.password,
            readyTimeout: 20000
        });
    });
}

function exec(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            let errOut = '';
            stream.on('close', (code) => resolve({ code, out: out.trim(), errOut: errOut.trim() }));
            stream.on('data', (d) => { out += d.toString(); });
            stream.stderr.on('data', (d) => { errOut += d.toString(); });
        });
    });
}

// sudo 命令（树莓派 sudo 需密码，用 SSH 密码提权）
async function sudoExec(conn, command) {
    const r = await exec(conn, `echo '${CFG.password}' | sudo -S -p '' ${command} 2>&1`);
    if (r.code !== 0) throw new Error(`sudo 失败(${r.code}): ${command} -> ${r.out || r.errOut}`);
    return r;
}

function sftpPut(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
    });
}

function sftpMkdir(sftp, dir) {
    return new Promise((resolve) => {
        sftp.mkdir(dir, (err) => resolve());
    });
}

async function main() {
    log(`连接 ${CFG.username}@${CFG.host}:${CFG.port} ...`);
    const conn = await connect();
    log('SSH 连接成功');

    try {
        // ---------- 1. 创建目录结构（/ 根目录需 sudo） ----------
        await sudoExec(conn, `mkdir -p ${CFG.baseDir} ${CFG.baseDir}/posts ${CFG.baseDir}/uploads ${APP_DIR} ${APP_DIR}/public`);
        await sudoExec(conn, `chown -R ${CFG.username}:${CFG.username} ${CFG.baseDir}`);
        log(`已创建 ${CFG.baseDir}（数据目录）与 ${APP_DIR}（代码目录）`);

        // ---------- 2. 检查/安装 Node ----------
        let nodeR = await exec(conn, `command -v node && node -v || echo NO_NODE`);
        if (nodeR.out === 'NO_NODE') {
            log('未检测到 Node，正在通过 apt 安装（可能需要几分钟）...');
            log('apt-get update ...');
            await sudoExec(conn, `apt-get update -y -q 2>&1 | tail -3`);
            log('安装 nodejs npm ...');
            await sudoExec(conn, `apt-get install -y -q nodejs npm 2>&1 | tail -5`);
            nodeR = await exec(conn, `command -v node && node -v && command -v npm && npm -v`);
            log(`安装完成: ${nodeR.out.replace(/\n/g, ' | ')}`);
        } else {
            const npmR = await exec(conn, `command -v npm && npm -v || echo NO_NPM`);
            log(`Node: ${nodeR.out} | npm: ${npmR.out}`);
        }

        // ---------- 3. 上传代码 ----------
        const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => e ? reject(e) : resolve(s)));
        for (const f of FILES) {
            const local = path.join(__dirname, f);
            const remote = APP_DIR + '/' + f;
            await sftpPut(sftp, local, remote);
            log(`上传 ${f} -> ${remote}`);
        }
        await sftpPut(sftp, path.join(__dirname, 'public/index.html'), APP_DIR + '/public/index.html');
        log('上传 public/index.html -> ' + APP_DIR + '/public/index.html');

        // ---------- 4. 安装依赖 ----------
        log('安装 npm 依赖（npmmirror 镜像，IPv4 优先避免树莓派 IPv6 路由问题）...');
        const npmResult = await exec(conn, `cd ${APP_DIR} && NODE_OPTIONS=--dns-result-order=ipv4first npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | tail -5`);
        if (npmResult.out) log('npm 输出: ' + npmResult.out);
        if (npmResult.errOut) log('npm stderr: ' + npmResult.errOut);
        if (npmResult.code !== 0) throw new Error('npm install 失败');

        // ---------- 5. 停止旧进程 ----------
        await exec(conn, `pkill -f "node server.js" 2>/dev/null || true`);
        await new Promise(r => setTimeout(r, 800));

        // ---------- 6. 启动服务（存储走本机 SSH 127.0.0.1:22） ----------
        const env = `SSH_HOST=127.0.0.1 SSH_PORT=22 SSH_USER=${CFG.username} SSH_PASSWORD='${CFG.password}' SSH_BASE_DIR=${CFG.baseDir} PORT=3000`;
        await exec(conn, `cd ${APP_DIR} && ${env} nohup node server.js > server.log 2>&1 &`);
        log('服务已启动（nohup，日志: ' + APP_DIR + '/server.log）');

        // ---------- 7. 验证 ----------
        await new Promise(r => setTimeout(r, 6000));
        const health = await exec(conn, `curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:3000/api/health || echo curl-failed`);
        log(`健康检查 HTTP: ${health.out}`);
        const cfg = await exec(conn, `curl -s --max-time 10 http://127.0.0.1:3000/api/config || echo curl-failed`);
        if (cfg.out.startsWith('{')) {
            log(`存储链路验证通过（/api/config 返回: ${cfg.out.slice(0, 120)}）`);
        } else {
            // 回退：改用 frp 公网地址连接
            log('本机 SSH 存储验证失败，回退到 frp 地址连接...');
            const env2 = `SSH_HOST=wh.frp.one SSH_PORT=58373 SSH_USER=${CFG.username} SSH_PASSWORD='${CFG.password}' SSH_BASE_DIR=${CFG.baseDir} PORT=3000`;
            await exec(conn, `pkill -f "node server.js" 2>/dev/null || true`);
            await new Promise(r => setTimeout(r, 800));
            await exec(conn, `cd ${APP_DIR} && ${env2} nohup node server.js > server.log 2>&1 &`);
            await new Promise(r => setTimeout(r, 6000));
            const cfg2 = await exec(conn, `curl -s --max-time 10 http://127.0.0.1:3000/api/config || echo curl-failed`);
            if (cfg2.out.startsWith('{')) {
                log(`回退成功（frp 存储，/api/config: ${cfg2.out.slice(0, 120)}）`);
            } else {
                log('两种连接方式均未通过存储验证，请查看 ' + APP_DIR + '/server.log');
                const logr = await exec(conn, `tail -20 ${APP_DIR}/server.log`);
                log('日志尾部: ' + (logr.out || '(空)'));
            }
        }

        const iface = await exec(conn, `hostname -I 2>/dev/null | awk '{print $1}'`);
        log(`树莓派内网 IP: ${iface.out || '(未知)'}，博客访问: http://${iface.out || '<ip>'}:3000`);
        log('部署流程完成');
    } finally {
        conn.end();
    }
}

main().catch((err) => {
    console.error('[deploy] 部署失败:', err.message);
    process.exit(1);
});
