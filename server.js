// /home/jason/.openclaw/dashboard/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

// \u7edf\u4e00\u7684\u914d\u7f6e\u6587\u4ef6\u8def\u5f84
const HOME_DIR = os.homedir() || process.env.HOME || process.env.USERPROFILE || '/root';
const CONFIG_PATH = path.join(HOME_DIR, '.openclaw', 'openclaw.json');
const DASHBOARD_DIR = __dirname;
const PORT = 19010;

// \u8f85\u52a9\u65b9\u6cd5\uff1a\u8bfb\u53d6\u5e76\u89e3\u6790 openclaw.json
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
        exec('df -h /home && free -m && top -bn1 | grep "Cpu(s)"', (err, stdout) => {
            if (err) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: err.message }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ raw_metrics: stdout }));
        });
    },

    // 一键读取配置文件里的所有的 agents
    '/api/agents': (req, res) => {
        const config = getOpenClawConfig();
        if (!config || !config.agents || !config.agents.list) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: 'Config invalid missing agents' }));
        }

        const agents = config.agents.list;
        agents.forEach(agent => {
            agent.status = 'idle';
            agent.current_session = null;
            agent.session_age_ms = 0;
            agent.last_activity = null;
            agent.token_usage = 0;
            agent.latest_action = null;
            agent.live_model = agent.model; // fallback to config

            try {
                let agentDir = agent.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agent.id, 'agent');
                let sessionDir = path.join(agentDir.endsWith('/agent') ? agentDir.slice(0, -6) : agentDir, 'sessions');
                if (!fs.existsSync(sessionDir)) {
                    // Check workspace fallback 
                    sessionDir = path.join(HOME_DIR, '.openclaw', `workspace-${agent.id}`, 'agent', 'sessions');
                }
                if (!fs.existsSync(sessionDir)) {
                    // Check inside agent folder
                    sessionDir = path.join(agentDir, 'sessions');
                }
                if (!fs.existsSync(sessionDir)) return;

                const allFiles = fs.readdirSync(sessionDir);

                // \u5c42\u7ea71: .lock \u5b58\u6d3b\u5224\u5b9a\u6216 2\u5206\u949f\u5185\u6709 jsonl \u6d3b\u52a8
                const lockFiles = allFiles.filter(f => f.endsWith('.lock'));
                let isWorking = false;
                if (lockFiles.length > 0) {
                    isWorking = true;
                    // \u53d6\u51fa\u9501\u5bf9\u5e94\u7684 session ID
                    const lockFile = lockFiles[0];
                    agent.current_session = lockFile.replace('.jsonl.lock', '');
                } else {
                    const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl'));
                    const now = Date.now();
                    for (const f of jsonlFiles) {
                        try {
                            const stat = fs.statSync(path.join(sessionDir, f));
                            if (now - stat.mtimeMs < 120000) { // 2 minutes
                                isWorking = true;
                                break;
                            }
                        } catch (e) { }
                    }
                }

                if (isWorking) {
                    agent.status = 'working';
                }

                // 层级2: 找出最新的 .jsonl 文件
                const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));
                if (jsonlFiles.length === 0) return;

                // 按文件修改时间排序，取最新
                const sorted = jsonlFiles.sort((a, b) => {
                    const stA = fs.statSync(path.join(sessionDir, a));
                    const stB = fs.statSync(path.join(sessionDir, b));
                    return stB.mtimeMs - stA.mtimeMs;
                });

                const latestFile = sorted[0];
                const latestPath = path.join(sessionDir, latestFile);
                const latestStat = fs.statSync(latestPath);

                agent.last_activity = new Date(latestStat.mtimeMs).toISOString();
                agent.session_age_ms = Date.now() - latestStat.birthtimeMs;

                if (!agent.current_session) {
                    agent.current_session = latestFile.replace('.jsonl', '');
                }

                // 层级3: 解析 jsonl 获取 token / model / 最新动作
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
                            // 累加 token
                            if (msg.usage && msg.usage.totalTokens) {
                                totalTokens += msg.usage.totalTokens;
                            }
                            // 记录最新操作
                            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                                msg.content.forEach(c => {
                                    if (c.type === 'toolCall') {
                                        latestAction = `工具呼叫: ${c.name}`;
                                    } else if (c.type === 'text' && c.text) {
                                        const preview = c.text.slice(0, 40).replace(/\n/g, ' ');
                                        latestAction = `回复: ${preview}`;
                                    }
                                });
                            }
                            if (msg.role === 'toolResult') {
                                latestAction = `工具完成: ${msg.toolName || '?'}`;
                            }
                        }
                    } catch (e) { /* skip invalid lines */ }
                });

                if (liveModel) agent.live_model = liveModel;
                agent.token_usage = totalTokens;
                agent.latest_action = latestAction;

            } catch (e) { /* ignore */ }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agents));
    },

    // \u83b7\u53d6\u771f\u5b9e\u7cfb\u7edf\u72b6\u6001\uff08CPU\u3001\u5185\u5b58\u3001\u78c1\u76d8\u3001\u6d3e\u8dc3 Agent \u6570\uff09
    '/api/sys-health': (req, res) => {
        const os = require('os');
        const { exec } = require('child_process');

        // 1. \u5185\u5b58
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);
        const memStr = `${(usedMem / 1e9).toFixed(1)} GB / ${(totalMem / 1e9).toFixed(1)} GB`;

        // 2. CPU (\u7b80\u5355\u53d6 1\u5206\u949f loadavg \u5360 CPU \u6838\u6570\u7684\u6bd4\u4f8b)
        const cpus = os.cpus().length;
        const load = os.loadavg()[0];
        const cpuPercent = Math.min(100, Math.round((load / cpus) * 100));

        // 3. \u6d3e\u8dc3 Agents \u7edf\u8ba1\u4e0e\u4fee\u590d\u8def\u5f84\u83b7\u53d6
        let activeAgents = 0;
        let totalAgents = 8;
        try {
            const config = getOpenClawConfig();
            if (config.agents && config.agents.list) {
                const agentsList = config.agents.list;
                totalAgents = agentsList.length;

                agentsList.forEach(agt => {
                    let agentDir = agt.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agt.id, 'agent');
                    if (agentDir.endsWith('/agent')) {
                        agentDir = agentDir.slice(0, -6);
                    }
                    const sessionDir = path.join(agentDir, 'sessions');
                    if (fs.existsSync(sessionDir)) {
                        const files = fs.readdirSync(sessionDir);

                        // \u5224\u65ad .lock \u5b58\u5728\u6216\u6700\u8fd1 2 \u5206\u949f\u5185\u6709\u6d3b\u8dc3 jsonl
                        const hasLock = files.some(f => f.endsWith('.lock'));
                        let hasRecentActivity = false;

                        if (!hasLock) {
                            const now = Date.now();
                            files.filter(f => f.endsWith('.jsonl')).forEach(f => {
                                try {
                                    const stat = fs.statSync(path.join(sessionDir, f));
                                    if (now - stat.mtimeMs < 120000) { // 2 minutes
                                        hasRecentActivity = true;
                                    }
                                } catch (e) { }
                            });
                        }

                        if (hasLock || hasRecentActivity) activeAgents++;
                    }
                });
            }
        } catch (e) { }

        // 4. \u78c1\u76d8\u7a7a\u95f4 (Linux)
        exec('df -h / | tail -1', (err, stdout) => {
            let diskPercent = 0;
            let diskStr = "0 GB / 0 GB";
            if (!err && stdout) {
                const parts = stdout.trim().split(/\s+/);
                if (parts.length >= 5) {
                    const size = parts[1];
                    const used = parts[2];
                    diskPercent = parseInt(parts[4].replace('%', '')) || 0;
                    diskStr = `${used} / ${size}`;
                }
            }

            let gatewayPort = 18789;
            try {
                const config = getOpenClawConfig();
                if (config.port) gatewayPort = config.port;
            } catch (e) { }

            exec('ps -eo etimes,args | grep -E "[o]penclaw.*gateway" | head -n 1', (err2, stdout2) => {
                let uptime = 0;
                if (!err2 && stdout2 && stdout2.trim()) {
                    const match = parseInt(stdout2.trim().split(/\\s+/)[0]);
                    if (!isNaN(match)) uptime = match;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    port: gatewayPort,
                    uptime: uptime,
                    cpuPercent,
                    memPercent,
                    memStr,
                    diskPercent,
                    diskStr,
                    activeAgents,
                    totalAgents
                }));
            });
        });
    },

    // 获取指定 agent 的真实会话日志 (recent messages from latest .jsonl)
    '/api/agent-logs': (req, res) => {
        const urlParams = new URL(req.url, `http://${req.headers.host}`);
        const agentId = urlParams.searchParams.get('id') || 'main';
        const limit = parseInt(urlParams.searchParams.get('limit') || '10');

        try {
            const config = getOpenClawConfig();
            const configAgent = config.agents?.list?.find(a => a.id === agentId);
            const agentDir = configAgent?.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');
            let sessionDir = path.join(agentDir.endsWith('/agent') ? agentDir.slice(0, -6) : agentDir, 'sessions');
            if (!fs.existsSync(sessionDir)) {
                sessionDir = path.join(HOME_DIR, '.openclaw', `workspace-${agentId}`, 'agent', 'sessions');
            }
            if (!fs.existsSync(sessionDir)) {
                sessionDir = path.join(agentDir, 'sessions');
            }
            if (!fs.existsSync(sessionDir)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: [], error: 'no sessions found' }));
            }

            const jsonlFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));
            if (jsonlFiles.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: [] }));
            }

            // 按修改时间取最新
            const sorted = jsonlFiles.sort((a, b) => {
                const sa = fs.statSync(path.join(sessionDir, a));
                const sb = fs.statSync(path.join(sessionDir, b));
                return sb.mtimeMs - sa.mtimeMs;
            });

            const latestPath = path.join(sessionDir, sorted[0]);
            const lines = fs.readFileSync(latestPath, 'utf-8').trim().split('\n').filter(l => l.trim());

            const logs = [];
            const alertFlags = [];

            lines.slice(-limit * 3).forEach(line => {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'message' && entry.message) {
                        const msg = entry.message;
                        const ts = entry.timestamp || '';
                        const time = ts ? new Date(ts).toLocaleTimeString() : '';

                        if (msg.role === 'user') {
                            const text = Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text || '' : '';
                            if (text) logs.push({ level: 'user', time, text: text.slice(0, 120) });
                        } else if (msg.role === 'assistant') {
                            if (Array.isArray(msg.content)) {
                                msg.content.forEach(c => {
                                    if (c.type === 'text' && c.text) logs.push({ level: 'assistant', time, text: c.text.slice(0, 120) });
                                    if (c.type === 'toolCall') logs.push({ level: 'tool', time, text: `呼叫工具: ${c.name}(${JSON.stringify(c.arguments || {}).slice(0, 80)})` });
                                });
                            }
                            // 检查 error / auth 失败 alert
                            const txt = JSON.stringify(msg.content || '');
                            if (/429|rate.limit/i.test(txt)) alertFlags.push('rate_limit');
                            if (/auth.fail|unauthorized|401/i.test(txt)) alertFlags.push('auth_fail');
                            if (/timeout|timed.out/i.test(txt)) alertFlags.push('timeout');
                        } else if (msg.role === 'toolResult') {
                            const txt = JSON.stringify(msg.content || '');
                            if (/429|rate.limit/i.test(txt)) alertFlags.push('rate_limit');
                            if (/error|failed/i.test(txt) && msg.isError) {
                                logs.push({ level: 'error', time, text: `工具失败: ${msg.toolName} - ${txt.slice(0, 100)}` });
                            }
                        }
                    }
                } catch (e) { /* skip */ }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs: logs.slice(-limit), alerts: [...new Set(alertFlags)] }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    },


    // 获取所有 API 供应商列表
    '/api/providers': (req, res) => {
        const config = getOpenClawConfig();
        if (!config || !config.models || !config.models.providers) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: 'Config invalid missing providers' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config.models.providers));
    },

    // 新增或更新 API 供应商
    '/api/add-provider': (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { providerName, baseUrl, apiKey, apiType } = data;
                if (!providerName || !baseUrl || !apiKey) {
                    res.writeHead(400); return res.end(JSON.stringify({ error: "Missing required fields" }));
                }

                const config = getOpenClawConfig();
                if (!config.models) config.models = { mode: "merge", providers: {} };
                if (!config.models.providers) config.models.providers = {};

                config.models.providers[providerName] = {
                    baseUrl,
                    apiKey,
                    api: apiType || "openai-completions",
                    models: config.models.providers[providerName]?.models || []
                };

                saveOpenClawConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `供应商 ${providerName} 已更新` }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
    },

    // 删除 API 供应商
    '/api/delete-provider': (req, res) => {
        const urlParams = new URL(req.url, `http://${req.headers.host}`);
        const providerName = urlParams.searchParams.get('name');

        if (!providerName) {
            res.writeHead(400); return res.end(JSON.stringify({ error: "Missing provider name" }));
        }

        try {
            const config = getOpenClawConfig();
            if (config.models && config.models.providers && config.models.providers[providerName]) {
                delete config.models.providers[providerName];
                saveOpenClawConfig(config);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `供应商 ${providerName} 已删除` }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "Error updating config" }));
        }
    },

    // 发现指定供应商支持的模型
    '/api/discover-models': (req, res) => {
        const urlParams = new URL(req.url, `http://${req.headers.host}`);
        const providerName = urlParams.searchParams.get('provider');

        const config = getOpenClawConfig();
        const providers = config.models?.providers || {};

        // 如果没传 providerName，默认取第一个
        const pName = providerName || Object.keys(providers)[0];
        if (!pName || !providers[pName]) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, api_models: [], local_models: [], error: 'Provider not found' }));
        }

        const p = providers[pName];
        const fetchUrl = `${p.baseUrl}/models`;
        fetch(fetchUrl, {
            headers: { 'Authorization': `Bearer ${p.apiKey}` }
        }).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        }).then(result => {
            const api_models = result.data || [];
            if (api_models.length > 0) {
                // Return mapped objects without saving immediately
                const mappedModels = api_models.map(m => {
                    const id = typeof m === 'object' ? (m.id || m.name) : m;
                    const isVision = id.toLowerCase().includes('vl') || id.toLowerCase().includes('vision');

                    return {
                        id: id,
                        name: id,
                        api: p.api || "openai-completions",
                        reasoning: false,
                        input: isVision ? ["text", "image"] : ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128000,
                        maxTokens: 8192
                    };
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, api_models: mappedModels, local_models: p.models || [] }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, api_models: [], local_models: p.models || [] }));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message, api_models: [], local_models: [] }));
        });
    },

    '/api/sandbox': (req, res) => {
        if (req.method === 'GET') {
            const config = getOpenClawConfig();
            const level = config?.tools?.exec?.security || 'full';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ level }));
        } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const newLevel = data.level;
                    const config = getOpenClawConfig();
                    if (!config.tools) config.tools = {};
                    if (!config.tools.exec) config.tools.exec = {};
                    config.tools.exec.security = newLevel;
                    saveOpenClawConfig(config);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, level: newLevel }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                }
            });
        }
    },

    // 接收用户前端筛选后的模型列表，覆写配置并注册到白名单
    '/api/save-models': (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { providerName, models } = data;
                if (!providerName || !Array.isArray(models)) {
                    res.writeHead(400); return res.end(JSON.stringify({ error: "Missing required fields or models is not array" }));
                }

                const config = getOpenClawConfig();
                if (!config.models || !config.models.providers || !config.models.providers[providerName]) {
                    res.writeHead(404); return res.end(JSON.stringify({ error: "Provider not found" }));
                }

                // Process frontend overrides for vision
                const processedModels = models.map(m => {
                    let obj = typeof m === 'object' ? m : { id: m, name: m, input: ["text"] };
                    if (obj.isVision || (obj.input && obj.input.includes("image"))) {
                        obj.input = ["text", "image"];
                        delete obj.isVision; // Clean up temporary frontend flag
                    } else {
                        obj.input = ["text"];
                    }
                    return obj;
                });

                // Overwrite provider's models array
                config.models.providers[providerName].models = processedModels;

                // Ensure agents default dictionary exists
                if (!config.agents) config.agents = {};
                if (!config.agents.defaults) config.agents.defaults = {};
                if (!config.agents.defaults.models) config.agents.defaults.models = {};

                // Register selected models as agent defaults
                models.forEach(m => {
                    const id = typeof m === 'object' ? m.id : m;
                    const fullId = `${providerName}/${id}`;
                    if (!config.agents.defaults.models[fullId]) {
                        config.agents.defaults.models[fullId] = { alias: id.split('/').pop() || id };
                    }
                });

                saveOpenClawConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Models saved successfully for ${providerName}` }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
    },

    // 读写指定 agent 的 SOUL.md 配置文件供前台弹窗显示
    '/api/agent-detail': (req, res) => {
        const urlParams = new URL(req.url, `http://${req.headers.host}`);
        const agentId = urlParams.searchParams.get('id');
        if (!agentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Missing agent id" }));
        }

        try {
            const config = getOpenClawConfig();
            const agent = config.agents?.list?.find(a => a.id === agentId);
            let agentDir = agent?.agentDir || path.join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');
            // 1. Direct agent folder check
            let userMdPath = path.join(agentDir, 'SOUL.md');

            // 2. Check workspace sub-agent location
            if (!fs.existsSync(userMdPath)) {
                userMdPath = path.join(HOME_DIR, '.openclaw', `workspace-${agentId}`, 'SOUL.md');
            }
            // 3. Check within main workspace agents folder
            if (!fs.existsSync(userMdPath)) {
                userMdPath = path.join(HOME_DIR, '.openclaw', 'workspace', 'agents', agentId, 'SOUL.md');
            }
            // 4. Check main workspace root (for 'main' agent)
            if (!fs.existsSync(userMdPath) && agentId === 'main') {
                userMdPath = path.join(HOME_DIR, '.openclaw', 'workspace', 'SOUL.md');
            }

            let content = '';
            if (fs.existsSync(userMdPath)) {
                content = fs.readFileSync(userMdPath, 'utf8');
            } else {
                content = `该 Agent (${agentId}) 暂无详细描述信息或未创建 SOUL.md 文件。`;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: agentId, description: content }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    },

    // 保存大模型配置至指定 agent
    '/api/assign-model': (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { agentId, modelFullPath } = data; // 例如 newapi/grok-4.1-thinking

                const config = getOpenClawConfig();
                const agent = config.agents?.list?.find(a => a.id === agentId);
                if (agent) {
                    agent.model = modelFullPath;

                    if (!config.agents.defaults) config.agents.defaults = {};
                    if (!config.agents.defaults.models) config.agents.defaults.models = {};
                    if (!config.agents.defaults.models[modelFullPath]) {
                        config.agents.defaults.models[modelFullPath] = { alias: modelFullPath.split('/').pop() || modelFullPath };
                    }

                    saveOpenClawConfig(config);
                    // 尝试通过指令通知原系统 reload，无论成败不阻断
                    exec('openclaw gateway reload', () => { });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `模型已重新分配给 ${agentId}` }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: "Agent not found" }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
    },

    // 执行 OpenClaw Gateway 重启命令 (原生查杀并显式启动)
    '/api/cmd/restart': (req, res) => {
        try {
            const fs = require('fs');
            const { spawn } = require('child_process');
            const dirs = fs.readdirSync('/proc');
            let killedCount = 0;

            for (const pidStr of dirs) {
                if (/^\d+$/.test(pidStr)) {
                    try {
                        const cmdline = fs.readFileSync(`/proc/${pidStr}/cmdline`, 'utf8');
                        if (cmdline.includes('openclaw')) {
                            // 别把自己干掉了，也别动 dashboard
                            if (cmdline.includes('server.js') || cmdline.includes('dashboard')) continue;
                            const targetPid = parseInt(pidStr, 10);
                            process.kill(targetPid, 'SIGKILL');
                            killedCount++;
                        }
                    } catch (e) {
                        // ignore permission errors
                    }
                }
            }

            // 给点时间让操作系统释放端口，然后显式拉起新的 gateway
            setTimeout(() => {
                try {
                    const subprocess = spawn('openclaw', ['gateway', 'start'], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    subprocess.unref(); // 让新进程脱离 dashboard
                } catch (e) { }
            }, 1500);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `已清理 ${killedCount} 个僵尸进程，新网关进程已派发。等待约 5 秒后恢复上线。` }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    },

    // 紧急修复被写坏的 models 数组数据为 Object 结构
    '/api/cmd/fix': (req, res) => {
        try {
            const configPath = path.join(HOME_DIR, '.openclaw', 'openclaw.json');
            let cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (cfg.models && cfg.models.providers) {
                for (let pName in cfg.models.providers) {
                    let p = cfg.models.providers[pName];
                    if (p && Array.isArray(p.models)) {
                        p.models = p.models.map(m => {
                            if (typeof m === 'string') {
                                return {
                                    id: m,
                                    name: m,
                                    api: p.api || "openai-completions",
                                    reasoning: false,
                                    input: ["text"],
                                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                                    contextWindow: 128000,
                                    maxTokens: 8192
                                };
                            }
                            return m;
                        });
                    }
                }
            }
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: "Fixed models data format in openclaw.json" }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    },

    '/api/cmd/upgrade': (req, res) => {
        const { exec } = require('child_process'); // Ensure exec is available
        exec('npm view openclaw version', (error, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (error) {
                res.end(JSON.stringify({ success: false, error: stderr || error.message }));
            } else {
                const latest = stdout.trim();
                res.end(JSON.stringify({
                    success: true,
                    stdout: `Scanning NPM Repository...\nLatest version on NPM is: ${latest}\nPlease run 'npm install -g openclaw@latest' manually if you wish to upgrade.`
                }));
            }
        });
    },

    // 运行 openclaw doctor --fix
    '/api/cmd/doctor-fix': (req, res) => {
        const { exec } = require('child_process');
        exec('openclaw doctor --fix', (err, stdout, stderr) => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: !err,
                error: err ? err.message : null,
                stdout: stdout,
                stderr: stderr
            }));
        });
    },

    // 动态获取 OpenClaw 长连接 URL 与免密 Token 防止重放拉黑
    '/api/webui-url': (req, res) => {
        try {
            const config = getOpenClawConfig();
            const port = config?.gateway?.port || 4000;
            const token = config?.gateway?.auth?.token || '';
            const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';

            const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(host);
            const tlsEnabled = config?.gateway?.tls?.enabled === true;
            // 如果开启了 TLS 且不是本机回路访问，则必须为 https
            const protocol = (tlsEnabled && !isLocal) ? 'https' : 'http';

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: `${protocol}://${host}:${port}/?token=${token}` }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    }
};

// 简易路由
const server = http.createServer((req, res) => {
    // 允许跨域
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 路由 API
    const baseUrl = req.url.split('?')[0];
    if (baseUrl.startsWith('/api/') && apiHandlers[baseUrl]) {
        return apiHandlers[baseUrl](req, res);
    }

    // 服务静态文件 (index.html, index.css, app.js 等)
    let filePath = path.join(DASHBOARD_DIR, baseUrl === '/' ? 'index.html' : baseUrl);

    // 防止目录穿越
    if (!filePath.startsWith(DASHBOARD_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code == 'ENOENT') {
                res.writeHead(404);
                res.end(`File not found.`);
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`OpenClaw Dashboard Backend running at http://localhost:${PORT}/`);
});
