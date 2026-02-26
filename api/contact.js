module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { message } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    if (!process.env.RESEND_API_KEY) {
        console.error('RESEND_API_KEY not set');
        return res.status(500).json({ error: 'Server config error' });
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' });
    const ua = req.headers['user-agent'] || 'Unknown';

    try {
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Chat Bot <onboarding@resend.dev>',
                to: 'yjz.haruka@gmail.com',
                subject: `[网站留言] 来自 harukayang.com 的新消息`,
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <h2 style="color:#4fc3f7;border-bottom:1px solid #eee;padding-bottom:10px;">📬 新的网站留言</h2>
                        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0;white-space:pre-wrap;line-height:1.6;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                        <div style="color:#999;font-size:12px;margin-top:20px;">
                            <p>时间：${now}（东京时间）</p>
                            <p>UA：${ua}</p>
                        </div>
                    </div>
                `
            })
        });

        if (!resp.ok) {
            const err = await resp.text();
            console.error('Resend error:', resp.status, err);
            return res.status(502).json({ error: 'Email send failed' });
        }

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Contact error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};
