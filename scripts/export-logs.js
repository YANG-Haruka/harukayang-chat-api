/**
 * Export chat logs from Upstash Redis, one file per session
 *
 * Usage:
 *   node scripts/export-logs.js <API_BASE> <LOGS_SECRET>
 *
 * Output structure:
 *   logs/
 *     sessions/
 *       2026-02-26_mm3ewog8vwi4yn.json   (per-session file)
 *       2026-02-26_abc123def456.json
 *     summary.json                         (all sessions overview)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = process.argv[2];
const SECRET = process.argv[3];
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const SESSIONS_DIR = path.join(LOGS_DIR, 'sessions');

if (!API_BASE || !SECRET) {
    console.error('Usage: node scripts/export-logs.js <API_BASE> <LOGS_SECRET>');
    process.exit(1);
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Authorization': `Bearer ${SECRET}` } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
    });
}

async function main() {
    // Ensure directories exist
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    console.log('Fetching session list...');
    const list = await fetchJSON(`${API_BASE}/api/logs?limit=9999`);

    if (!list.sessions || list.sessions.length === 0) {
        console.log('No sessions found.');
        return;
    }

    console.log(`Found ${list.sessions.length} sessions. Exporting...\n`);

    const summary = [];
    let totalMsgs = 0;
    let newCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < list.sessions.length; i++) {
        const session = list.sessions[i];
        const date = session.lastActive.slice(0, 10);
        const filename = `${date}_${session.sessionId}.json`;
        const filepath = path.join(SESSIONS_DIR, filename);

        const detail = await fetchJSON(`${API_BASE}/api/logs?sessionId=${session.sessionId}`);
        const messages = detail.messages || [];
        const msgCount = messages.length;
        totalMsgs += msgCount;

        // Check if file already exists with same message count (skip if unchanged)
        let isNew = true;
        if (fs.existsSync(filepath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
                if (existing.messages && existing.messages.length === msgCount) {
                    isNew = false; // unchanged, skip write
                } else {
                    updatedCount++;
                }
            } catch (e) { updatedCount++; }
        } else {
            newCount++;
        }

        if (isNew) {
            const data = {
                sessionId: session.sessionId,
                lastActive: session.lastActive,
                messageCount: msgCount,
                messages: messages
            };
            fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
        }

        summary.push({
            sessionId: session.sessionId,
            lastActive: session.lastActive,
            messageCount: msgCount,
            file: `sessions/${filename}`
        });

        process.stdout.write(`  ${i + 1}/${list.sessions.length}\r`);
    }

    // Write summary
    fs.writeFileSync(
        path.join(LOGS_DIR, 'summary.json'),
        JSON.stringify({ exportedAt: new Date().toISOString(), total: summary.length, totalMessages: totalMsgs, sessions: summary }, null, 2),
        'utf-8'
    );

    console.log(`\nDone!`);
    console.log(`  Sessions: ${summary.length} (${newCount} new, ${updatedCount} updated)`);
    console.log(`  Messages: ${totalMsgs}`);
    console.log(`  Output:   ${LOGS_DIR}`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
