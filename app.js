// /home/jason/.openclaw/dashboard/app.js

const i18n = {
    'zh': {
        app_title: 'OpenClaw Hub',
        gateway_port: 'Gateway Port',
        uptime: 'Uptime',
        quick_control: '快速控制',
        restart_gateway: '重启 OpenClaw',
        check_upgrade: '检查版本升级',
        stop_service: '停止服务',
        llm_config: '大模型接入商配置',
        save_config: '保存配置',
        provider_desc: '配置不同供应商 API 以供 Agent 分配不同的大模型。',
        select_provider: 'API Provider',
        create_provider: '新增供应商',
        discover_models: '探测可用模型并存入列表',
        click_discover: '点击上方按钮获取远端模型列表',
        create_provider_title: '创建新 Provider',
        provider_id: 'Provider ID (不可包含空格)',
        cancel: '取消',
        confirm: '确定',
        cpu_load: 'CPU 负载',
        mem_usage: '内存占用',
        disk_usage: '存储使用率',
        active_agents: '活跃子代理',
        agent_matrix: '蜂巢代理矩阵 (Agent Matrix)',
        sys_logs: 'System Logs (app.log)'
    },
    'en': {
        app_title: 'OpenClaw Hub',
        gateway_port: 'Gateway Port',
        uptime: 'Uptime',
        quick_control: 'Quick Controls',
        restart_gateway: 'Restart OpenClaw',
        check_upgrade: 'Check for Updates',
        stop_service: 'Stop Service',
        llm_config: 'LLM Engine Config',
        save_config: 'Save Config',
        provider_desc: 'Configure Providers for Agents to allocate different LLMs.',
        select_provider: 'API Provider',
        create_provider: 'New',
        discover_models: 'Discover Models to List',
        click_discover: 'Click above button to fetch remote models',
        create_provider_title: 'Create New Provider',
        provider_id: 'Provider ID (No spaces)',
        cancel: 'Cancel',
        confirm: 'Confirm',
        cpu_load: 'CPU Load',
        mem_usage: 'Mem Usage',
        disk_usage: 'Disk Usage',
        active_agents: 'Active Agents',
        agent_matrix: 'Agent Matrix',
        sys_logs: 'System Logs (app.log)'
    }
};

let currentLang = 'zh';
let isLightMode = false;
let providersData = {};

let agentsData = [];
let localModelsData = [];

// 拉取系统健康状态（CPU, 内存, 磁盘, Agent活跃）
async function fetchSysHealth() {
    try {
        const res = await fetch('/api/sys-health');
        if (!res.ok) return;
        const data = await res.json();

        // 更新 DOM (文本与进度条)
        if (data.cpuPercent !== undefined) {
            document.getElementById('cpu-text').innerText = `${data.cpuPercent}%`;
            document.getElementById('cpu-bar').style.width = `${data.cpuPercent}%`;
        }
        if (data.memStr) {
            document.getElementById('mem-text').innerText = data.memStr;
            document.getElementById('mem-bar').style.width = `${data.memPercent}%`;
        }
        if (data.diskStr) {
            document.getElementById('disk-text').innerText = `${data.diskStr} (${data.diskPercent}%)`;
            document.getElementById('disk-bar').style.width = `${data.diskPercent}%`;
        }
        if (data.activeAgents !== undefined && data.totalAgents) {
            document.getElementById('agents-text').innerText = `${data.activeAgents} / ${data.totalAgents} 槽位`;
            const activePercent = Math.round((data.activeAgents / data.totalAgents) * 100);
            document.getElementById('agents-bar').style.width = `${activePercent}%`;
        }
    } catch (err) {
        // failed silently if backend is restarting
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initThemeAndLang(); // Keep original name
    loadProviders(); // Keep original name
    fetchSysHealth(); // New call
    fetchAgentsData();
    simulateLogs(); // Keep original call

    setInterval(() => { // Modified setInterval
        fetchAgentsData();
        fetchSysHealth();
    }, 5000); // 每 5 秒刷新一次系统状态和代理状态
});

