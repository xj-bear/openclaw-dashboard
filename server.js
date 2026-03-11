// /home/jason/.openclaw/dashboard/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

// 统一的配置文件路径
const HOME_DIR = os.homedir() || process.env.HOME || process.env.USERPROFILE || '/root';
const CONFIG_PATH = path.join(HOME_DIR, '.openclaw', 'openclaw.json');
const DASHBOARD_DIR = __dirname;
const PORT = 19010;

// 辅助方法：读取并解析 openclaw.json
function getOpenClawConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.error("Failed to read config:", e);
        return null;
    }
}

// 辅助方法：保存 config
function saveOpenClawConfig(configObj) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configObj, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error("Failed to save config:", e);
        return false;
    }
}

// 供面板直接调用的 REST API
const apiHandlers = {
    // 获取基础系统监控数据
    '/api/sys-metrics': (req, res) => {
        if (os.platform() === 'win32') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ raw_metrics: 'Windows metrics not rawly supported.\nBasic stats are visible on the dashboard UI.' }));
        }
        exec('df -h /home && free -m && top -bn1 | grep "Cpu(s)"', (err, stdout) => {
            if (err) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: err.message }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ raw_metrics: stdout }));
        });
    },

    // 获取代理列表与状态
    '/api/agents': (req, res) => {
        const config = getOpenClawConfig();
        let agents = [];
        if (config && config.agents && config.agents.list) {
            agents = JSON.parse(JSON.stringify(config.agents.list));
        } else {
            // Fallback for modern OpenClaw/Windows default workspace
            agents = [{ id: 'main', name: 'Main Assistant', model: config?.agents?.defaults?.model?.primary || 'default' }];
        }

        agents.forEach(agent => {
            agent.status = 'idle';
            agent.current_session = null;
            agent.session_age_ms = 0;
            agent.last_activity = null;
            agent.token_usage = 0;
            agent.latest_action = null;
            agent.live_model = agent.model; // fallback

            try {
                let agentDir = agent.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agent.id, 'agent');
                let sessionDir = path.join(agentDir.endsWith(path.sep + 'agent') ? path.dirname(agentDir) : agentDir, 'sessions');
                
                if (!fs.existsSync(sessionDir)) {
                    sessionDir = path.join(HOME_DIR, '.openclaw', `workspace-${agent.id}`, 'agent', 'sessions');
                }
                if (!fs.existsSync(sessionDir)) {
                    sessionDir = path.join(agentDir, 'sessions');
                }
                // Windows default fallback
                if (!fs.existsSync(sessionDir) && agent.id === 'main') {
                    sessionDir = path.join(HOME_DIR, '.openclaw', 'workspace', 'sessions');
                }
                
                if (!fs.existsSync(sessionDir)) return;

                const allFiles = fs.readdirSync(sessionDir);
                const lockFiles = allFiles.filter(f => f.endsWith('.lock'));
                let isWorking = false;
                if (lockFiles.length > 0) {
                    isWorking = true;
                    agent.current_session = lockFiles[0].replace('.jsonl.lock', '');
                } else {
                    const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl'));
                    const now = Date.now();
                    for (const f of jsonlFiles) {
                        try {
                            const stat = fs.statSync(path.join(sessionDir, f));
                            if (now - stat.mtimeMs < 120000) {
                                isWorking = true;
                                break;
                            }
                        } catch (e) { }
                    }
                }

                if (isWorking) agent.status = 'working';

                const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));
                if (jsonlFiles.length === 0) return;

                const sorted = jsonlFiles.sort((a, b) => {
                    return fs.statSync(path.join(sessionDir, b)).mtimeMs - fs.statSync(path.join(sessionDir, a)).mtimeMs;
                });

                const latestFile = sorted[0];
                const latestPath = path.join(sessionDir, latestFile);
                const latestStat = fs.statSync(latestPath);

                agent.last_activity = new Date(latestStat.mtimeMs).toISOString();
                agent.session_age_ms = Date.now() - latestStat.birthtimeMs;

                if (!agent.current_session) agent.current_session = latestFile.replace('.jsonl', '');

                const content = fs.readFileSync(latestPath, 'utf-8');
                const lines = content.trim().split('\n').filter(l => l.trim());
                let totalTokens = 0;
                let latestAction = null;
                let liveModel = null;

                lines.forEach(line => {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.type === 'model_change' && entry.modelId) {
                            liveModel = `${entry.provider}/${entry.modelId}`;
                        }
                        if (entry.type === 'message' && entry.message) {
                            const msg = entry.message;
                            if (msg.usage && msg.usage.totalTokens) totalTokens += msg.usage.totalTokens;
                            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                                msg.content.forEach(c => {
                                    if (c.type === 'toolCall') latestAction = `工具呼叫: ${c.name}`;
                                    else if (c.type === 'text' && c.text) {
                                        latestAction = `回复: ${c.text.slice(0, 40).replace(/\n/g, ' ')}`;
                                    }
                                });
                            }
                            if (msg.role === 'toolResult') latestAction = `工具完成: ${msg.toolName || '?'}`;
                        }
                    } catch (e) { }
                });

                if (liveModel) agent.live_model = liveModel;
                agent.token_usage = totalTokens;
                agent.latest_action = latestAction;
            } catch (e) { }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agents));
    },

    // 获取系统健康指标
    '/api/sys-health': (req, res) => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);
        const memStr = `${(usedMem / 1e9).toFixed(1)} GB / ${(totalMem / 1e9).toFixed(1)} GB`;

        let activeAgents = 0;
        let totalAgents = 1;

        const checkDirActive = (dir) => {
            if (!dir || !fs.existsSync(dir)) return 0;
            const files = fs.readdirSync(dir);
            if (files.some(f => f.endsWith('.lock'))) return 1;
            const now = Date.now();
            return files.filter(f => f.endsWith('.jsonl')).some(f => {
                try { return (now - fs.statSync(path.join(dir, f)).mtimeMs < 120000); } catch(e) { return false; }
            }) ? 1 : 0;
        };

        try {
            const config = getOpenClawConfig();
            if (config?.agents?.list) {
                totalAgents = config.agents.list.length;
                config.agents.list.forEach(agt => {
                    let agentDir = agt.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agt.id, 'agent');
                    if (agentDir.endsWith(path.sep + 'agent')) agentDir = path.dirname(agentDir);
                    activeAgents += checkDirActive(path.join(agentDir, 'sessions'));
                });
            } else {
                activeAgents = checkDirActive(path.join(HOME_DIR, '.openclaw', 'workspace', 'sessions'));
                totalAgents = 1;
            }
        } catch (e) { }

        let gatewayPort = 18789;
        try {
            const config = getOpenClawConfig();
            if (config?.gateway?.port) gatewayPort = config.gateway.port;
        } catch (e) { }

        const finishResponse = (diskPercent, diskStr, finalCpuPercent, uptime) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                port: gatewayPort,
                uptime: uptime,
                cpuPercent: finalCpuPercent,
                memPercent,
                memStr,
                diskPercent,
                diskStr,
                activeAgents,
                totalAgents
            }));
        };

        if (os.platform() === 'win32') {
            let winCpuPercent = 0;
            let winDiskPercent = 0;
            let winDiskStr = "0 GB / 0 GB";
            let uptime = 0;
            const psCmd = `powershell -Command "$p=(Get-CimInstance Win32_Processor).LoadPercentage; $v=Get-Volume -DriveLetter C; Write-Host $p; Write-Host $v.Size; Write-Host $v.SizeRemaining"`;
            exec(psCmd, (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
                    if (lines.length >= 3) {
                        winCpuPercent = parseInt(lines[0]) || 0;
                        const total = parseInt(lines[1]) || 0;
                        const free = parseInt(lines[2]) || 0;
                        if (total > 0) {
                            winDiskPercent = Math.round(((total - free) / total) * 100);
                            winDiskStr = `${((total - free) / 1e9).toFixed(1)} GB / ${(total / 1e9).toFixed(1)} GB`;
                        }
                    }
                }
                finishResponse(winDiskPercent, winDiskStr, winCpuPercent, uptime);
            });
        } else {
            exec('df -h / | tail -1', (err, stdout) => {
                let diskPercent = 0, diskStr = "0 GB / 0 GB";
                if (!err && stdout) {
                    const parts = stdout.trim().split(/\s+/);
                    if (parts.length >= 5) {
                        diskPercent = parseInt(parts[4].replace('%', '')) || 0;
                        diskStr = `${parts[2]} / ${parts[1]}`;
                    }
                }
                exec('ps -eo etimes,args | grep -E "[o]penclaw.*gateway" | head -n 1', (err2, stdout2) => {
                    let uptime = 0;
                    if (!err2 && stdout2 && stdout2.trim()) {
                        const match = parseInt(stdout2.trim().split(/\s+/)[0]);
                        if (!isNaN(match)) uptime = match;
                    }
                    finishResponse(diskPercent, diskStr, Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)), uptime);
                });
            });
        }
    },

    '/api/agent-logs': (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('id');
        const limit = parseInt(url.searchParams.get('limit') || '50');

        if (!agentId) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Missing agent id' }));
        }

        const config = getOpenClawConfig();
        const configAgent = config?.agents?.list?.find(a => a.id === agentId);
        let agentDir = configAgent?.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');
        let sessionDir = path.join(agentDir.endsWith(path.sep + 'agent') ? path.dirname(agentDir) : agentDir, 'sessions');
        
        if (!fs.existsSync(sessionDir)) {
            sessionDir = path.join(HOME_DIR, '.openclaw', `workspace-${agentId}`, 'agent', 'sessions');
        }
        if (!fs.existsSync(sessionDir) && agentId === 'main') {
            sessionDir = path.join(HOME_DIR, '.openclaw', 'workspace', 'sessions');
        }

        if (!fs.existsSync(sessionDir)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify([]));
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));
        if (files.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify([]));
        }

        const latestFile = files.sort((a, b) => fs.statSync(path.join(sessionDir, b)).mtimeMs - fs.statSync(path.join(sessionDir, a)).mtimeMs)[0];
        const content = fs.readFileSync(path.join(sessionDir, latestFile), 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim()).slice(-limit);
        
        const logs = lines.map(line => {
            try { return JSON.parse(line); } catch (e) { return { raw: line }; }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
    },

    '/api/config': (req, res) => {
        const config = getOpenClawConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
    },

    '/api/config/update': (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            return res.end();
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const newConfig = JSON.parse(body);
                if (saveOpenClawConfig(newConfig)) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to save' }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    },

    '/api/cmd/restart': (req, res) => {
        const platform = os.platform();
        if (platform === 'win32') {
            // Find and kill openclaw node processes
            const findCmd = 'wmic process where "commandline like \'%openclaw%\' and name like \'%node%\' and not commandline like \'%server.js%\'" get processid /format:list';
            exec(findCmd, (err, stdout) => {
                if (!err && stdout) {
                    const pids = stdout.match(/ProcessId=(\d+)/g);
                    if (pids) {
                        pids.forEach(p => {
                            const pid = p.split('=')[1];
                            try { process.kill(pid); } catch (e) {
                                try { exec(`taskkill /F /PID ${pid}`); } catch (e2) {}
                            }
                        });
                    }
                }
                // Spawn new
                setTimeout(() => {
                    const oc = exec('openclaw.cmd gateway start', { detached: true, stdio: 'ignore' });
                    oc.unref();
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: 'Windows restart triggered' }));
                }, 1000);
            });
        } else {
            exec('ps -ef | grep "[o]penclaw.*gateway" | awk \'{print $2}\'', (err, stdout) => {
                if (stdout.trim()) {
                    stdout.split('\n').forEach(pid => {
                        if (pid.trim()) try { process.kill(pid.trim(), 'SIGKILL'); } catch (e) {}
                    });
                }
                setTimeout(() => {
                    const oc = exec('openclaw gateway start', { detached: true, stdio: 'ignore' });
                    oc.unref();
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: 'Linux restart triggered' }));
                }, 500);
            });
        }
    }
};

// 静态文件服务
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (apiHandlers[pathname]) {
        return apiHandlers[pathname](req, res);
    }

    let filePath = path.join(DASHBOARD_DIR, pathname === '/' ? 'index.html' : pathname);
    
    // 安全性检查
    if (!filePath.startsWith(DASHBOARD_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const ext = path.extname(filePath);
    const contentType = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml'
    }[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(500);
                res.end('Internal Error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`OpenClaw Dashboard running at http://localhost:${PORT}`);
});
