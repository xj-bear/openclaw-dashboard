#!/usr/bin/env node
const cp = require('child_process');
const path = require('path');

// 指向真正启动服务器的 server.js 绝对路径
const serverPath = path.join(__dirname, '..', 'server.js');

console.log("🚀 正在启动 OpenClaw Hub 后台服务...");

// 统一注入环境变量，确保控制面板及其子进程识别正确的家目录
const env = { 
    ...process.env, 
    OPENCLAW_HOME: path.join(require('os').homedir(), '.openclaw'),
    OPENCLAW_STATE_DIR: path.join(require('os').homedir(), '.openclaw')
};

// 使用 process.execPath 获取当前这行代码赖以运行的精确 Node.js 二进制路径
// spawn 派生子进程，detached: true 保证终端关闭后不退出
const child = cp.spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: env
});

// 解绑父子进程关系，让父进程（当前脚本）可以安心退出
child.unref();

console.log("✅ Dashboard 已在后台安全运行！");
console.log("🔗 请访问: http://localhost:19010");
process.exit(0);