function initThemeAndLang() {
    document.getElementById('theme-toggle').addEventListener('click', () => {
        isLightMode = !isLightMode;
        if (isLightMode) {
            document.body.classList.add('light-mode');
            document.querySelector('#theme-toggle i').className = 'fas fa-sun';
        } else {
            document.body.classList.remove('light-mode');
            document.querySelector('#theme-toggle i').className = 'fas fa-moon';
        }
    });

    document.getElementById('lang-toggle').addEventListener('click', () => {
        currentLang = currentLang === 'zh' ? 'en' : 'zh';
        applyTranslations();
    });
}

function applyTranslations() {
    const dict = i18n[currentLang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) {
            el.innerText = dict[key];
        }
    });
}

async function loadProviders() {
    try {
        const res = await fetch('/api/providers');
        providersData = await res.json();

        localModelsData = [];
        const container = document.getElementById('providers-accordion-container');
        if (!container) return;
        container.innerHTML = '';

        for (const pname in providersData) {
            const p = providersData[pname];

            if (p.models && Array.isArray(p.models)) {
                p.models.forEach(m => {
                    const id = typeof m === 'object' ? (m.id || m.name) : m;
                    localModelsData.push(`${pname}/${id}`);
                });
            }

            const modelsHtml = (p.models || []).map(m => {
                const id = typeof m === 'object' ? (m.id || m.name) : m;
                return `<div style="padding:4px;border-bottom:1px solid rgba(255,255,255,0.05);color:var(--text-secondary)"><i class="fa-solid fa-check" style="color:var(--accent-green)"></i> ${id}</div>`;
            }).join('');

            container.innerHTML += `
                <div class="accordion-item" id="provider-box-${pname}">
                <div class="accordion-header" onclick="toggleProvider('${pname}')">
                    <span><i class="fa-solid fa-server" style="color:var(--accent-purple)"></i> ${pname}</span>
                    <i class="fa-solid fa-chevron-down" style="transition: transform 0.2s"></i>
                </div>
                <div class="accordion-body">
                    <div>
                        <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block">Base URL</label>
                        <input type="text" class="config-input" id="url-${pname}" value="${p.baseUrl || ''}">
                    </div>
                    <div>
                        <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block">API Key</label>
                        <input type="password" class="config-input" id="key-${pname}" value="${p.apiKey || ''}">
                    </div>
                    <div style="display:flex; gap:8px; margin-top: 4px">
                        <button class="save-btn" style="flex:1; padding: 6px;" onclick="saveProviderConfig('${pname}')"><i class="fa-solid fa-save"></i> <span data-i18n="save_config">保存配置</span></button>
                        <button class="discovery-btn" style="flex:2; justify-content:center; padding: 6px;" onclick="discoverModelsForProvider('${pname}')"><i class="fa-solid fa-radar"></i> <span data-i18n="discover_models">发现探测新模型</span></button>
                    </div>
                    <button class="cmd-btn" style="width:100%; margin-top: 8px; border-color: rgba(239, 68, 68, 0.4); color: var(--accent-red);" onclick="deleteProviderConfig('${pname}')"><i class="fa-solid fa-trash"></i> 删除此提供商</button>
                    <div id="models-list-${pname}" style="max-height: 150px; overflow-y: auto; background: var(--bg-accent); border-radius: 8px; padding: 8px; font-size: 0.8rem; margin-top:8px;">
                        ${modelsHtml || `<div style="text-align:center; color:var(--text-secondary)" data-i18n="click_discover">请点击上方的发现按键</div>`}
                    </div>
                </div>
            </div>
            `;
        }

        applyTranslations();
        if (agentsData.length > 0) renderAgentGrid();
    } catch (e) {
        console.error("Failed to load providers", e);
    }
}

function toggleProvider(pname) {
    const box = document.getElementById(`provider-box-${pname}`);
    if (box) box.classList.toggle('active');
}

function addProviderPrompt() {
    document.getElementById('new-provider-name').value = '';
    document.getElementById('new-provider-url').value = '';
    document.getElementById('new-provider-key').value = '';
    document.getElementById('add-provider-modal').style.display = 'flex';
}

