// /home/jason/.openclaw/dashboard/app.js

const i18n = {
    'zh': {
        app_title: 'OpenClaw Hub',
        gateway_port: '网关端口',
        uptime: '运行时长',
        active: '活跃中',
        quick_control: '快速控制',
        restart_gateway: '重启 OpenClaw',
        start_gateway: '启动 OpenClaw',
        check_upgrade: '检查版本升级',
        stop_service: '停止服务',
        doctor_fix: '故障修复 (Doctor)',
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
        active: 'Active',
        quick_control: 'Quick Controls',
        restart_gateway: 'Restart OpenClaw',
        start_gateway: 'Start OpenClaw',
        check_upgrade: 'Check for Updates',
        stop_service: 'Stop Service',
        doctor_fix: 'Repair Config (Doctor)',
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
let visionModels = new Set();
let agentsData = [];
let localModelsData = [];

// 拉取系统健康状态（CPU, 内存, 磁盘, Agent活跃）
async function fetchSysHealth() {
    try {
        const res = await fetch('/api/sys-health');
        const portDisplay = document.getElementById('gatewayPortDisplay');

        const data = await res.json();
        const isOnline = !!data.port && data.isAlive;

        if (portDisplay) {
            if (isOnline) {
                portDisplay.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>${data.port} 活跃中</span>`;
                portDisplay.style.color = "var(--accent-green)";
            } else {
                portDisplay.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> <span style="color:var(--accent-red)">Offline (未检测到网关)</span>`;
                portDisplay.style.color = "var(--accent-red)";
            }
        }

        if (data.uptime !== undefined) {
            const up = data.uptime;
            if (up === 0 && !isOnline) {
                document.getElementById('uptimeDisplay').innerText = `已停止`;
            } else {
                const d = Math.floor(up / (3600 * 24));
                const h = Math.floor(up % (3600 * 24) / 3600);
                const m = Math.floor(up % 3600 / 60);
                document.getElementById('uptimeDisplay').innerText = `${d}d ${h}h ${m}m`;
            }
        }

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

// \u521d\u59cb\u5316
document.addEventListener('DOMContentLoaded', async () => {
    initThemeAndLang();

    // MUST wait for providers to load to populate localModelsData
    await loadProviders();

    // Now safe to fetch agents and render them
    await fetchSandboxLevel();
    await fetchSysHealth();
    await fetchAgentsData();

    simulateLogs();
    setupTerminalActions();

    setInterval(() => {
        fetchAgentsData();
        fetchSysHealth();
    }, 5000); // \u6bcf 5 \u79d2\u5237\u65b0\u4e00\u6b21\u7cfb\u7edf\u72b6\u6001\u548c\u4ee3\u7406\u72b6\u6001
});

function initThemeAndLang() {
    const savedTheme = localStorage.getItem('openclaw_theme');
    if (savedTheme === 'light') {
        isLightMode = true;
        document.body.classList.add('light-mode');
        document.querySelector('#theme-toggle i').className = 'fas fa-sun';
    }

    document.getElementById('theme-toggle').addEventListener('click', () => {
        isLightMode = !isLightMode;
        if (isLightMode) {
            document.body.classList.add('light-mode');
            document.querySelector('#theme-toggle i').className = 'fas fa-sun';
            localStorage.setItem('openclaw_theme', 'light');
        } else {
            document.body.classList.remove('light-mode');
            document.querySelector('#theme-toggle i').className = 'fas fa-moon';
            localStorage.setItem('openclaw_theme', 'dark');
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
                    const fullId = `${pname}/${id}`;
                    localModelsData.push(fullId);
                    if (typeof m === 'object' && (m.isVision || (m.input && m.input.includes('image')))) {
                        visionModels.add(fullId);
                    }
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
                    <div style="display:flex; gap:8px; margin-top: 8px">
                        <button class="discovery-btn" style="flex:2; justify-content:center; padding: 6px; font-size: 0.8rem; white-space: nowrap;" onclick="discoverModelsForProvider('${pname}')"><i class="fa-solid fa-list-check"></i> <span>模型管理</span></button>
                        <button class="cmd-btn" style="flex:1; padding: 6px; font-size: 0.8rem; white-space: nowrap; border-color: rgba(239, 68, 68, 0.4); color: var(--accent-red);" onclick="deleteProviderConfig('${pname}')"><i class="fa-solid fa-trash"></i> <span>删除</span></button>
                    </div>
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
    const pKey = document.getElementById('new-provider-key').value.trim();
    
    // 增加数据校验
    if (!pName) {
        alert("请输入供应商名称 (Provider Name)！");
        return;
    }
    if (!pKey) {
        alert("请输入有效的 API Key！");
        return;
    }

    try {
        const resp = await fetch('/api/add-provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providerName: pName,
                baseUrl: pUrl,
                apiKey: pKey,
                apiType: 'openai-completions'
            })
        });
        if (!resp.ok) {
            const errText = await resp.text();
            alert(`创建失败: ${errText || resp.status}`);
            return;
        }
        document.getElementById('add-provider-modal').style.display = 'none';
        await loadProviders();
        // DOM 在 loadProviders 渲染后才可安全访问
        const newBox = document.getElementById(`provider-box-${pName}`);
        if (newBox) newBox.classList.add('active');
    } catch (e) {
        console.error("Add provider failed", e);
        alert("请求失败，请检查网络连接或服务器状态。");
    }
}

async function testProviderConn() {
    const pUrl = document.getElementById('new-provider-url').value.trim() || 'https://api.openai.com/v1';
    const pKey = document.getElementById('new-provider-key').value.trim();
    const btn = document.getElementById('btn-test-conn');

    if (!pKey) {
        alert("请输入 API Key");
        return;
    }

    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
    btn.disabled = true;

    try {
        const urlToHit = pUrl.endsWith('/') ? `${pUrl}models` : `${pUrl}/models`;
        const res = await fetch(urlToHit, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${pKey}` }
        });
        if (res.ok) {
            btn.innerHTML = '<i class="fa-solid fa-check" style="color:var(--accent-green)"></i> 成功';
        } else {
            console.error("Connection test failed:", res.status, res.statusText);
            btn.innerHTML = '<i class="fa-solid fa-xmark" style="color:var(--accent-red)"></i> 失败';
        }
    } catch (e) {
        console.error("Connection test error:", e);
        btn.innerHTML = '<i class="fa-solid fa-xmark" style="color:var(--accent-red)"></i> 失败';
    }

    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }, 3000);
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
    currentProviderForModels = pName;
    const p = providersData[pName];
    if (!p) return;

    transferState.left = (p.models || []).map(m => {
        if (typeof m === 'string') return { id: m, name: m, api: p.api || 'openai-completions' };
        return m;
    });
    transferState.right = [];

    document.getElementById('left-search').value = '';
    document.getElementById('right-search').value = '';

    document.getElementById('right-list').innerHTML = `<div style="text-align:center;color:var(--text-secondary);margin-top:20px;">点击右侧上方按钮探测加载远程模型<br><span style="font-size:0.75rem;">(API 请求可能需要时间)</span></div>`;
    renderTransfer(true);
    document.getElementById('model-select-modal').style.display = 'block';
}

async function probeRemoteModels() {
    if (!currentProviderForModels) return;
    const btn = document.getElementById('btn-probe-models');
    const rightList = document.getElementById('right-list');
    if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 探测中...`;
    rightList.innerHTML = `<div style="text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> 正在向远程接口请求...</div>`;

    try {
        const res = await fetch(`/api/discover-models?provider=${encodeURIComponent(currentProviderForModels)}`);
        const data = await res.json();
        const apiModels = data.api_models || [];

        const leftIds = transferState.left.map(m => m.id);
        transferState.right = apiModels.filter(m => !leftIds.includes(m.id));
        renderTransfer();

        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `
            <div class="log-line">
                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-success">[DISCOVERY]</span>
                <span>${apiModels.length} models probe done for ${currentProviderForModels}.</span>
            </div>
        `;
        terminal.scrollTop = terminal.scrollHeight;
    } catch (e) {
        rightList.innerHTML = `<div style="color:var(--accent-red);text-align:center;"><i class="fa-solid fa-triangle-exclamation"></i> 探测失败</div>`;
    } finally {
        if (btn) btn.innerHTML = `<i class="fa-solid fa-radar"></i> 探测`;
    }
}

function renderTransfer(skipRight = false) {
    ['left', 'right'].forEach(side => {
        if (side === 'right' && skipRight) return;

        const query = (document.getElementById(`${side}-search`).value || '').toLowerCase();
        const container = document.getElementById(`${side}-list`);

        // 过滤
        const filtered = transferState[side].filter(m => {
            return m.id.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query));
        });

        container.innerHTML = '';
        filtered.forEach(m => {
            let isVisionChecked = '';
            // Only left side models have the capability to be modified for Vision.
            if (side === 'left') {
                const hasVision = m.isVision || (m.input && m.input.includes('image'));
                isVisionChecked = hasVision ? 'checked' : '';

                container.innerHTML += `
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; padding-right:8px; border-radius:4px; max-width: 100%;" class="model-item-hover">
                        <label style="display:flex; align-items:center; gap: 8px; cursor:pointer; overflow:hidden; white-space:nowrap; flex:1;" class="model-cb-label" title="${m.id}">
                            <input type="checkbox" value="${m.id}" class="model-cb-${side}" style="flex-shrink:0;">
                            <span style="overflow:hidden; text-overflow:ellipsis; display:inline-block; max-width:180px; vertical-align:middle;">${m.id}</span>
                        </label>
                        <label style="display:flex; align-items:center; gap:4px; font-size:0.75rem; cursor:pointer; flex-shrink:0;" title="勾选以声明此模型支持图片识别等多模态能力">
                            <input type="checkbox" onchange="toggleVision('${m.id}', this.checked)" ${isVisionChecked}>
                            <i class="fa-solid fa-eye" style="color:${isVisionChecked ? 'var(--accent-blue)' : 'var(--text-secondary)'}"></i> Vision
                        </label>
                    </div>
                `;
            } else {
                container.innerHTML += `
                    <label style="display:flex; align-items:center; gap: 8px; margin-bottom:6px; cursor:pointer; max-width: 100%; overflow:hidden; white-space:nowrap;" class="model-cb-label" title="${m.id}">
                        <input type="checkbox" value="${m.id}" class="model-cb-${side}" style="flex-shrink:0;">
                        <span style="overflow:hidden; text-overflow:ellipsis; display:inline-block; max-width:300px; vertical-align:middle;">${m.id}</span>
                    </label>
                `;
            }
        });
    });
}

function toggleVision(modelId, isChecked) {
    const target = transferState.left.find(m => m.id === modelId);
    if (target) {
        target.isVision = isChecked;
        if (!target.input) target.input = ["text"];

        if (isChecked && !target.input.includes('image')) {
            target.input.push('image');
        } else if (!isChecked && target.input.includes('image')) {
            target.input = target.input.filter(i => i !== 'image');
        }
        renderTransfer(); // re-render to update the eye icon color
    }
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
        renderAgentGrid(); // Refresh dropdowns immediately
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
        const data = await res.json();
        if (!res.ok) {
            console.error("Failed to load agents from API:", data.error);
            return;
        }
        agentsData = data;
        renderAgentGrid();
    } catch (e) {
        console.error("Failed to load agents from API", e);
    }
}

// Sandbox status interactions
let currentSandboxLevel = 'full';
async function fetchSandboxLevel() {
    try {
        const res = await fetch('/api/sandbox');
        if (!res.ok) return;
        const data = await res.json();
        currentSandboxLevel = data.level;
        updateSandboxBtn();
    } catch (e) { }
}

function updateSandboxBtn() {
    const el = document.getElementById('sandbox-status-text');
    if (el) {
        if (currentSandboxLevel === 'deny') {
            el.innerText = '沙箱模式: 已关闭(危险, deny)';
            el.style.color = 'var(--accent-red)';
        } else if (currentSandboxLevel === 'allowlist') {
            el.innerText = '沙箱模式: 白名单(allowlist)';
            el.style.color = 'var(--accent-orange)';
        } else {
            el.innerText = `沙箱模式: Full(安全)`;
            el.style.color = '';
        }
    }
    // Update Modal active Button
    document.querySelectorAll('#sandbox-modal .cmd-btn').forEach(b => {
        b.style.background = '';
    });
    const activeBtn = document.getElementById(`sb-btn-${currentSandboxLevel}`);
    if (activeBtn) {
        activeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    }
}

window.setSandboxLevel = function (level) {
    if (level === currentSandboxLevel) return;
    if (level === 'deny') {
        if (!confirm('确定要彻底关闭沙箱吗？这将允许 Agent 在主机上自由执行任意代码，极其危险！')) return;
    }
    fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level })
    }).then(r => r.json()).then(d => {
        currentSandboxLevel = d.level;
        updateSandboxBtn();
        document.getElementById('sb-restart-prompt').style.display = 'block';

        const terminal = document.getElementById('terminal-output');
        terminal.innerHTML += `<div class="log-line"><span class="log-time">[${new Date().toLocaleTimeString()}]</span><span class="log-warn">[SECURITY]</span><span>沙箱模式被修改为: ${level}，等待重启生效。</span></div>`;
        terminal.scrollTop = terminal.scrollHeight;
    }).catch(e => console.error(e));
};

