// /home/jason/.openclaw/dashboard/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const net = require('net');

// 统一的配置文件路径
const HOME_DIR = os.homedir() || process.env.HOME || process.env.USERPROFILE || '/root';
const CONFIG_PATH = path.join(HOME_DIR, '.openclaw', 'openclaw.json');
const PROVIDERS_PATH = path.join(HOME_DIR, '.openclaw', 'providers.json');
const DASHBOARD_DIR = __dirname;
const PORT = 19010;

// 辅助方法：读取并解析 providers.json
function getProvidersConfig() {
    try {
        if (fs.existsSync(PROVIDERS_PATH)) {
            const raw = fs.readFileSync(PROVIDERS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Object.keys(parsed).length > 0) return parsed;
        }
        
        // 回退逻辑：从 openclaw.json 中读取
        const openclawConfig = getOpenClawConfig();
        if (openclawConfig && openclawConfig.models && openclawConfig.models.providers) {
            console.log("Fallback: Loading providers from openclaw.json");
            return openclawConfig.models.providers;
        }
        
        return {};
    } catch (e) {
        console.error("Failed to read providers:", e);
        return {};
    }
}

// 辅助方法：保存 providers.json，并同步到 openclaw.json 以供网关使用
function saveProvidersConfig(providersObj) {
    try {
        // 1. 保存到隔离的 providers.json (主存储，防止 doctor 删掉)
        fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providersObj, null, 2), 'utf-8');

        // 2. 同步到 openclaw.json (运行时存储，供网关识别)
        const openclawConfig = getOpenClawConfig();
        if (openclawConfig) {
            // 根据用户提供的格式：应存放在根节点的 models.providers 下
            if (!openclawConfig.models) openclawConfig.models = {};
            openclawConfig.models.mode = "merge";
            openclawConfig.models.providers = JSON.parse(JSON.stringify(providersObj));

            // 保存回 openclaw.json
            saveOpenClawConfig(openclawConfig);
        }
        return true;
    } catch (e) {
        console.error("Failed to save providers:", e);
        return false;
    }
}

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
        const existing = getOpenClawConfig() || {};
        
        // 深度合并逻辑，确保不丢失 gateway, agents 等根节点
        const merged = { ...existing, ...configObj };
        
        // 针对 gateway 内部字段也进行一层合并，防止 accessToken/port 被抹除
        if (existing.gateway && configObj.gateway) {
            merged.gateway = { ...existing.gateway, ...configObj.gateway };
            // 处理 auth 嵌套对象
            if (existing.gateway.auth && configObj.gateway.auth) {
                merged.gateway.auth = { ...existing.gateway.auth, ...configObj.gateway.auth };
            }
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
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
                        if (entry.type === 'message') {
                            const msgObj = entry.message || (entry.role ? entry : null);
                            if (msgObj) {
                                let text = '';
                                if (typeof msgObj.content === 'string') {
                                    text = msgObj.content;
                                } else if (Array.isArray(msgObj.content)) {
                                    msgObj.content.forEach(c => {
                                        if (c.type === 'text' && c.text) text += c.text + ' ';
                                        else if (c.type === 'toolCall') text += `[工具呼叫: ${c.name}] `;
                                    });
                                }
                                if (text.trim()) {
                                    latestAction = text.trim();
                                }
                            }
                        }
                        if (entry.type === 'toolResult') {
                            latestAction = `[工具完成: ${entry.toolName || '?'}]`;
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

    // 获取指定 Agent 的最新会话日志
    '/api/agent-logs': (req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const agentId = urlObj.searchParams.get('id') || 'main';
        const limit = parseInt(urlObj.searchParams.get('limit') || '12', 10);

        try {
            const config = getOpenClawConfig();
            let agentCfg = null;
            if (config?.agents?.list) {
                agentCfg = config.agents.list.find(a => a.id === agentId);
            }

            // 按优先级尝试多个 sessions 目录（跨平台兼容）
            let sessionDir = null;
            const candidates = [];
            if (agentCfg?.agentDir) {
                const base = agentCfg.agentDir.endsWith(path.sep + 'agent')
                    ? path.dirname(agentCfg.agentDir)
                    : agentCfg.agentDir;
                candidates.push(path.join(base, 'sessions'));
                candidates.push(path.join(agentCfg.agentDir, 'sessions'));
            }
            candidates.push(path.join(HOME_DIR, '.openclaw', `workspace-${agentId}`, 'agent', 'sessions'));
            candidates.push(path.join(HOME_DIR, '.openclaw', 'workspace', 'sessions'));
            
            for (const dir of candidates) {
                if (fs.existsSync(dir)) {
                    sessionDir = dir;
                    break;
                }
            }

            if (!sessionDir) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: [], alerts: [] }));
            }

            const allFiles = fs.readdirSync(sessionDir);
            const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));
            if (jsonlFiles.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: [], alerts: [] }));
            }

            const sorted = jsonlFiles.sort((a, b) => {
                return fs.statSync(path.join(sessionDir, b)).mtimeMs - fs.statSync(path.join(sessionDir, a)).mtimeMs;
            });

            const latestPath = path.join(sessionDir, sorted[0]);
            const content = fs.readFileSync(latestPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.trim()).slice(-limit);

            const logs = [];
            const alerts = [];

            // 检查是否有活跃的 .lock 文件表示正在工作
            if (fs.existsSync(latestPath + '.lock')) {
                // optional: add a virtual working log
            }

            lines.forEach(line => {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'message') {
                        const msgObj = entry.message || (entry.role ? entry : null);
                        if (msgObj) {
                            let text = '';
                            if (typeof msgObj.content === 'string') {
                                text = msgObj.content;
                            } else if (Array.isArray(msgObj.content)) {
                                msgObj.content.forEach(c => {
                                    if (c.type === 'text' && c.text) text += c.text;
                                    else if (c.type === 'toolCall') text += `[工具呼叫: ${c.name}] `;
                                });
                            }
                            if (text.trim()) {
                                logs.push({ level: msgObj.role === 'user' ? 'user' : 'assistant', text: text.trim(), time: new Date(entry.timestamp || Date.now()).toLocaleTimeString() });
                            }
                        }
                    } else if (entry.type === 'toolResult') {
                        logs.push({ level: 'tool', text: `[工具返回: ${entry.toolName}] ${typeof entry.result === 'string' ? entry.result.substring(0, 100) : 'Done'}`, time: new Date(entry.timestamp || Date.now()).toLocaleTimeString() });
                    }
                } catch (e) { }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs, alerts }));
        } catch (e) {
            console.error("Failed to read agent logs:", e);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
    },

    // 获取全局系统日志 (app.log)
    '/api/sys-logs': (req, res) => {
        const logPath = path.join(HOME_DIR, '.openclaw', 'app.log');
        try {
            if (!fs.existsSync(logPath)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.trim().split('\n').slice(-100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(lines));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
    },

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
        
        // 辅助检测端口连接性
        const checkPort = async (port) => {
            const hosts = ['127.0.0.1', '::1', 'localhost'];
            for (const host of hosts) {
                try {
                    const isConnected = await new Promise((resolve) => {
                        const socket = new net.Socket();
                        socket.setTimeout(500);
                        socket.once('connect', () => { socket.destroy(); resolve(true); });
                        socket.once('timeout', () => { socket.destroy(); resolve(false); });
                        socket.once('error', () => { socket.destroy(); resolve(false); });
                        // 捕获可能由于没有 IPv6 堆栈而同步抛出的错
                        try {
                            socket.connect(port, host);
                        } catch (e) {
                            resolve(false);
                        }
                    });
                    if (isConnected) return true;
                } catch (e) {
                    continue;
                }
            }
            return false;
        };

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
            
            // 获取 CPU, 磁盘负载
            const psMetricsCmd = `powershell -Command "$p=(Get-CimInstance Win32_Processor).LoadPercentage; $v=Get-Volume -DriveLetter C; Write-Host $p; Write-Host $v.Size; Write-Host $v.SizeRemaining"`;
            
            // 尝试获取 OpenClaw 进程的真实 Uptime
            const psUptimeCmd = `powershell -Command "$p=Get-Process -Name node | Where-Object { $_.CommandLine -like '*openclaw*' -and $_.CommandLine -like '*gateway*' } | Sort-Object StartTime -Descending | Select-Object -First 1; if($p){ [int]((Get-Date) - $p.StartTime).TotalSeconds } else { 0 }"`;

            exec(psMetricsCmd, (err, stdout) => {
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
                
                exec(psUptimeCmd, async (err2, stdout2) => {
                    if (!err2 && stdout2) uptime = parseInt(stdout2.trim()) || 0;
                    
                    const isPortActive = await checkPort(gatewayPort);
                    // 只有端口真正通了才认为网关是在线的 (Active)
                    const finalUptime = isPortActive ? uptime : 0;
                    const finalActivePort = isPortActive ? gatewayPort : null;

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        port: finalActivePort,
                        uptime: finalUptime,
                        cpuPercent: winCpuPercent,
                        memPercent,
                        memStr,
                        diskPercent: winDiskPercent,
                        diskStr: winDiskStr,
                        activeAgents,
                        totalAgents,
                        isAlive: isPortActive
                    }));
                });
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
                exec('ps -eo etimes,args | grep -E "[o]penclaw.*gateway" | head -n 1', async (err2, stdout2) => {
                    let uptime = 0;
                    if (!err2 && stdout2 && stdout2.trim()) {
                        const match = parseInt(stdout2.trim().split(/\s+/)[0]);
                        if (!isNaN(match)) uptime = match;
                    }
                    
                    const isPortActive = await checkPort(gatewayPort);
                    const finalUptime = isPortActive ? uptime : 0;
                    const finalActivePort = isPortActive ? gatewayPort : null;

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        port: finalActivePort,
                        uptime: finalUptime,
                        cpuPercent: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
                        memPercent,
                        memStr,
                        diskPercent,
                        diskStr,
                        activeAgents,
                        totalAgents,
                        isAlive: isPortActive
                    }));
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

    '/api/cmd/start': (req, res) => {
        const platform = os.platform();
        let cmd = '';
        if (platform === 'win32') {
            cmd = 'openclaw.cmd gateway run';
        } else {
            cmd = 'openclaw gateway run';
        }

        try {
            // 在 Windows 下使用 shell: true，并直接调用，确保能够找到命令
            const oc = exec(cmd, { 
                detached: true, 
                stdio: 'ignore',
                shell: platform === 'win32' ? 'powershell' : true
            });
            oc.unref();
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Command "${cmd}" triggered.` }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
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
    },

    // 获取供应商列表
    '/api/providers': (req, res) => {
        const providers = getProvidersConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(providers));
    },

    // 新增或更新供应商
    '/api/add-provider': (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { providerName, baseUrl, apiKey, apiType } = JSON.parse(body);
                if (!providerName) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'providerName is required' }));
                }
                const providers = getProvidersConfig();
                const existing = providers[providerName] || {};
                providers[providerName] = {
                    ...existing,
                    baseUrl: baseUrl || existing.baseUrl || '',
                    apiKey: apiKey || existing.apiKey || '',
                    api: apiType || existing.api || 'openai-completions',
                    models: existing.models || []
                };
                if (saveProvidersConfig(providers)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Provider "${providerName}" saved to providers.json.` }));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to save providers' }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
            }
        });
    },

    // 删除供应商
    '/api/delete-provider': (req, res) => {
        if (req.method !== 'DELETE') {
            res.writeHead(405);
            return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        const url = new URL(req.url, `http://${req.headers.host}`);
        const name = url.searchParams.get('name');
        if (!name) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'name is required' }));
        }
        const providers = getProvidersConfig();
        if (providers[name]) {
            delete providers[name];
            if (saveProvidersConfig(providers)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Provider "${name}" deleted from providers.json.` }));
            } else {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to save providers' }));
            }
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: `Provider "${name}" not found` }));
        }
    },

    // 探测供应商可用模型
    '/api/discover-models': (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const providerName = url.searchParams.get('provider');
        if (!providerName) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'provider is required' }));
        }
        const providers = getProvidersConfig();
        const provider = providers[providerName];

        const baseUrl = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const apiKey = provider.apiKey || '';
        const modelsUrl = `${baseUrl}/models`;

        // 使用 Node.js 内置 https/http 请求
        const isHttps = modelsUrl.startsWith('https');
        const httpModule = isHttps ? require('https') : require('http');
        const urlObj = new URL(modelsUrl);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        };

        const proxyReq = httpModule.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const rawModels = json.data || json.models || (Array.isArray(json) ? json : []);
                    const apiModels = rawModels.map(m => ({
                        id: typeof m === 'string' ? m : (m.id || m.name || ''),
                        name: typeof m === 'string' ? m : (m.id || m.name || ''),
                        api: provider.api || 'openai-completions'
                    })).filter(m => m.id);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ api_models: apiModels }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to parse remote response', raw: data.substring(0, 200) }));
                }
            });
        });

        proxyReq.on('error', (e) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        });
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            res.writeHead(504);
            res.end(JSON.stringify({ error: 'Request timeout' }));
        });
        proxyReq.end();
    },

    // 保存指定供应商的模型列表
    '/api/save-models': (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { providerName, models } = JSON.parse(body);
                if (!providerName) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'providerName is required' }));
                }
                const providers = getProvidersConfig();
                if (!providers[providerName]) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ error: `Provider "${providerName}" not found` }));
                }
                providers[providerName].models = models || [];
                if (saveProvidersConfig(providers)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Saved ${(models || []).length} models for "${providerName}" to providers.json.` }));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to save providers' }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
            }
        });
    },

    // 沙箱级别读取与修改
    '/api/sandbox': (req, res) => {
        const config = getOpenClawConfig() || {};
        if (req.method === 'GET') {
            const level = (config.gateway && config.gateway.sandboxLevel) || 'full';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ level }));
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { level } = JSON.parse(body);
                    if (!['full', 'allowlist', 'deny'].includes(level)) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Invalid level. Use: full, allowlist, deny' }));
                    }
                    if (!config.gateway) config.gateway = {};
                    config.gateway.sandboxLevel = level;
                    if (saveOpenClawConfig(config)) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, level }));
                    } else {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to save config' }));
                    }
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
                }
            });
            return;
        }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    },

    // 代理详情（SOUL.md 内容）
    '/api/agent-detail': (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('id');
        if (!agentId) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Missing agent id' }));
        }
        const config = getOpenClawConfig();
        const configAgent = config && config.agents && config.agents.list && config.agents.list.find(a => a.id === agentId);
        const agentDir = configAgent && configAgent.agentDir
            ? configAgent.agentDir
            : path.join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');

        const soulPaths = [
            path.join(agentDir, 'SOUL.md'),
            path.join(path.dirname(agentDir), 'SOUL.md'),
            path.join(HOME_DIR, '.openclaw', 'workspace', 'SOUL.md')
        ];

        let description = null;
        for (const sp of soulPaths) {
            try {
                if (fs.existsSync(sp)) {
                    description = fs.readFileSync(sp, 'utf-8');
                    break;
                }
            } catch (e) {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ description }));
    },

    // 分配模型给代理
    '/api/assign-model': (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { agentId, modelFullPath } = JSON.parse(body);
                if (!agentId || !modelFullPath) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'agentId and modelFullPath are required' }));
                }
                const config = getOpenClawConfig() || {};
                if (!config.agents) config.agents = {};
                if (!config.agents.list) config.agents.list = [];
                if (!config.agents.defaults) config.agents.defaults = {};
                if (!config.agents.defaults.model) config.agents.defaults.model = {};

                // 更新全局默认
                if (agentId === 'main' || agentId === 'all') {
                    config.agents.defaults.model.primary = modelFullPath;
                }

                if (agentId === 'all') {
                    // 同步修改所有 Agent
                    config.agents.list.forEach(agt => {
                        agt.model = modelFullPath;
                    });
                } else {
                    // 修改指定 Agent
                    const agent = config.agents.list.find(a => a.id === agentId);
                    if (agent) {
                        agent.model = modelFullPath;
                    } else if (agentId !== 'main' || config.agents.list.length > 0) {
                        config.agents.list.push({ id: agentId, name: agentId, model: modelFullPath });
                    }
                }

                if (saveOpenClawConfig(config)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Model set to "${modelFullPath}".` }));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to save config' }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
            }
        });
    },

    // 获取 WebUI 地址
    '/api/webui-url': (req, res) => {
        const config = getOpenClawConfig() || {};
        const port = (config.gateway && config.gateway.port) || 18789;
        
        // 兼容旧版 accessToken 和新版 auth.token 格式
        const token = (config.gateway && (config.gateway.auth?.token || config.gateway.accessToken)) || '';
        
        const url = token
            ? `http://localhost:${port}?token=${encodeURIComponent(token)}`
            : `http://localhost:${port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url }));
    },

    // 检查版本升级
    '/api/cmd/upgrade': (req, res) => {
        const platform = os.platform();
        const cmd = platform === 'win32' ? 'npm view openclaw version' : 'npm view openclaw version';
        exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (err) {
                res.end(JSON.stringify({ success: false, error: err.message, stdout: stdout || '', stderr: stderr || '' }));
            } else {
                res.end(JSON.stringify({ success: true, stdout: stdout.trim(), stderr: stderr || '' }));
            }
        });
    },

    // 故障修复
    '/api/cmd/doctor-fix': (req, res) => {
        const platform = os.platform();
        const cmd = platform === 'win32' ? 'openclaw.cmd doctor --fix' : 'openclaw doctor --fix';
        exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: !err,
                stdout: stdout || '',
                stderr: stderr || '',
                error: err ? err.message : null
            }));
        });
    },

    // 启动网关
    '/api/cmd/start': (req, res) => {
        const platform = os.platform();
        const cmd = platform === 'win32' ? 'openclaw.cmd gateway run' : 'openclaw gateway run';

        try {
            const oc = exec(cmd, {
                detached: true,
                stdio: 'ignore',
                shell: true,
                windowsHide: true
            });
            oc.unref();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Command "${cmd}" triggered.` }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
    },

    // 重启网关
    '/api/cmd/restart': (req, res) => {
        const platform = os.platform();
        if (platform === 'win32') {
            const findCmd = 'wmic process where "commandline like \'%openclaw%\' and name like \'%node%\' and not commandline like \'%server.js%\'" get processid /format:list';
            exec(findCmd, (err, stdout) => {
                if (!err && stdout) {
                    const pids = stdout.match(/ProcessId=(\d+)/g);
                    if (pids) {
                        pids.forEach(p => {
                            const pid = p.split('=')[1];
                            try { exec(`taskkill /F /PID ${pid}`); } catch (e2) {}
                        });
                    }
                }
                setTimeout(() => {
                    const oc = exec('openclaw.cmd gateway run', { detached: true, stdio: 'ignore', shell: true, windowsHide: true });
                    oc.unref();
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: 'Windows restart triggered' }));
                }, 1000);
            });
        } else {
            exec('ps -ef | grep "[o]penclaw.*gateway" | awk \'{print $2}\'', (err, stdout) => {
                if (stdout && stdout.trim()) {
                    stdout.split('\n').forEach(pid => {
                        if (pid.trim()) try { process.kill(parseInt(pid.trim()), 'SIGKILL'); } catch (e) {}
                    });
                }
                setTimeout(() => {
                    const oc = exec('openclaw gateway run', { detached: true, stdio: 'ignore', shell: true });
                    oc.unref();
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: 'Linux restart triggered' }));
                }, 500);
            });
        }
    },

    // 停止网关（shutdown）
    '/api/cmd/shutdown': (req, res) => {
        const platform = os.platform();
        if (platform === 'win32') {
            const findCmd = 'wmic process where "commandline like \'%openclaw%\' and name like \'%node%\' and not commandline like \'%server.js%\'" get processid /format:list';
            exec(findCmd, (err, stdout) => {
                if (!err && stdout) {
                    const pids = stdout.match(/ProcessId=(\d+)/g);
                    if (pids) {
                        pids.forEach(p => {
                            const pid = p.split('=')[1];
                            try { exec(`taskkill /F /PID ${pid}`); } catch (e2) {}
                        });
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Shutdown triggered' }));
            });
        } else {
            exec('ps -ef | grep "[o]penclaw.*gateway" | awk \'{print $2}\'', (err, stdout) => {
                if (stdout && stdout.trim()) {
                    stdout.split('\n').forEach(pid => {
                        if (pid.trim()) try { process.kill(parseInt(pid.trim()), 'SIGKILL'); } catch (e) {}
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Shutdown triggered' }));
            });
        }
    },

    // 获取全局系统日志 (app.log)
    '/api/sys-logs': (req, res) => {
        const logPath = path.join(HOME_DIR, '.openclaw', 'app.log');
        try {
            if (!fs.existsSync(logPath)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.trim().split('\n').slice(-100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(lines));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
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