async function confirmAddProvider() {
    const pName = document.getElementById('new-provider-name').value.trim();
    const pUrl = document.getElementById('new-provider-url').value.trim() || 'https://api.openai.com/v1';
    const pKey = document.getElementById('new-provider-key').value.trim() || 'sk-xxxxxxxx';
    if (!pName) return;
    try {
        await fetch('/api/add-provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providerName: pName,
                baseUrl: pUrl,
                apiKey: pKey,
                apiType: 'openai-completions'
            })
        });
        document.getElementById('add-provider-modal').style.display = 'none';
        await loadProviders();
        document.getElementById(`provider-box-${pName}`).classList.add('active');
    } catch (e) {
        console.error("Add provider failed", e);
    }
}

async function deleteProviderConfig(pName) {
    if (!confirm(`确定要永久删除 ${pName} 这个模型供应商配置吗？这会导致所有使用了它的 Agent 失去模型连接！`)) return;
    try {
        const res = await fetch(`/api/delete-provider?name=${encodeURIComponent(pName)}`, { method: 'DELETE' });
        const data = await res.json();
        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `
            <div class="log-line">
                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-warn">[CONFIG_DELETE]</span>
                <span style="color:var(--accent-red)">${data.message || 'Provider eliminated.'}</span>
            </div>
        `;
        terminal.scrollTop = terminal.scrollHeight;
        await loadProviders();
    } catch (e) {
        console.error("Delete provider failed", e);
    }
}

async function saveProviderConfig(pName) {
    const pUrl = document.getElementById(`url-${pName}`).value;
    const pKey = document.getElementById(`key-${pName}`).value;

    try {
        const res = await fetch('/api/add-provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providerName: pName,
                baseUrl: pUrl,
                apiKey: pKey
            })
        });
        const data = await res.json();
        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `
            <div class="log-line">
                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-success">[CONFIG_UPDATE]</span>
                <span>${data.message || 'Provider saved successfully.'}</span>
            </div>
        `;
        terminal.scrollTop = terminal.scrollHeight;
        await loadProviders();
        document.getElementById(`provider-box-${pName}`).classList.add('active');
    } catch (e) {
        console.error("Save provider failed", e);
    }
}

let currentProviderForModels = null;
let transferState = {
    left: [], // 已保存的 models 对象数组
    right: [] // 探测到的新 models 对象数组
};

async function discoverModelsForProvider(pName) {
    const list = document.getElementById(`models-list-${pName}`);
    list.innerHTML = `<div style="text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> 探测中...</div>`;

    try {
        const res = await fetch(`/api/discover-models?provider=${encodeURIComponent(pName)}`);
        const data = await res.json();
        const apiModels = data.api_models || [];
        const localModels = data.local_models || []; // 已保存的模型用于默认选中

        if (apiModels.length === 0 && localModels.length === 0) {
            list.innerHTML = `<div style="color:var(--accent-red)"><i class="fa-solid fa-triangle-exclamation"></i> 未探测到可用模型</div>`;
            return;
        }

        // 还原原列表视图
        await loadProviders();
        document.getElementById(`provider-box-${pName}`).classList.add('active');

        // ==== 构建双列 State ====
        currentProviderForModels = pName;

        // 左边：从 localModels 中还原
        // 为了确保哪怕是纯字符串也能转对象，统一转化为对象结构缓存
        transferState.left = localModels.map(m => {
            if (typeof m === 'string') return { id: m, name: m, api: 'openai-completions' };
            return m;
        });

        const leftIds = transferState.left.map(m => m.id);

        // 右边：apiModels 中排除存在于 left 的
        transferState.right = apiModels.filter(m => !leftIds.includes(m.id));

        document.getElementById('left-search').value = '';
        document.getElementById('right-search').value = '';
        renderTransfer();
        document.getElementById('model-select-modal').style.display = 'block';

        // Add log
        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `
            <div class="log-line">
                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-success">[DISCOVERY]</span>
                <span>${apiModels.length} models probe done for ${pName}. Waiting for transfer config.</span>
            </div>
        `;
        terminal.scrollTop = terminal.scrollHeight;
    } catch (e) {
        if (list) list.innerHTML = `<div style="color:var(--accent-red)"><i class="fa-solid fa-triangle-exclamation"></i> 探测失败</div>`;
    }
}

