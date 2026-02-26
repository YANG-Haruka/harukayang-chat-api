/**
 * Index WeChat chat data into Upstash Vector
 * Usage: UPSTASH_VECTOR_URL=xxx UPSTASH_VECTOR_TOKEN=xxx node scripts/index-data.js <data_dir>
 *
 * Reads _qa.txt and _style.txt files, splits into chunks, uploads to Upstash Vector.
 */

const fs = require('fs');
const path = require('path');

const VECTOR_URL = process.env.UPSTASH_VECTOR_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_TOKEN;
const DATA_DIR = process.argv[2];
const BATCH_SIZE = 50; // Upstash supports batch upsert
const DELAY_MS = 500;  // Rate limit friendly

if (!VECTOR_URL || !VECTOR_TOKEN) {
    console.error('Error: Set UPSTASH_VECTOR_URL and UPSTASH_VECTOR_TOKEN environment variables');
    process.exit(1);
}

if (!DATA_DIR || !fs.existsSync(DATA_DIR)) {
    console.error('Usage: node scripts/index-data.js <path_to_coze_output>');
    process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse QA file into individual Q&A pairs
function parseQAFile(content, source) {
    const pairs = [];
    const blocks = content.split(/\n\nQ:\s*/);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        const text = trimmed.startsWith('Q:') ? trimmed : 'Q: ' + trimmed;
        const match = text.match(/Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)/);
        if (match) {
            const q = match[1].trim();
            const a = match[2].trim();
            if (q && a) {
                pairs.push({
                    data: `问: ${q}\n悠的回答: ${a}`,
                    metadata: { type: 'qa', source }
                });
            }
        }
    }
    return pairs;
}

// Parse style file into chunks
function parseStyleFile(content, source) {
    const chunks = [];
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    // Group every 5 style samples together
    for (let i = 0; i < lines.length; i += 5) {
        const group = lines.slice(i, i + 5).map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);
        if (group.length > 0) {
            chunks.push({
                data: '悠的说话风格示例:\n' + group.join('\n'),
                metadata: { type: 'style', source }
            });
        }
    }
    return chunks;
}

async function upsertBatch(items) {
    const body = items.map((item, idx) => ({
        id: item.id,
        data: item.data,
        metadata: item.metadata
    }));

    const resp = await fetch(`${VECTOR_URL}/upsert-data`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${VECTOR_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Upsert failed: ${resp.status} - ${err}`);
    }
    return await resp.json();
}

async function main() {
    const files = fs.readdirSync(DATA_DIR);
    const allChunks = [];
    let idCounter = 0;

    // Process QA files
    const qaFiles = files.filter(f => f.endsWith('_qa.txt'));
    console.log(`Found ${qaFiles.length} QA files`);
    for (const file of qaFiles) {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const source = file.replace('_qa.txt', '');
        const pairs = parseQAFile(content, source);
        for (const p of pairs) {
            allChunks.push({ id: `qa_${idCounter++}`, ...p });
        }
    }

    // Process style files
    const styleFiles = files.filter(f => f.endsWith('_style.txt'));
    console.log(`Found ${styleFiles.length} style files`);
    for (const file of styleFiles) {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const source = file.replace('_style.txt', '');
        const chunks = parseStyleFile(content, source);
        for (const c of chunks) {
            allChunks.push({ id: `style_${idCounter++}`, ...c });
        }
    }

    console.log(`Total chunks to index: ${allChunks.length}`);

    // Upload in batches
    let uploaded = 0;
    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
        const batch = allChunks.slice(i, i + BATCH_SIZE);
        try {
            await upsertBatch(batch);
            uploaded += batch.length;
            console.log(`Uploaded ${uploaded}/${allChunks.length}`);
        } catch (err) {
            console.error(`Batch error at ${i}:`, err.message);
        }
        if (i + BATCH_SIZE < allChunks.length) await sleep(DELAY_MS);
    }

    console.log(`\nDone! Indexed ${uploaded} chunks into Upstash Vector.`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
