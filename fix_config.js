const fs = require('fs');
const file = '/home/jason/.openclaw/openclaw.json';
let config;
try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
    console.error("无法读取配置", e);
    process.exit(1);
}

if (config.models && config.models.providers) {
    for (const pName in config.models.providers) {
        const p = config.models.providers[pName];
        if (p && Array.isArray(p.models)) {
            p.models = p.models.map(m => {
                if (typeof m === 'string') {
                    return {
                        id: m,
                        name: m,
                        api: p.api || 'openai-completions',
                        reasoning: false,
                        input: ['text'],
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

fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log("修复完成！所有的模型串都被成功转化为合法的对象结构。");
