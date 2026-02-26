/**
 * Export all chat logs from Upstash Redis to a local JSON file
 *
 * Usage:
 *   node scripts/export-logs.js <API_BASE> <LOGS_SECRET> [output_file]
 *
 * Example:
 *   node scripts/export-logs.js https://harukayang-chat-api.vercel.app your_secret chat-logs.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = process.argv[2];
const SECRET = process.argv[3];
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const OUTPUT = process.argv[4] || path.join(LOGS_DIR, `chat-logs-${new Date().toISOString().slice(0, 10)}.json`);

if (!API_BASE || !SECRET) {
    console.error('Usage: node scripts/export-logs.js <API_BASE> <LOGS_SECRET> [output_file]');
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
    console.log('Fetching session list...');
    const list = await fetchJSON(`${API_BASE}/api/logs?limit=9999`);

    if (!list.sessions || list.sessions.length === 0) {
        console.log('No sessions found.');
        return;
    }

    console.log(`Found ${list.sessions.length} sessions. Fetching details...`);

    const allLogs = [];
    for (const session of list.sessions) {
        const detail = await fetchJSON(`${API_BASE}/api/logs?sessionId=${session.sessionId}`);
        allLogs.push({
            sessionId: session.sessionId,
            lastActive: session.lastActive,
            messages: detail.messages || []
        });
        process.stdout.write(`  ${allLogs.length}/${list.sessions.length}\r`);
    }

    fs.writeFileSync(OUTPUT, JSON.stringify(allLogs, null, 2), 'utf-8');
    console.log(`\nExported ${allLogs.length} sessions to ${OUTPUT}`);

    // Print summary
    let totalMsgs = 0;
    for (const log of allLogs) totalMsgs += log.messages.length;
    console.log(`Total messages: ${totalMsgs}`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
