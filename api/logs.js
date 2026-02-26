module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Simple auth: require LOGS_SECRET as Bearer token
    const auth = req.headers.authorization || '';
    const secret = process.env.LOGS_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const redisUrl = process.env.UPSTASH_REDIS_URL;
    const redisToken = process.env.UPSTASH_REDIS_TOKEN;
    if (!redisUrl || !redisToken) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    const headers = {
        'Authorization': `Bearer ${redisToken}`,
        'Content-Type': 'application/json'
    };

    try {
        const { sessionId } = req.query;

        if (sessionId) {
            // Get messages for a specific session
            const resp = await fetch(`${redisUrl}/lrange/chat:${sessionId}/0/-1`, { headers });
            const json = await resp.json();
            const messages = (json.result || []).map(m => JSON.parse(m));
            return res.status(200).json({ sessionId, messages });
        }

        // List all sessions (most recent first)
        const limit = parseInt(req.query.limit) || 50;
        const resp = await fetch(`${redisUrl}/zrevrange/chat:sessions/0/${limit - 1}/WITHSCORES`, { headers });
        const json = await resp.json();
        const raw = json.result || [];

        // Parse pairs: [sessionId, score, sessionId, score, ...]
        const sessions = [];
        for (let i = 0; i < raw.length; i += 2) {
            sessions.push({
                sessionId: raw[i],
                lastActive: new Date(parseInt(raw[i + 1])).toISOString()
            });
        }

        return res.status(200).json({ total: sessions.length, sessions });
    } catch (err) {
        console.error('Logs error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
