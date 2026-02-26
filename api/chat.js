const fs = require('fs');
const path = require('path');

// Load static knowledge files (persona, contact, projects)
function loadKnowledge() {
    const dir = path.join(__dirname, '..', 'knowledge');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
    const sections = [];
    for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
        if (content) sections.push(content);
    }
    return sections.join('\n\n---\n\n');
}

const knowledgeText = loadKnowledge();

// Query Upstash Vector for relevant chat examples
async function queryRAG(message) {
    const url = process.env.UPSTASH_VECTOR_URL;
    const token = process.env.UPSTASH_VECTOR_TOKEN;

    if (!url || !token) return '';

    try {
        const resp = await fetch(`${url}/query-data`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: message,
                topK: 5,
                includeData: true,
                includeMetadata: true
            })
        });

        if (!resp.ok) return '';

        const json = await resp.json();
        const results = json.result || [];

        if (results.length === 0) return '';

        const context = results
            .filter(r => r.score > 0.5)
            .map(r => r.data)
            .join('\n\n');

        return context;
    } catch (err) {
        console.error('RAG query error:', err);
        return '';
    }
}

function buildSystemPrompt(ragContext) {
    let prompt = knowledgeText;

    if (ragContext) {
        prompt += `\n\n---\n\n## 以下是你过去类似场景的聊天记录，请参考这些来保持一致的语气和风格：\n\n${ragContext}`;
    }

    prompt += `\n\n## 知识库使用规则
- 上面的信息是你的背景知识和人设，回复时自然融入，不要生硬罗列
- 参考历史聊天记录的语气和风格来回复，但不要复制粘贴原文
- 被问到相关内容时准确回答，不知道的就说不知道
- 保持你的聊天风格，短、碎、快`;

    return prompt;
}

module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message, history } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'message is required' });
    }

    // RAG: retrieve relevant chat examples
    const ragContext = await queryRAG(message);

    // Build messages array
    const messages = [
        { role: 'system', content: buildSystemPrompt(ragContext) }
    ];

    // Append conversation history
    if (Array.isArray(history)) {
        const recent = history.slice(-10);
        for (const h of recent) {
            messages.push({ role: h.role, content: h.content });
        }
    }

    messages.push({ role: 'user', content: message });

    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: messages,
                max_tokens: 600,
                temperature: 0.9,
                stream: true
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('DeepSeek API error:', err);
            return res.status(502).json({ error: 'AI service error' });
        }

        // Stream SSE to client
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                res.write('data: [DONE]\n\n');
                break;
            }
            res.write(decoder.decode(value, { stream: true }));
        }

        res.end();
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};