function renderTransfer() {
    ['left', 'right'].forEach(side => {
        const query = (document.getElementById(`${side}-search`).value || '').toLowerCase();
        const container = document.getElementById(`${side}-list`);

        // 过滤
        const filtered = transferState[side].filter(m => {
            return m.id.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query));
        });

        // 重新保留用户的勾选状态（如果在重新渲染前被勾选，不被搜索破坏）
        // 但鉴于 DOM 销毁简单化，暂时只保留最单纯的渲染：
        container.innerHTML = '';
        filtered.forEach(m => {
            container.innerHTML += `
                <label style="display:flex; align-items:center; gap: 8px; margin-bottom:6px; cursor:pointer;" class="model-cb-label">
                    <input type="checkbox" value="${m.id}" class="model-cb-${side}">
                    <span style="word-break: break-all;">${m.id}</span>
                </label>
            `;
        });
    });
}

function transferSelectAll(side) {
    document.querySelectorAll(`.model-cb-${side}`).forEach(cb => cb.checked = true);
}

function transferInvert(side) {
    document.querySelectorAll(`.model-cb-${side}`).forEach(cb => cb.checked = !cb.checked);
}

function moveSelectedToLeft() {
    processTransfer('right', 'left');
}

function moveSelectedToRight() {
    processTransfer('left', 'right');
}

function processTransfer(fromSide, toSide) {
    const checkedBoxes = Array.from(document.querySelectorAll(`.model-cb-${fromSide}:checked`)).map(cb => cb.value);
    if (checkedBoxes.length === 0) return;

    // 找到所有选中的模型对象并从源数组移除
    const movingObjects = [];
    transferState[fromSide] = transferState[fromSide].filter(m => {
        if (checkedBoxes.includes(m.id)) {
            movingObjects.push(m);
            return false;
        }
        return true;
    });

    // 加入目标数组
    transferState[toSide].push(...movingObjects);
    renderTransfer();
}

function closeModelModal() {
    document.getElementById('model-select-modal').style.display = 'none';
}

async function submitTransferModels() {
    if (!currentProviderForModels) return;

    // 穿梭框只要留存在左边的，统统算作最终的“已选择”列表需要下发给远端
    const finalSelectedObjects = transferState.left;

    try {
        const res = await fetch('/api/save-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providerName: currentProviderForModels,
                models: finalSelectedObjects
            })
        });

        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `
            <div class="log-line">
                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-success">[SAVE_MODELS]</span>
                <span>Saved ${finalSelectedObjects.length} models for ${currentProviderForModels}.</span>
            </div>
        `;
        terminal.scrollTop = terminal.scrollHeight;

        closeModelModal();
        await loadProviders();
        document.getElementById(`provider-box-${currentProviderForModels}`).classList.add('active');

    } catch (e) {
        console.error("Failed to save models", e);
    }
}

async function fetchSystemMetrics() {
    try {
        const res = await fetch('/api/sys-metrics');
        const data = await res.json();
        // 这里后续可以扩展解析 stdout 并填入度量卡片的逻辑
    } catch (e) {
        console.error("fetch metrics error");
    }
}

async function fetchAgentsData() {
    try {
        const res = await fetch('/api/agents');
        agentsData = await res.json();
        renderAgentGrid();
    } catch (e) {
        console.error("Failed to load agents from API", e);
    }
}