window.toggleAgentDesc = function (agentId) {
    const agent = agentsData.find(a => a.id === agentId);
    if (!agent) return;

    document.getElementById('agent-desc-title').innerHTML = `<i class="fa-solid fa-robot"></i> <b>${agent.name || agent.id}</b> 设定 & 介绍`;
    document.getElementById('agent-desc-content').innerHTML = `<i>正在加载此 Agent 的 SOUL.md 描述...</i>`;
    document.getElementById('agent-desc-modal').style.display = 'block';

    fetch(`/api/agent-detail?id=${agentId}`)
        .then(res => res.json())
        .then(data => {
            if (data.description) {
                // If showdown exists, parse it
                if (window.showdown) {
                    const converter = new showdown.Converter();
                    document.getElementById('agent-desc-content').innerHTML = converter.makeHtml(data.description);
                } else {
                    document.getElementById('agent-desc-content').innerText = data.description;
                }
            } else {
                document.getElementById('agent-desc-content').innerText = '该 Agent 暂无详细描述信息或未创建 SOUL.md 文件。';
            }
        })
        .catch(e => {
            console.error('Failed to fetch agent details:', e);
            document.getElementById('agent-desc-content').innerText = '获取 Agent 描述失败，请检查控制台或者网络。';
        });
};

// \u6e32\u67d3\u4ee3\u7406\u5361\u7247\uff08\u589e\u91cf DOM \u66f4\u65b0\uff0c\u9632\u6b62\u5237\u65b0\u6253\u65ad\u7126\u70b9\uff09
function renderAgentGrid() {
    const grid = document.getElementById('agent-grid');
    if (!grid) return;

    // --- 动态渲染终端标签页为下拉菜单 ---
    const tabContainer = document.querySelector('.terminal-tabs');
    if (tabContainer) {
        // 构建下拉菜单
        let selectHtml = `<select id="agent-log-select" class="model-selector" style="max-width: 250px;">`;
        selectHtml += `<option value="system" ${currentLogAgentId === null ? 'selected' : ''}>System Logs (app.log)</option>`;
        
        agentsData.forEach(agent => {
             selectHtml += `<option value="${agent.id}" ${currentLogAgentId === agent.id ? 'selected' : ''}>Agent: ${agent.name || agent.id}</option>`;
        });
        selectHtml += `</select>`;
        
        tabContainer.innerHTML = selectHtml;
        
        // 绑定切换事件
        const selectEl = document.getElementById('agent-log-select');
        selectEl.onchange = (e) => {
            const agentId = e.target.value;
            if (agentId !== 'system') {
                viewAgentLogs(agentId);
            } else {
                currentLogAgentId = null;
                document.getElementById('terminal-output').innerHTML = `<div class="log-line"><span class="log-info">[SYSTEM]</span><span>正在开发系统全局日志查看功能...</span></div>`;
            }
        };
    }

    let optionList = localModelsData.length > 0 ? localModelsData : (agentsData.map(a => a.model).filter(Boolean));
    const uniqueOptions = [...new Set(optionList)];

    agentsData.forEach(agent => {
        let card = document.getElementById(`agent-card-${agent.id}`);

        let hasSelectedOption = false;
        let optionsHtml = uniqueOptions.map(model => {
            const modelId = typeof model === 'object' ? model.id : model;
            const isVision = visionModels.has(modelId);
            const eyeIcon = isVision ? ' 👁️' : '';
            if (typeof model === 'string') {
                const isSelected = agent.model === model;
                if (isSelected) hasSelectedOption = true;
                return `<option value="${model}" ${isSelected ? 'selected' : ''}>${model}${eyeIcon}</option>`;
            } else if (model.id) {
                const isSelected = agent.model === model.id;
                if (isSelected) hasSelectedOption = true;
                return `<option value="${model.id}" ${isSelected ? 'selected' : ''}>${model.id}${eyeIcon}</option>`;
            }
            return '';
        }).join('');

        if (agent.model && !hasSelectedOption) {
            optionsHtml = `<option value="${agent.model}" selected>${agent.model} (\u672a\u5728\u4f9b\u5e94\u5546\u5217\u8868\u4e2d)</option>` + optionsHtml;
        }

        const statusBadge = agent.status === 'working'
            ? `<span style="font-size:0.7rem; background:rgba(16,185,129,0.2); color:var(--accent-green); padding:2px 6px; border-radius:4px; border:1px solid rgba(16,185,129,0.3)">\u25cf \u8fd0\u884c\u4e2d</span>`
            : `<span style="font-size:0.7rem; background:rgba(100,100,100,0.15); color:var(--text-secondary); padding:2px 6px; border-radius:4px">\u25cb \u5f85\u673a</span>`;

        const tokenBadge = agent.token_usage > 0
            ? `<span title="本次会话累计 Token 用量（一个 Token 大约是半个汉字或 3/4 个英文单词）" style="font-size:0.7rem; color:var(--accent-blue); cursor:help">📊 ${agent.token_usage.toLocaleString()} Tokens</span>`
            : '';

        const latestTimeRaw = (() => { try { return new Date(agent.last_activity).toLocaleString(); } catch (e) { return ''; } })();
        const ActionText = agent.latest_action ? agent.latest_action.slice(0, 42) + (agent.latest_action.length > 42 ? '...' : '') : '';

        // 如果卡片不存在，则创建
        if (!card) {
            // 新建卡片时：若 agent 没有设置模型，自动选中第一个可用模型作为默认值
            let effectiveModel = agent.model;
            if (!hasSelectedOption && uniqueOptions.length > 0) {
                const firstOpt = uniqueOptions[0];
                effectiveModel = typeof firstOpt === 'object' ? firstOpt.id : firstOpt;
                // 将首个选项标记为 selected
                optionsHtml = uniqueOptions.map((model, idx) => {
                    const modelId = typeof model === 'object' ? model.id : model;
                    const isVision = visionModels.has(modelId);
                    const eyeIcon = isVision ? ' 👁️' : '';
                    const isSelected = idx === 0;
                    return `<option value="${modelId}" ${isSelected ? 'selected' : ''}>${modelId}${eyeIcon}</option>`;
                }).join('');

                // If a new model was auto-selected, update the agent's model and save it
                if (effectiveModel !== agent.model) {
                    updateAgentModel(agent.id, effectiveModel);
                    agent.model = effectiveModel; // Update local agent data immediately
                }
            }

            card = document.createElement('div');
            card.className = 'agent-card';
            card.id = `agent-card-${agent.id}`;
            card.innerHTML = `
                <div style="display:flex; flex-direction:column; height:100%; gap:6px;">
                    <div class="agent-header" style="flex-shrink:0; cursor:pointer;" onclick="toggleAgentDesc('${agent.id}')" title="点击查看 Agent 介绍">
                        <div class="agent-name">
                            <i class="fa-solid fa-robot" style="color: var(--text-secondary)"></i>
                            ${agent.name || agent.id} <i class="fa-solid fa-circle-info" style="font-size: 0.7rem; color: var(--text-secondary); margin-left: 4px;"></i>
                        </div>
                        <div id="orb-${agent.id}" class="status-orb ${agent.status === 'working' ? 'active' : ''}" title="${agent.status}"></div>
                    </div>

                    <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;" id="badges-${agent.id}">
                        ${statusBadge}
                        ${tokenBadge}
                    </div>

                    <div id="latest-action-${agent.id}" style="font-size:0.7rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; min-height:1rem;" ${agent.latest_action ? `title="${agent.latest_action}" onclick="viewAgentLogs('${agent.id}')" style="cursor:pointer;"` : ''}>
                        ${agent.latest_action ? `\ud83d\udd04 ${ActionText}` : ''}
                    </div>

                    <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:4px; min-height:0;">
                        <label style="font-size:0.72rem; color:var(--text-secondary);">AI \u6838\u5fc3\u6a21\u578b\uff1a</label>
                        <div style="display:flex; gap:4px;">
                            <select class="model-selector" id="agent-mdl-${agent.id}" style="flex:1; font-size:0.78rem; padding:4px 8px;">
                                ${optionsHtml}
                            </select>
                            <button class="save-btn" style="padding:4px 8px; font-size:0.72rem; white-space:nowrap;" onclick="updateAgentModel('${agent.id}', document.getElementById('agent-mdl-${agent.id}').value)">\u5e94\u7528</button>
                        </div>
                    </div>

                    <div style="display:flex; justify-content:flex-end; flex-shrink:0; padding-top:4px; border-top:1px solid rgba(255,255,255,0.05);">
                        <span style="color:var(--accent-blue); font-size:0.75rem; cursor:pointer;" onclick="viewAgentLogs('${agent.id}')">
                            <i class="fa-solid fa-terminal"></i> \u67e5\u770b\u65e5\u5fd7
                        </span>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        } else {
            // \u5982\u679c\u5df2\u5b58\u5728\uff0c\u4ec5 DOM \u589e\u91cf\u66f4\u65b0
            const orb = document.getElementById(`orb-${agent.id}`);
            if (orb) {
                orb.className = `status-orb ${agent.status === 'working' ? 'active' : ''}`;
                orb.title = agent.status;
            }

            const badges = document.getElementById(`badges-${agent.id}`);
            if (badges) badges.innerHTML = `${statusBadge}${tokenBadge}`;

            const latestAction = document.getElementById(`latest-action-${agent.id}`);
            if (latestAction) {
                latestAction.innerHTML = agent.latest_action ? `\ud83d\udd04 ${ActionText}` : '';
                agent.latest_action ? latestAction.setAttribute('title', agent.latest_action) : latestAction.removeAttribute('title');
                agent.latest_action ? latestAction.setAttribute('onclick', `viewAgentLogs('${agent.id}')`) : latestAction.removeAttribute('onclick');
                latestAction.style.cursor = agent.latest_action ? 'pointer' : 'default';
            }

            // 除非 select 当前没有焦点，否则不要去刷新 select 以免打断用户
            const selectEl = document.getElementById(`agent-mdl-${agent.id}`);
            if (selectEl && document.activeElement !== selectEl) {
                const currentVal = selectEl.value;
                // 当前值变了、选项为空、或选项数量有变化（新增/删除了模型）时才重新渲染
                if (currentVal !== agent.model || selectEl.innerHTML === '' || selectEl.options.length !== uniqueOptions.length) {
                    selectEl.innerHTML = optionsHtml;
                    selectEl.value = agent.model;
                }
            }
        }
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

let currentLogAgentId = null;
let autoScrollEnabled = true;
let seenLogsSet = new Set();

// 格式归一化：兼容 server.js 自定义格式 和 openclaw gateway 原生格式
function normalizeLogData(rawData, agentId) {
    // 格式1: { logs: [...], alerts: [...] } (server.js 自定义路由)
    if (rawData && !Array.isArray(rawData) && Array.isArray(rawData.logs)) {
        return rawData;
    }

    // 格式2: [ {type:"message", message:{role, content:[...]}, timestamp}, ... ]
    // (openclaw gateway 原生返回的 JSONL 行数组)
    const normalized = { logs: [], alerts: [] };
    if (!Array.isArray(rawData)) return normalized;

    rawData.forEach(item => {
        const ts = item.timestamp
            ? new Date(item.timestamp).toLocaleTimeString()
            : new Date().toLocaleTimeString();

        // 跳过 session 元数据行
        if (item.type === 'session') return;

        // 告警检测
        if (item.type === 'error') {
            const errMsg = (typeof item.message === 'string' ? item.message : '').toLowerCase();
            if (errMsg.includes('429') || errMsg.includes('rate')) normalized.alerts.push('rate_limit');
            if (errMsg.includes('401') || errMsg.includes('unauthorized')) normalized.alerts.push('auth_fail');
            if (errMsg.includes('timeout')) normalized.alerts.push('timeout');
        }

        // 解析消息：type=message, message={role, content}
        if (item.type === 'message' && item.message) {
            const msg = item.message;
            const role = msg.role || 'assistant';
            let text = '';

            if (typeof msg.content === 'string') {
                text = msg.content;
            } else if (Array.isArray(msg.content)) {
                msg.content.forEach(c => {
                    if (c.type === 'text' && c.text) text += c.text + ' ';
                    else if (c.type === 'toolCall') text += `[工具调用: ${c.name || ''}] `;
                    else if (c.type === 'toolResult') text += `[工具结果: ${c.toolName || ''}] `;
                });
            }

            if (text.trim()) {
                normalized.logs.push({
                    time: ts,
                    level: role,  // user, assistant, tool
                    text: text.trim().slice(0, 500)
                });
            }
        }

        // 工具结果
        if (item.type === 'toolResult') {
            const output = item.output ? String(item.output).slice(0, 300) : '[工具执行]';
            normalized.logs.push({
                time: ts,
                level: 'tool',
                text: `[${item.toolName || 'tool'}] ${output}`
            });
        }

        // 模型切换
        if (item.type === 'model_change') {
            normalized.logs.push({
                time: ts,
                level: 'tool',
                text: `模型切换: ${item.provider}/${item.modelId}`
            });
        }
    });

    return normalized;
}

async function viewAgentLogs(agentId, isInterval = false) {
    currentLogAgentId = agentId;
    const terminal = document.getElementById('terminal-output');

    if (!isInterval) {
        window.pauseTerminalUpdate = 0; // manually clicking "view logs" resumes polling immediately
        autoScrollEnabled = true;
        updateScrollLockIcon();
        // 主动切换 agent 时重置已读集合，确保日志能重新渲染
        seenLogsSet = new Set();
    }

    let baseHtml = `<div class="log-line">
            <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
            <span class="log-info">[SESSION LOGS]</span>
            <span>\u6b63\u5728\u4ece ${agentId} \u7684\u6700\u65b0\u4f1a\u8bdd\u4e2d\u52a0\u8f7d\u771f\u5b9e\u65e5\u5fd7...</span>
        </div>`;

    if (!isInterval) {
        terminal.innerHTML = baseHtml;
    }

    try {
        const res = await fetch(`/api/agent-logs?id=${agentId}&limit=12`);
        const rawData = await res.json();

        // --- 格式归一化：兼容两种后端返回格式 ---
        // 格式1: { logs: [...], alerts: [...] } (server.js 自定义路由)
        // 格式2: [ {type, message, ...}, ... ] (openclaw gateway 原生格式)
        const data = normalizeLogData(rawData, agentId);

        let newHtml = '';
        let hasNewLogs = false;

        // 展示告警 badges
        if (data.alerts && data.alerts.length > 0) {
            data.alerts.forEach(alert => {
                const alertKey = `${agentId}-alert-${alert}`;
                if (!seenLogsSet.has(alertKey)) {
                    seenLogsSet.add(alertKey);
                    const alertMap = { rate_limit: ['\ud83d\udfe1 限流告警 429', 'log-warn'], auth_fail: ['\ud83d\udd34 鉴权失败', 'log-error'], timeout: ['\ud83d\udfe0 超时', 'log-warn'] };
                    const [txt, cls] = alertMap[alert] || [alert, 'log-warn'];
                    newHtml += `<div class="log-line"><span class="log-time">[ALERT]</span><span class="${cls}">${txt}</span></div>`;
                    hasNewLogs = true;
                }
            });
        }

        if (data.logs && data.logs.length > 0) {
            const levelMap = { user: 'log-agent', assistant: 'log-success', tool: 'log-info', error: 'log-error' };
            data.logs.forEach(log => {
                const logText = log.text || '';
                const logTime = log.time || new Date().toLocaleTimeString();
                const logKey = `${agentId}-${logTime}-${logText.substring(0, 20)}`;
                if (!seenLogsSet.has(logKey)) {
                    seenLogsSet.add(logKey);
                    const cls = levelMap[log.level] || 'log-info';
                    const icon = { user: '\ud83d\udc64', assistant: '\ud83e\udd16', tool: '\ud83d\udd27', error: '\u274c' }[log.level] || '\u2139\ufe0f';
                    newHtml += `
                        <div class="log-line">
                            <span class="log-time">[${logTime}]</span>
                            <span class="${cls}">${icon} [${agentId}]</span>
                            <span style="word-break:break-word">${escapeHtml(logText)}</span>
                        </div>`;
                    hasNewLogs = true;
                }
            });
        }

        if (hasNewLogs) {
            const isAtBottom = (terminal.scrollHeight - terminal.scrollTop) <= (terminal.clientHeight + 20);
            terminal.innerHTML += newHtml;
            while (terminal.children.length > 300) {
                terminal.removeChild(terminal.firstElementChild);
            }
            if (autoScrollEnabled && isAtBottom) {
                terminal.scrollTop = terminal.scrollHeight;
            }
        } else if (!isInterval) {
            // 如果是手动点击且确实没数据，提示用户
            if (data.logs && data.logs.length === 0) {
                terminal.innerHTML = `<div class="log-line"><span class="log-time">[${new Date().toLocaleTimeString()}]</span><span class="log-info">[SESSION]</span><span>该 Agent 暂无活跃会话记录。</span></div>`;
            }
        }

    } catch (e) {
        if (!isInterval) {
            terminal.innerHTML += `<div class="log-line"><span class="log-error">[ERROR]\u65e5\u5fd7\u52a0\u8f7d\u5931\u8d25: ${e.message}</span></div>`;
        }
    }
}

function updateScrollLockIcon() {
    const icon = document.getElementById('scroll-lock');
    if (icon) {
        if (autoScrollEnabled) {
            icon.className = 'fa-solid fa-down-long';
            icon.style.color = 'var(--text-primary)';
            icon.title = 'Disable Auto-scroll';
        } else {
            icon.className = 'fa-solid fa-lock';
            icon.style.color = 'var(--accent-orange)';
            icon.title = 'Enable Auto-scroll';
        }
    }
}

function setupTerminalActions() {
    const terminal = document.getElementById('terminal-output');

    // Toggle Auto-Scroll
    const scrollLockBtn = document.getElementById('scroll-lock');
    if (scrollLockBtn) {
        scrollLockBtn.addEventListener('click', () => {
            autoScrollEnabled = !autoScrollEnabled;
            updateScrollLockIcon();
            if (autoScrollEnabled) terminal.scrollTop = terminal.scrollHeight;
        });
    }

    // Clear Logs
    const clearBtn = document.querySelector('.terminal-actions .fa-trash');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            terminal.innerHTML = `<div class="log-line"><span class="log-time">[${new Date().toLocaleTimeString()}]</span><span class="log-info">[SYSTEM]</span><span>Terminal cleared by user.</span></div>`;
            window.pauseTerminalUpdate = Date.now(); // pause briefly
        });
    }
    // Detect manual scrolling up to disable auto-scroll
    terminal.addEventListener('scroll', () => {
        const isAtBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 40;
        if (!isAtBottom && autoScrollEnabled) {
            autoScrollEnabled = false;
            updateScrollLockIcon();
        } else if (isAtBottom && !autoScrollEnabled) {
            autoScrollEnabled = true;
            updateScrollLockIcon();
        }
    });

    // --- 终端标签页由于已在 renderAgentGrid 中动态处理并绑定，此处仅保留原有逻辑 ---
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function openWebUI() {
    try {
        const res = await fetch('/api/webui-url');
        const data = await res.json();

        if (!data.url) {
            console.error("Failed to fetch WebUI URL:", data.error);
            return;
        }

        let targetUrl = data.url;
        const customDomain = localStorage.getItem('openclaw_custom_domain');

        if (customDomain) {
            let baseDomain = customDomain.trim();
            if (!/^https?:\/\//i.test(baseDomain)) {
                baseDomain = 'http://' + baseDomain;
            }
            try {
                const customUrlObj = new URL(baseDomain);
                const originalUrlObj = new URL(data.url);
                const token = originalUrlObj.searchParams.get('token');
                if (token) {
                    customUrlObj.searchParams.set('token', token);
                }
                targetUrl = customUrlObj.toString();
            } catch (e) {
                console.error("Invalid custom domain format:", e);
                targetUrl = baseDomain;
            }
        }

        window.open(targetUrl, '_blank');
    } catch (err) {
        console.error("Fetch WebUI URL error:", err);
    }
}

window.saveCustomDomain = function () {
    const val = document.getElementById('custom-domain-input').value.trim();
    if (val) {
        localStorage.setItem('openclaw_custom_domain', val);
    } else {
        localStorage.removeItem('openclaw_custom_domain');
    }
    document.getElementById('webui-modal').style.display = 'none';
};

// Initialize the input value in modal
document.addEventListener('DOMContentLoaded', () => {
    const customDomain = localStorage.getItem('openclaw_custom_domain');
    if (customDomain) {
        document.getElementById('custom-domain-input').value = customDomain;
    }
});

// 命令触发按钮
function triggerCommand(type) {
    window.pauseTerminalUpdate = Date.now(); // Pause normal log polling for 60s to read cmd output

    const messages = {
        'start': '确定要启动 OpenClaw 网关核心吗？',
        'restart': '确定平滑重启 OpenClaw 网关主进程吗？',
        'upgrade': '即将扫描 NPM 仓库并获取最新 OpenClaw 版本。',
        'shutdown': '⚠️ 危险：确定要离线系统吗？所有子代理将被中断。',
        'doctor_fix': '确定要执行 openclaw doctor --fix 进行配置修复吗？'
    };

    if (confirm(messages[type])) {
        if (type === 'start') {
            fetch('/api/cmd/start').then(res => res.json()).then(data => {
                const terminal = document.getElementById('terminal-output');
                terminal.innerHTML += `
                    <div class="log-line">
                        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                        <span class="log-success">[COMMAND]</span>
                        <span style="color: var(--accent-green)">Start triggered. Success: ${data.success}</span>
                    </div>
                `;
                terminal.scrollTop = terminal.scrollHeight;
            });
        } else if (type === 'restart') {
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
        } else if (type === 'upgrade') {
            const terminal = document.getElementById('terminal-output');
            terminal.innerHTML += `
                <div class="log-line">
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    <span class="log-info">[COMMAND]</span>
                    <span style="color: var(--accent-blue)">正在检查版本升级...</span>
                </div>
            `;
            terminal.scrollTop = terminal.scrollHeight;

            fetch('/api/cmd/upgrade').then(res => res.json()).then(data => {
                const terminal = document.getElementById('terminal-output');
                if (data.success) {
                    const lines = data.stdout.split('\\n');
                    lines.forEach(line => {
                        terminal.innerHTML += `
                            <div class="log-line">
                                <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                                <span class="log-info">[UPGRADE_CHK]</span>
                                <span style="white-space: pre-wrap; font-family: monospace;">${escapeHtml(line)}</span>
                            </div>
                        `;
                    });
                } else {
                    terminal.innerHTML += `
                        <div class="log-line">
                            <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                            <span class="log-error">[UPGRADE_CHK]</span>
                            <span style="color: var(--accent-red)">检查失败: ${escapeHtml(data.error)}</span>
                        </div>
                    `;
                }
                terminal.scrollTop = terminal.scrollHeight;
                window.pauseTerminalUpdate = Date.now();
            });
        } else if (type === 'doctor_fix') {
            const terminal = document.getElementById('terminal-output');
            terminal.innerHTML += `
                <div class="log-line">
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    <span class="log-info">[COMMAND]</span>
                    <span style="color: var(--accent-orange)">正在执行 openclaw doctor --fix，请稍候...</span>
                </div>
            `;
            terminal.scrollTop = terminal.scrollHeight;

            fetch('/api/cmd/doctor-fix').then(res => res.json()).then(data => {
                const terminal = document.getElementById('terminal-output');
                const outText = (data.stdout || '') + '\n' + (data.stderr || '');
                const lines = outText.split('\n').filter(l => l.trim() !== '');

                lines.forEach(line => {
                    terminal.innerHTML += `
                        <div class="log-line">
                            <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                            <span class="log-info">[DOCTOR_LOG]</span>
                            <span style="white-space: pre-wrap; font-family: monospace;">${escapeHtml(line)}</span>
                        </div>
                    `;
                });

                terminal.innerHTML += `
                    <div class="log-line">
                        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                        <span class="${data.success ? 'log-success' : 'log-error'}">[DOCTOR]</span>
                        <span style="color: ${data.success ? 'var(--accent-green)' : 'var(--accent-red)'}">
                            ${data.success ? '✅ 修复命令执行完成。' : '❌ 修复失败: ' + escapeHtml(data.error || '')}
                        </span>
                    </div>
                `;
                terminal.scrollTop = terminal.scrollHeight;
                window.pauseTerminalUpdate = Date.now(); // reset 60s pause after cmd ends
            }).catch(err => {
                const terminal = document.getElementById('terminal-output');
                terminal.innerHTML += `
                    <div class="log-line">
                        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                        <span class="log-error">[DOCTOR]</span>
                        <span style="color: var(--accent-red)">请求异常: ${escapeHtml(err.message)}</span>
                    </div>
                `;
                terminal.scrollTop = terminal.scrollHeight;
                window.pauseTerminalUpdate = Date.now();
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
            currentLogAgentId = agentId;
            const res = await fetch(`/api/agent-logs?id=${agentId}&limit=8`);
            const rawData = await res.json();
            const data = normalizeLogData(rawData, agentId);
            if (data.logs && data.logs.length > 0) {
                terminal.innerHTML = '';
                const levelMap = { user: 'log-agent', assistant: 'log-success', tool: 'log-info', error: 'log-error' };
                data.logs.forEach(log => {
                    const logText = log.text || '';
                    const logTime = log.time || '';
                    const logKey = `${agentId}-${logTime}-${logText.substring(0, 20)}`;
                    seenLogsSet.add(logKey);

                    const cls = levelMap[log.level] || 'log-info';
                    const icon = { user: '👤', assistant: '🤖', tool: '🔧', error: '❌' }[log.level] || 'ℹ️';
                    const line = document.createElement('div');
                    line.className = 'log-line';
                    line.innerHTML = `
                        <span class="log-time">[${logTime}]</span>
                        <span class="${cls}">${icon} [${agentId}]</span>
                        <span style="word-break:break-word">${escapeHtml(logText)}</span>
                    `;
                    terminal.appendChild(line);
                });
                terminal.scrollTop = terminal.scrollHeight;
            } else {
                terminal.innerHTML = `<div class="log-line"><span class="log-info">[SYSTEM]</span> <span>暂无 ${agentId} 的活跃历史日志。</span></div>`;
            }
        } catch (e) { /* silently fail on initial load */ }
    };

    loadInitialLogs();
    // 每 15 秒自动刷新显示的 agent 日志
    setInterval(async () => {
        await fetchAgentsData();
        if (window.pauseTerminalUpdate && Date.now() - window.pauseTerminalUpdate < 60000) {
            return;
        }

        if (!autoScrollEnabled) return;

        // 如果用户选定了某个 Agent，则只刷新该 Agent 的日志；否则刷新最活跃的。
        if (currentLogAgentId) {
            await viewAgentLogs(currentLogAgentId, true);
        } else {
            const workingAgent = agentsData.find(a => a.status === 'working') || agentsData[0];
            if (workingAgent) await viewAgentLogs(workingAgent.id, true);
        }
    }, 15000);
}
