@echo off
rem 一键部署到树莓派（wh.frp.one:58373，数据目录 /BLOG）
rem 可用环境变量覆盖：SSH_HOST / SSH_PORT / SSH_USER / SSH_PASSWORD / SSH_BASE_DIR
cd /d %~dp0
node deploy.js
pause