// 渲染代理卡片
function renderAgentGrid() {
    const grid = document.getElementById('agent-grid');
    grid.innerHTML = '';

    // 如果还没探测模型，展示未知。如果有 localModelsData，就展示
    let optionList = localModelsData.length > 0 ? localModelsData : (agentsData.map(a => a.model).filter(Boolean));
    const uniqueOptions = [...new Set(optionList)];

    agentsData.forEach(agent => {
        const card = document.createElement('div');
        card.className = 'agent-card';

        // \u786e\u4fdd\u5f53\u524d\u914d\u7f6e\u7684\u6a21\u578b\u5b58\u5728\u4e8e options \u4e2d\uff0c\u5426\u5219\u6d4f\u89c8\u5668\u4f1a\u9ed8\u8ba4\u9009\u4e2d\u7b2c\u4e00\u9879\u5bfc\u81f4\u8bef\u5bfc
        let hasSelectedOption = false;

        let optionsHtml = uniqueOptions.map(model => {
            if (typeof model === 'string') {
                const isSelected = agent.model === model;
                if (isSelected) hasSelectedOption = true;
                return `<option value="${model}" ${isSelected ? 'selected' : ''}>${model}</option>`;
            } else if (model.id) {
                const isSelected = agent.model === model.id;
                if (isSelected) hasSelectedOption = true;
                return `<option value="${model.id}" ${isSelected ? 'selected' : ''}>${model.id}</option>`;
            }
            return '';
        }).join('');

        if (agent.model && !hasSelectedOption) {
            optionsHtml = `<option value="${agent.model}" selected>${agent.model} (\u672a\u5728\u4f9b\u5e94\u5546\u5217\u8868\u4e2d)</option>` + optionsHtml;
        }

        const statusBadge = agent.status === 'working'
            ? `<span style="font-size:0.7rem; background:rgba(16,185,129,0.2); color:var(--accent-green); padding:2px 6px; border-radius:4px; border:1px solid rgba(16,185,129,0.3)">● 运行中</span>`
            : `<span style="font-size:0.7rem; background:rgba(100,100,100,0.15); color:var(--text-secondary); padding:2px 6px; border-radius:4px">○ 待机</span>`;

        const tokenBadge = agent.token_usage > 0
            ? `<span title="本次会话累计 Token 用量（一个 Token 大约是半个汉字或 3/4 个英文单词）" style="font-size:0.7rem; color:var(--accent-blue); cursor:help">📊 ${agent.token_usage.toLocaleString()} Tokens</span>`
            : '';

        const latestActionHtml = agent.latest_action
            ? `<div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer" title="点击查看会话日志" onclick="viewAgentLogs('${agent.id}')">🔄 ${agent.latest_action.slice(0, 45)}${agent.latest_action.length > 45 ? '...' : ''}</div>`
            : '';

        const lastActivityHtml = agent.last_activity
            ? `<div style="font-size:0.7rem; color:var(--text-secondary); margin-top:2px;">🕑 ${(() => { try { return new Date(agent.last_activity).toLocaleString(); } catch (e) { return ''; } })()
            }</div>` : '';

        card.innerHTML = `
            <div style="display:flex; flex-direction:column; height:100%; gap:6px;">
                <!-- 顶部：功能名 + 状态灯 -->
                <div class="agent-header" style="flex-shrink:0;">
                    <div class="agent-name">
                        <i class="fa-solid fa-robot" style="color: var(--text-secondary)"></i>
                        ${agent.name || agent.id}
                    </div>
                    <div class="status-orb ${agent.status === 'working' ? 'active' : ''}" title="${agent.status}"></div>
                </div>

                <!-- 状态徽章行 -->
                <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                    ${statusBadge}
                    ${tokenBadge}
                </div>

                <!-- 最新操作，固定高度超出省略 -->
                <div style="font-size:0.7rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; min-height:1rem;" ${agent.latest_action ? `title="${agent.latest_action}" onclick="viewAgentLogs('${agent.id}')" style="font-size:0.7rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; cursor:pointer;"` : ''}>
                    ${agent.latest_action ? `🔄 ${agent.latest_action.slice(0, 42)}${agent.latest_action.length > 42 ? '...' : ''}` : ''}
                </div>

                <!-- 模型选择器（自动占满剩余空间） -->
                <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:4px; min-height:0;">
                    <label style="font-size:0.72rem; color:var(--text-secondary);">AI 核心模型：</label>
                    <div style="display:flex; gap:4px;">
                        <select class="model-selector" id="agent-mdl-${agent.id}" style="flex:1; font-size:0.78rem; padding:4px 8px;">
                            ${optionsHtml}
                        </select>
                        <button class="save-btn" style="padding:4px 8px; font-size:0.72rem; white-space:nowrap;" onclick="updateAgentModel('${agent.id}', document.getElementById('agent-mdl-${agent.id}').value)">应用</button>
                    </div>
                </div>

                <!-- 底部查看日志 -->
                <div style="display:flex; justify-content:flex-end; flex-shrink:0; padding-top:4px; border-top:1px solid rgba(255,255,255,0.05);">
                    <span style="color:var(--accent-blue); font-size:0.75rem; cursor:pointer;" onclick="viewAgentLogs('${agent.id}')">
                        <i class="fa-solid fa-terminal"></i> 查看日志
                    </span>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

function updateAgentModel(agentId, newModel) {
    if (!newModel) return;

    fetch('/api/assign-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, modelFullPath: newModel })
    })
        .then(res => res.json())
        .then(data => {
            const terminal = document.getElementById('terminal-output');
            if (data.success) {
                terminal.innerHTML += `
                <div class="log-line">
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    <span class="log-success">[\u914d\u7f6e\u5199\u5165]</span>
                    <span>\u2705 ${agentId} \u7684\u9ed8\u8ba4\u6a21\u578b\u5df2\u4fee\u6539\u4e3a <b>${newModel}</b></span>
                </div>
                <div class="log-line">
                    <span class="log-time"></span>
                    <span class="log-warn">[\u751f\u6548\u65f6\u673a]</span>
                    <span>\u26a0\ufe0f \u5f53\u524d\u8fd0\u884c\u4e2d\u7684\u4f1a\u8bdd\u4e0d\u53d7\u5f71\u54cd\u3002\u4e0b\u6b21\u65b0\u5efa\u8be5 Agent \u7684\u5bf9\u8bdd\u65f6\u81ea\u52a8\u751f\u6548\u3002\u5982\u9700\u7acb\u5373\u751f\u6548 \u2192 \u70b9\u51fb\u5de6\u4e0a\u89d2\u201c\u91cd\u542f\u7f51\u5173\u201d\u6309\u94ae\u3002</span>
                </div>`;
            } else {
                terminal.innerHTML += `
                <div class="log-line">
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    <span class="log-error">[\u5931\u8d25]</span>
                    <span>\u274c ${data.error || '\u5199\u5165\u914d\u7f6e\u5931\u8d25'}</span>
                </div>`;
            }
            terminal.scrollTop = terminal.scrollHeight;
            fetchAgentsData();
        })
        .catch(err => {
            const terminal = document.getElementById('terminal-output');
            terminal.innerHTML += `<div class="log-line"><span class="log-error">[\u9519\u8bef] \u8bf7\u6c42\u5931\u8d25: ${err.message}</span></div>`;
        });
}

async function viewAgentLogs(agentId) {
    const terminal = document.getElementById('terminal-output');
    terminal.innerHTML = `
        <div class="log-line">
            <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
            <span class="log-info">[SESSION LOGS]</span>
            <span>正在从 ${agentId} 的最新会话中加载真实日志...</span>
        </div>
    `;

    try {
        const res = await fetch(`/api/agent-logs?id=${agentId}&limit=12`);
        const data = await res.json();

        // 展示告警 badges
        if (data.alerts && data.alerts.length > 0) {
            data.alerts.forEach(alert => {
                const alertMap = { rate_limit: ['🟡 限流告警 429', 'log-warn'], auth_fail: ['🔴 鉴权失败', 'log-error'], timeout: ['🟠 超时', 'log-warn'] };
                const [txt, cls] = alertMap[alert] || [alert, 'log-warn'];
                terminal.innerHTML += `<div class="log-line"><span class="log-time">[ALERT]</span><span class="${cls}">${txt}</span></div>`;
            });
        }

        if (!data.logs || data.logs.length === 0) {
            terminal.innerHTML += `<div class="log-line"><span class="log-info">[INFO]</span><span>暨时未找到该 Agent 的新近日志。</span></div>`;
        } else {
            const levelMap = { user: 'log-agent', assistant: 'log-success', tool: 'log-info', error: 'log-error' };
            data.logs.forEach(log => {
                const cls = levelMap[log.level] || 'log-info';
                const icon = { user: '👤', assistant: '🤖', tool: '🔧', error: '❌' }[log.level] || 'ℹ️';
                terminal.innerHTML += `
                    <div class="log-line">
                        <span class="log-time">[${log.time}]</span>
                        <span class="${cls}">${icon} [${agentId}]</span>
                        <span style="word-break:break-word">${escapeHtml(log.text)}</span>
                    </div>`;
            });
        }
    } catch (e) {
        terminal.innerHTML += `<div class="log-line"><span class="log-error">[ERROR]日志加载失败: ${e.message}</span></div>`;
    }
    terminal.scrollTop = terminal.scrollHeight;
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 访问带长效 Token 的原版 WebUI
async function openWebUI() {
    try {
        const res = await fetch('/api/webui-url');
        const data = await res.json();
        if (data.url) {
            window.open(data.url, '_blank');
        } else {
            console.error("Failed to fetch WebUI URL:", data.error);
        }
    } catch (err) {
        console.error("Fetch WebUI URL error:", err);
    }
}

// 命令触发按钮
function triggerCommand(type) {
    const messages = {
        'restart': '确定平滑重启 OpenClaw 网关主进程吗？',
        'upgrade': '即将扫描 NPM 仓库并获取最新 OpenClaw 版本。',
        'shutdown': '⚠️ 危险：确定要离线系统吗？所有子代理将被中断。'
    };

    if (confirm(messages[type])) {
        if (type === 'restart') {
            fetch('/api/cmd/restart').then(res => res.json()).then(data => {
                const terminal = document.getElementById('terminal-output');
                terminal.innerHTML += `
                    <div class="log-line">
                        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                        <span class="log-warn">[COMMAND]</span>
                        <span style="color: var(--accent-orange)">Restart triggered. Success: ${data.success}</span>
                    </div>
                `;
                terminal.scrollTop = terminal.scrollHeight;
            });
        } else {
            const terminal = document.getElementById('terminal-output');
            terminal.innerHTML += `
                <div class="log-line">
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    <span class="log-warn">[COMMAND]</span>
                    <span style="color: var(--accent-orange)">Sent signal: ${type.toUpperCase()}</span>
                </div>
            `;
            terminal.scrollTop = terminal.scrollHeight;
        }
    }
}



// 真实日志轮询（替代虚假序列）
function simulateLogs() {
    const terminal = document.getElementById('terminal-output');

    // 首次加载展示 main 的日志
    const loadInitialLogs = async () => {
        try {
            const defaultAgent = (agentsData.length > 0 && agentsData.find(a => a.status === 'working')) || agentsData[0];
            const agentId = defaultAgent ? defaultAgent.id : 'main';
            const res = await fetch(`/api/agent-logs?id=${agentId}&limit=8`);
            const data = await res.json();
            if (data.logs && data.logs.length > 0) {
                terminal.innerHTML = '';
                const levelMap = { user: 'log-agent', assistant: 'log-success', tool: 'log-info', error: 'log-error' };
                data.logs.forEach(log => {
                    const cls = levelMap[log.level] || 'log-info';
                    const icon = { user: '👤', assistant: '🤖', tool: '🔧', error: '❌' }[log.level] || 'ℹ️';
                    const line = document.createElement('div');
                    line.className = 'log-line';
                    line.innerHTML = `
                        <span class="log-time">[${log.time}]</span>
                        <span class="${cls}">${icon} [${agentId}]</span>
                        <span style="word-break:break-word">${escapeHtml(log.text)}</span>
                    `;
                    terminal.appendChild(line);
                });
                terminal.scrollTop = terminal.scrollHeight;
            }
        } catch (e) { /* silently fail on initial load */ }
    };

    loadInitialLogs();
    // 每 15 秒自动刷新最活跃的 agent 日志
    setInterval(async () => {
        await fetchAgentsData();
        const workingAgent = agentsData.find(a => a.status === 'working') || agentsData[0];
        if (workingAgent) await viewAgentLogs(workingAgent.id);
    }, 15000);
}
