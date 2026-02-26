const fs = require('fs');
const path = require('path');

// Load static knowledge files
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

// Save chat round to Upstash Redis
async function saveChatLog(sessionId, userMsg, botReply) {
    const url = process.env.UPSTASH_REDIS_URL;
    const token = process.env.UPSTASH_REDIS_TOKEN;
    if (!url || !token || !sessionId) return;

    const ts = Date.now();
    const key = `chat:${sessionId}`;
    try {
        await fetch(`${url}/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([
                ['RPUSH', key, JSON.stringify({ role: 'user', content: userMsg, ts })],
                ['RPUSH', key, JSON.stringify({ role: 'assistant', content: botReply, ts })],
                ['ZADD', 'chat:sessions', ts, sessionId],
                ['PERSIST', key]  // keep forever
            ])
        });
    } catch (err) {
        console.error('Redis log error:', err);
    }
}

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

        return results
            .filter(r => r.score > 0.5)
            .map(r => r.data)
            .join('\n\n');
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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message, history, sessionId } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'message is required' });
    }

    // Check env vars
    if (!process.env.DEEPSEEK_API_KEY) {
        console.error('DEEPSEEK_API_KEY not set');
        return res.status(500).json({ error: 'Server config error' });
    }

    // RAG: retrieve relevant chat examples
    const ragContext = await queryRAG(message);

    // Build messages array
    const messages = [
        { role: 'system', content: buildSystemPrompt(ragContext) }
    ];

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
            const errText = await response.text();
            console.error('DeepSeek error:', response.status, errText);
            return res.status(502).json({ error: 'AI service error', detail: errText });
        }

        // Stream SSE to client using Node.js compatible approach
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Forward chunks to client while capturing full reply
        let fullReply = '';
        for await (const chunk of response.body) {
            const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
            res.write(text);

            // Parse SSE to capture reply text
            const lines = text.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(dataStr);
                    const delta = data.choices && data.choices[0] && data.choices[0].delta;
                    if (delta && delta.content) fullReply += delta.content;
                } catch (e) {}
            }
        }

        res.write('data: [DONE]\n\n');

        // Save chat log to Redis before ending response
        if (fullReply) {
            await saveChatLog(sessionId, message, fullReply);
        }

        res.end();
    } catch (err) {
        console.error('Chat error:', err.message || err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        } else {
            res.end();
        }
    }
};
