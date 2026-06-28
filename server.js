const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COLOR_MAP = new Map([
    ['red', 0], ['orange', 1], ['yellow', 2],
    ['green', 3], ['blue', 4], ['purple', 5]
]);

const INDEX_TO_COLOR = new Map([
    [0, 'red'], [1, 'orange'], [2, 'yellow'],
    [3, 'green'], [4, 'blue'], [5, 'purple']
]);

const PERYA_PAYOUT_MAP = new Map([
    [1, 1.2],
    [2, 2.0],
    [3, 5.0]
]);

const userStates = new Map();
const lastRolls = new Map();
const receipts = new Map(); // Stores shareable receipts
let globalRolls = [];

function getDefaultState() {
    return {
        serverSeed: '',
        hashedServerSeed: '',
        clientSeed: '',
        nonce: 0,
        customClientSeed: null
    };
}

function generateSeed(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function generateNewRound(state) {
    state.serverSeed = generateSeed(32);
    state.hashedServerSeed = hashSeed(state.serverSeed);
    state.clientSeed = generateSeed(8);
    state.nonce = 0;
    state.customClientSeed = null;
}

function getUserState(sessionId) {
    if (!userStates.has(sessionId)) {
        const newState = getDefaultState();
        generateNewRound(newState);
        userStates.set(sessionId, newState);
    }
    return userStates.get(sessionId);
}

function calculateRoll(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}-${nonce}`);
    const hash = hmac.digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return num % 6;
}

app.get('/api/init', (req, res) => {
    const sessionId = req.headers['x-session-id'] || 'default';
    const state = getUserState(sessionId);
    
    res.json({
        hashedServerSeed: state.hashedServerSeed,
        clientSeed: state.customClientSeed || state.clientSeed,
        nonce: state.nonce
    });
});

app.post('/api/set-client-seed', (req, res) => {
    const sessionId = req.headers['x-session-id'] || 'default';
    const state = getUserState(sessionId);
    const { seed } = req.body;
    
    if (seed && seed.trim() !== '') {
        state.customClientSeed = seed.trim();
    } else {
        state.customClientSeed = null;
    }
    
    res.json({ success: true, clientSeed: state.customClientSeed || state.clientSeed });
});

app.post('/api/roll', (req, res) => {
    const sessionId = req.headers['x-session-id'] || 'default';
    const username = req.headers['x-username'] || sessionId;
    const state = getUserState(sessionId);
    
    const { numDice = 1, mode = 'standard', betColor = 'red' } = req.body;
    const results = [];
    const activeClientSeed = state.customClientSeed || state.clientSeed;
    const diceCount = parseInt(mode === 'perya' ? 3 : numDice) || 1;
    const startNonce = state.nonce; // Capture starting nonce for receipt

    for (let i = 0; i < diceCount; i++) {
        const resultIndex = calculateRoll(state.serverSeed, activeClientSeed, state.nonce);
        const colorName = INDEX_TO_COLOR.get(resultIndex);
        results.push({ color: colorName, index: resultIndex });
        state.nonce += 1;
    }

    if (state.nonce >= 100) {
        generateNewRound(state);
    }

    const resultString = results.map(r => r.color).join('-');
    const proofHash = crypto.createHash('sha256').update(resultString + state.serverSeed).digest('hex').substring(0, 6).toUpperCase();

    // Generate Receipt ID
    const receiptId = crypto.randomBytes(6).toString('hex');
    receipts.set(receiptId, {
        id: receiptId,
        results,
        betColor,
        mode,
        proofHash,
        clientSeed: activeClientSeed,
        nonce: startNonce,
        hashedServerSeed: state.hashedServerSeed,
        serverSeed: state.serverSeed, // REVEALED FOR THIS RECEIPT ONLY
        timestamp: Date.now()
    });

    // Limit memory usage
    if (receipts.size > 2000) {
        const firstKey = receipts.keys().next().value;
        receipts.delete(firstKey);
    }

    const fakeUser = 'User_' + Math.floor(1000 + Math.random() * 9000);
    globalRolls.unshift({ 
        user: fakeUser, 
        colors: results.map(r => r.color), 
        time: Date.now(),
        proofHash: proofHash
    });
    
    if (globalRolls.length > 50) {
        globalRolls = globalRolls.slice(0, 50);
    }

    lastRolls.set(username, {
        betColor: betColor,
        results: results,
        proofHash: proofHash,
        timestamp: Date.now()
    });

    let peryaPayout = 0;
    if (mode === 'perya') {
        const matches = results.filter(r => r.color === betColor).length;
        peryaPayout = PERYA_PAYOUT_MAP.get(matches) || 0;
    }

    res.json({
        results,
        peryaPayout,
        proofHash,
        receiptId, // Send ID to frontend
        nextHashedServerSeed: state.hashedServerSeed,
        nextClientSeed: state.customClientSeed || state.clientSeed,
        nextNonce: state.nonce
    });
});

app.get('/api/feed', (req, res) => {
    res.json(globalRolls);
});

app.get('/api/last-roll', (req, res) => {
    const username = req.query.user || 'default';
    res.json(lastRolls.get(username) || { timestamp: 0 });
});

app.get('/api/receipt/:id', (req, res) => {
    const receipt = receipts.get(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
});

app.get('/receipt/:id', (req, res) => {
    const receiptId = req.params.id;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FairDice - Verified Receipt</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@600&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Nunito', sans-serif; background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; margin: 0; }
        .receipt-card { background: #1e293b; border: 2px solid #334155; border-radius: 24px; width: 100%; max-width: 500px; padding: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); position: relative; overflow: hidden; }
        .receipt-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, #22c55e, #10b981); }
        .header { text-align: center; margin-bottom: 2rem; }
        .logo { font-size: 1.5rem; font-weight: 800; color: #fff; margin-bottom: 0.5rem; }
        .status-badge { display: inline-block; background: #22c55e; color: #064e3b; padding: 6px 16px; border-radius: 20px; font-weight: 800; font-size: 0.9rem; letter-spacing: 1px; box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4); }
        .dice-display { display: flex; justify-content: center; gap: 15px; margin: 2rem 0; }
        .die { width: 70px; height: 70px; background: #fff; border-radius: 12px; display: flex; justify-content: center; align-items: center; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
        .dot { width: 45px; height: 45px; border-radius: 50%; box-shadow: inset 0 4px 8px rgba(0,0,0,0.2); }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
        .info-item { background: #0f172a; padding: 1rem; border-radius: 12px; border: 1px solid #334155; }
        .info-label { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; font-weight: 700; margin-bottom: 4px; }
        .info-value { font-size: 1.1rem; font-weight: 700; color: #fff; text-transform: capitalize; }
        .crypto-section { background: #0f172a; border: 1px dashed #334155; border-radius: 12px; padding: 1.5rem; margin-top: 2rem; }
        .crypto-title { font-family: 'JetBrains Mono', monospace; font-size: 0.9rem; color: #22c55e; margin-bottom: 1rem; display: flex; align-items: center; gap: 8px; }
        .hash-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 1rem; }
        .hash-label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; font-weight: 700; }
        .hash-val { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: #e2e8f0; word-break: break-all; background: #1e293b; padding: 6px; border-radius: 4px; border: 1px solid #334155; }
        .verify-btn { width: 100%; background: #3b82f6; color: #fff; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; margin-top: 1rem; transition: background 0.2s; }
        .verify-btn:hover { background: #2563eb; }
        .verify-result { margin-top: 1rem; padding: 1rem; border-radius: 8px; text-align: center; font-weight: 700; display: none; }
        .verify-result.success { background: #dcfce7; color: #166534; display: block; }
        .verify-result.fail { background: #fee2e2; color: #991b1b; display: block; }
        .footer { text-align: center; margin-top: 2rem; font-size: 0.8rem; color: #64748b; }
        .color-red { background: #ef4444; } .color-orange { background: #f97316; } .color-yellow { background: #eab308; }
        .color-green { background: #22c55e; } .color-blue { background: #3b82f6; } .color-purple { background: #a855f7; }
    </style>
</head>
<body>
    <div class="receipt-card">
        <div class="header">
            <div class="logo">🎲 FairDice</div>
            <div class="status-badge" id="status">LOADING...</div>
        </div>

        <div class="dice-display" id="dice-area"></div>

        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Bet Color</div>
                <div class="info-value" id="bet-color">-</div>
            </div>
            <div class="info-item">
                <div class="info-label">Mode</div>
                <div class="info-value" id="mode">-</div>
            </div>
            <div class="info-item" style="grid-column: span 2;">
                <div class="info-label">Visual Proof Hash</div>
                <div class="info-value" style="font-family: 'JetBrains Mono', monospace; color: #fbbf24;" id="proof-hash">-</div>
            </div>
        </div>

        <div class="crypto-section">
            <div class="crypto-title">🔒 Cryptographic Data</div>
            <div class="hash-row">
                <div class="hash-label">Server Seed (Revealed)</div>
                <div class="hash-val" id="server-seed">-</div>
            </div>
            <div class="hash-row">
                <div class="hash-label">Client Seed</div>
                <div class="hash-val" id="client-seed">-</div>
            </div>
            <div class="hash-row">
                <div class="hash-label">Nonce</div>
                <div class="hash-val" id="nonce">-</div>
            </div>
            <button class="verify-btn" onclick="verifyReceipt()">Verify Math</button>
            <div class="verify-result" id="verify-result"></div>
        </div>

        <div class="footer">
            Receipt ID: <span id="receipt-id">-</span><br>
            Play at <strong>fairdice.com</strong>
        </div>
    </div>

    <script>
        let receiptData = null;

        async function loadReceipt() {
            const id = window.location.pathname.split('/').pop();
            document.getElementById('receipt-id').textContent = id;
            
            try {
                const res = await fetch('/api/receipt/' + id);
                if (!res.ok) throw new Error('Not found');
                receiptData = await res.json();
                renderReceipt();
            } catch (e) {
                document.getElementById('status').textContent = 'INVALID RECEIPT';
                document.getElementById('status').style.background = '#ef4444';
                document.getElementById('status').style.color = '#fff';
            }
        }

        function renderReceipt() {
            if (!receiptData) return;

            // Status
            const isWin = receiptData.results.some(r => r.color === receiptData.betColor);
            const statusEl = document.getElementById('status');
            if (isWin) {
                statusEl.textContent = '✅ VERIFIED WIN';
            } else {
                statusEl.textContent = '✅ VERIFIED ROLL';
                statusEl.style.background = '#3b82f6';
                statusEl.style.color = '#fff';
            }

            // Dice
            const area = document.getElementById('dice-area');
            area.innerHTML = '';
            receiptData.results.forEach(r => {
                const die = document.createElement('div');
                die.className = 'die';
                die.innerHTML = '<div class="dot color-' + r.color + '"></div>';
                area.appendChild(die);
            });

            // Info
            document.getElementById('bet-color').textContent = receiptData.betColor;
            document.getElementById('mode').textContent = receiptData.mode;
            document.getElementById('proof-hash').textContent = receiptData.proofHash;
            
            // Crypto
            document.getElementById('server-seed').textContent = receiptData.serverSeed;
            document.getElementById('client-seed').textContent = receiptData.clientSeed;
            document.getElementById('nonce').textContent = receiptData.nonce;
        }

        async function verifyReceipt() {
            if (!receiptData) return;
            const resultEl = document.getElementById('verify-result');
            
            try {
                // 1. Verify Hash
                const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receiptData.serverSeed));
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                
                if (hashHex !== receiptData.hashedServerSeed) {
                    resultEl.className = 'verify-result fail';
                    resultEl.textContent = '❌ HASH MISMATCH: Server Seed does not match Commit!';
                    return;
                }

                // 2. Verify Result
                const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
                const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(receiptData.serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                
                for (let i = 0; i < receiptData.results.length; i++) {
                    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(receiptData.clientSeed + '-' + (receiptData.nonce + i)));
                    const sigArray = Array.from(new Uint8Array(sig));
                    const sigHex = sigArray.map(b => b.toString(16).padStart(2, '0')).join('');
                    const num = parseInt(sigHex.substring(0, 8), 16);
                    const calcIndex = num % 6;
                    const calcColor = colors[calcIndex];
                    
                    if (calcColor !== receiptData.results[i].color) {
                        resultEl.className = 'verify-result fail';
                        resultEl.textContent = '❌ RESULT MISMATCH: Dice ' + (i+1) + ' should be ' + calcColor + '!';
                        return;
                    }
                }
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const rollLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const COLOR_MAP = new Map([
    ['red', 0], ['orange', 1], ['yellow', 2],
    ['green', 3], ['blue', 4], ['purple', 5]
]);

const INDEX_TO_COLOR = new Map([
    [0, 'red'], [1, 'orange'], [2, 'yellow'],
    [3, 'green'], [4, 'blue'], [5, 'purple']
]);

const PERYA_PAYOUT_MAP = new Map([
    [1, 1.2],
    [2, 2.0],
    [3, 5.0]
]);

const VALID_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const userStates = new Map();
const lastRolls = new Map();
const receipts = new Map();
let globalRolls = [];

function getDefaultState() {
    return {
        serverSeed: '',
        hashedServerSeed: '',
        clientSeed: '',
        nonce: 0,
        customClientSeed: null
    };
}

function generateSeed(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function generateNewRound(state) {
    state.serverSeed = generateSeed(32);
    state.hashedServerSeed = hashSeed(state.serverSeed);
    state.clientSeed = generateSeed(8);
    state.nonce = 0;
    state.customClientSeed = null;
}

function getUserState(sessionId) {
    if (!userStates.has(sessionId)) {
        const newState = getDefaultState();
        generateNewRound(newState);
        userStates.set(sessionId, newState);
    }
    return userStates.get(sessionId);
}

function calculateRoll(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}-${nonce}`);
    const hash = hmac.digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return num % 6;
}

function getSecureSession(req, res) {
    let sid = req.cookies.fairdice_sid;
    if (!sid || typeof sid !== 'string' || sid.length < 10) {
        sid = crypto.randomUUID();
        res.cookie('fairdice_sid', sid, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000
        });
    }
    return sid;
}

app.get('/api/init', (req, res) => {
    const sessionId = getSecureSession(req, res);
    const state = getUserState(sessionId);
    
    res.json({
        hashedServerSeed: state.hashedServerSeed,
        clientSeed: state.customClientSeed || state.clientSeed,
        nonce: state.nonce
    });
});

app.post('/api/set-client-seed', (req, res) => {
    const sessionId = getSecureSession(req, res);
    const state = getUserState(sessionId);
    const { seed } = req.body;
    
    if (seed && typeof seed === 'string' && seed.trim() !== '') {
        state.customClientSeed = seed.trim().substring(0, 100);
    } else {
        state.customClientSeed = null;
    }
    
    res.json({ success: true, clientSeed: state.customClientSeed || state.clientSeed });
});

app.post('/api/roll', rollLimiter, (req, res) => {
    const sessionId = getSecureSession(req, res);
    const streamerName = req.headers['x-streamer-name'] || sessionId;
    const state = getUserState(sessionId);
    
    let numDice = parseInt(req.body.numDice);
    const mode = req.body.mode;
    const betColor = req.body.betColor;

    if (isNaN(numDice) || numDice < 1 || numDice > 100) {
        return res.status(400).json({ error: 'Invalid numDice. Must be between 1 and 100.' });
    }

    if (mode !== 'standard' && mode !== 'perya') {
        return res.status(400).json({ error: 'Invalid mode. Must be standard or perya.' });
    }

    if (!VALID_COLORS.includes(betColor)) {
        return res.status(400).json({ error: 'Invalid betColor.' });
    }

    const results = [];
    const activeClientSeed = state.customClientSeed || state.clientSeed;
    const diceCount = mode === 'perya' ? 3 : numDice;
    const startNonce = state.nonce;

    for (let i = 0; i < diceCount; i++) {
        const resultIndex = calculateRoll(state.serverSeed, activeClientSeed, state.nonce);
        const colorName = INDEX_TO_COLOR.get(resultIndex);
        results.push({ color: colorName, index: resultIndex });
        state.nonce += 1;
    }

    if (state.nonce >= 100) {
        generateNewRound(state);
    }

    const resultString = results.map(r => r.color).join('-');
    const proofHash = crypto.createHash('sha256').update(resultString + state.serverSeed).digest('hex').substring(0, 6).toUpperCase();

    const receiptId = crypto.randomBytes(6).toString('hex');
    receipts.set(receiptId, {
        id: receiptId,
        results,
        betColor,
        mode,
        proofHash,
        clientSeed: activeClientSeed,
        nonce: startNonce,
        hashedServerSeed: state.hashedServerSeed,
        serverSeed: state.serverSeed,
        timestamp: Date.now()
    });

    if (receipts.size > 2000) {
        const firstKey = receipts.keys().next().value;
        receipts.delete(firstKey);
    }

    const fakeUser = 'User_' + Math.floor(1000 + Math.random() * 9000);
    globalRolls.unshift({ 
        user: fakeUser, 
        colors: results.map(r => r.color), 
        time: Date.now(),
        proofHash: proofHash
    });
    
    if (globalRolls.length > 50) {
        globalRolls = globalRolls.slice(0, 50);
    }

    lastRolls.set(streamerName, {
        betColor: betColor,
        results: results,
        proofHash: proofHash,
        timestamp: Date.now()
    });

    let peryaPayout = 0;
    if (mode === 'perya') {
        const matches = results.filter(r => r.color === betColor).length;
        peryaPayout = PERYA_PAYOUT_MAP.get(matches) || 0;
    }

    res.json({
        results,
        peryaPayout,
        proofHash,
        receiptId,
        nextHashedServerSeed: state.hashedServerSeed,
        nextClientSeed: state.customClientSeed || state.clientSeed,
        nextNonce: state.nonce
    });
});

app.get('/api/feed', (req, res) => {
    res.json(globalRolls);
});

app.get('/api/last-roll', (req, res) => {
    const username = req.query.user || 'default';
    res.json(lastRolls.get(username) || { timestamp: 0 });
});

app.get('/api/receipt/:id', (req, res) => {
    const receipt = receipts.get(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
});

app.get('/receipt/:id', (req, res) => {
    const receiptId = req.params.id;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FairDice - Verified Receipt</title><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@600&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet"><style>body{font-family:'Nunito',sans-serif;background:#0f172a;color:#f8fafc;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;margin:0;}.receipt-card{background:#1e293b;border:2px solid #334155;border-radius:24px;width:100%;max-width:500px;padding:2rem;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);position:relative;overflow:hidden;}.receipt-card::before{content:'';position:absolute;top:0;left:0;right:0;height:6px;background:linear-gradient(90deg,#22c55e,#10b981);}.header{text-align:center;margin-bottom:2rem;}.logo{font-size:1.5rem;font-weight:800;color:#fff;margin-bottom:0.5rem;}.status-badge{display:inline-block;background:#22c55e;color:#064e3b;padding:6px 16px;border-radius:20px;font-weight:800;font-size:0.9rem;letter-spacing:1px;box-shadow:0 4px 15px rgba(34,197,94,0.4);}.dice-display{display:flex;justify-content:center;gap:15px;margin:2rem 0;}.die{width:70px;height:70px;background:#fff;border-radius:12px;display:flex;justify-content:center;align-items:center;box-shadow:0 10px 15px -3px rgba(0,0,0,0.3);}.dot{width:45px;height:45px;border-radius:50%;box-shadow:inset 0 4px 8px rgba(0,0,0,0.2);}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:2rem;}.info-item{background:#0f172a;padding:1rem;border-radius:12px;border:1px solid #334155;}.info-label{font-size:0.75rem;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:4px;}.info-value{font-size:1.1rem;font-weight:700;color:#fff;text-transform:capitalize;}.crypto-section{background:#0f172a;border:1px dashed #334155;border-radius:12px;padding:1.5rem;margin-top:2rem;}.crypto-title{font-family:'JetBrains Mono',monospace;font-size:0.9rem;color:#22c55e;margin-bottom:1rem;display:flex;align-items:center;gap:8px;}.hash-row{display:flex;flex-direction:column;gap:8px;margin-bottom:1rem;}.hash-label{font-size:0.7rem;color:#64748b;text-transform:uppercase;font-weight:700;}.hash-val{font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:#e2e8f0;word-break:break-all;background:#1e293b;padding:6px;border-radius:4px;border:1px solid #334155;}.verify-btn{width:100%;background:#3b82f6;color:#fff;border:none;padding:12px;border-radius:8px;font-weight:700;cursor:pointer;margin-top:1rem;transition:background 0.2s;}.verify-btn:hover{background:#2563eb;}.verify-result{margin-top:1rem;padding:1rem;border-radius:8px;text-align:center;font-weight:700;display:none;}.verify-result.success{background:#dcfce7;color:#166534;display:block;}.verify-result.fail{background:#fee2e2;color:#991b1b;display:block;}.footer{text-align:center;margin-top:2rem;font-size:0.8rem;color:#64748b;}.color-red{background:#ef4444;}.color-orange{background:#f97316;}.color-yellow{background:#eab308;}.color-green{background:#22c55e;}.color-blue{background:#3b82f6;}.color-purple{background:#a855f7;}</style></head><body><div class="receipt-card"><div class="header"><div class="logo">🎲 FairDice</div><div class="status-badge" id="status">LOADING...</div></div><div class="dice-display" id="dice-area"></div><div class="info-grid"><div class="info-item"><div class="info-label">Bet Color</div><div class="info-value" id="bet-color">-</div></div><div class="info-item"><div class="info-label">Mode</div><div class="info-value" id="mode">-</div></div><div class="info-item" style="grid-column:span 2;"><div class="info-label">Visual Proof Hash</div><div class="info-value" style="font-family:'JetBrains Mono',monospace;color:#fbbf24;" id="proof-hash">-</div></div></div><div class="crypto-section"><div class="crypto-title">🔒 Cryptographic Data</div><div class="hash-row"><div class="hash-label">Server Seed (Revealed)</div><div class="hash-val" id="server-seed">-</div></div><div class="hash-row"><div class="hash-label">Client Seed</div><div class="hash-val" id="client-seed">-</div></div><div class="hash-row"><div class="hash-label">Nonce</div><div class="hash-val" id="nonce">-</div></div><button class="verify-btn" onclick="verifyReceipt()">Verify Math</button><div class="verify-result" id="verify-result"></div></div><div class="footer">Receipt ID: <span id="receipt-id">-</span><br>Play at <strong>fairdice.com</strong></div></div><script>let receiptData=null;async function loadReceipt(){const id=window.location.pathname.split('/').pop();document.getElementById('receipt-id').textContent=id;try{const res=await fetch('/api/receipt/'+id);if(!res.ok)throw new Error('Not found');receiptData=await res.json();renderReceipt();}catch(e){document.getElementById('status').textContent='INVALID RECEIPT';document.getElementById('status').style.background='#ef4444';document.getElementById('status').style.color='#fff';}}function renderReceipt(){if(!receiptData)return;const isWin=receiptData.results.some(r=>r.color===receiptData.betColor);const statusEl=document.getElementById('status');if(isWin){statusEl.textContent='✅ VERIFIED WIN';}else{statusEl.textContent='✅ VERIFIED ROLL';statusEl.style.background='#3b82f6';statusEl.style.color='#fff';}const area=document.getElementById('dice-area');area.innerHTML='';receiptData.results.forEach(r=>{const die=document.createElement('div');die.className='die';die.innerHTML='<div class="dot color-'+r.color+'"></div>';area.appendChild(die);});document.getElementById('bet-color').textContent=receiptData.betColor;document.getElementById('mode').textContent=receiptData.mode;document.getElementById('proof-hash').textContent=receiptData.proofHash;document.getElementById('server-seed').textContent=receiptData.serverSeed;document.getElementById('client-seed').textContent=receiptData.clientSeed;document.getElementById('nonce').textContent=receiptData.nonce;}async function verifyReceipt(){if(!receiptData)return;const resultEl=document.getElementById('verify-result');try{const hashBuffer=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(receiptData.serverSeed));const hashArray=Array.from(new Uint8Array(hashBuffer));const hashHex=hashArray.map(b=>b.toString(16).padStart(2,'0')).join('');if(hashHex!==receiptData.hashedServerSeed){resultEl.className='verify-result fail';resultEl.textContent='❌ HASH MISMATCH: Server Seed does not match Commit!';return;}const colors=['red','orange','yellow','green','blue','purple'];const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(receiptData.serverSeed),{name:'HMAC',hash:'SHA-256'},false,['sign']);for(let i=0;i<receiptData.results.length;i++){const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(receiptData.clientSeed+'-'+(receiptData.nonce+i)));const sigArray=Array.from(new Uint8Array(sig));const sigHex=sigArray.map(b=>b.toString(16).padStart(2,'0')).join('');const num=parseInt(sigHex.substring(0,8),16);const calcIndex=num%6;const calcColor=colors[calcIndex];if(calcColor!==receiptData.results[i].color){resultEl.className='verify-result fail';resultEl.textContent='❌ RESULT MISMATCH: Dice '+(i+1)+' should be '+calcColor+'!';return;}}resultEl.className='verify-result success';resultEl.innerHTML='✅ MATHEMATICALLY VERIFIED<br><span style="font-size:0.8rem;font-weight:400;">The dice, hash, and seeds all match perfectly.</span>';}catch(e){resultEl.className='verify-result fail';resultEl.textContent='❌ ERROR: '+e.message;}}loadReceipt();</script></body></html>`;
    res.send(html);
});

app.get('/overlay', (req, res) => {
    const username = req.query.user || 'default';
    const safeUsername = username.replace(/['"\\]/g, '');
    
    const overlayHtml = `<!DOCTYPE html><html><head><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&family=Fredoka:wght@700&family=JetBrains+Mono:wght@700&display=swap');*{margin:0;padding:0;box-sizing:border-box;}body{background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Bangers',cursive;overflow:hidden;}#main-container{display:flex;flex-direction:column;align-items:center;gap:2vw;}#dice-container{display:flex;gap:1.5vw;justify-content:center;opacity:0;transition:opacity 0.3s;}#dice-container.active{opacity:1;}#dice-container.active .overlay-die{transform:scale(1);}.overlay-die{width:12vw;height:12vw;background:white;border-radius:20%;display:flex;justify-content:center;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,0.5);transform:scale(0);transition:transform 0.4s cubic-bezier(0.175,0.885,0.32,1.275);}.overlay-dot{width:70%;height:70%;border-radius:50%;box-shadow:inset 0 5px 15px rgba(0,0,0,0.2);}#display{font-size:18vw;color:white;text-shadow:0 0 30px rgba(0,0,0,0.8),8px 8px 0 rgba(0,0,0,0.6);opacity:0;transition:opacity 0.2s;text-align:center;line-height:1;}#display.active{opacity:1;}#display.rolling{animation:shake 0.08s infinite;color:#fbbf24;text-shadow:0 0 50px #f59e0b,8px 8px 0 #000;}#display.win{color:#22c55e;text-shadow:0 0 60px #16a34a,10px 10px 0 #000;animation:popIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);}#display.lose{color:#ef4444;text-shadow:0 0 60px #dc2626,10px 10px 0 #000;animation:dropIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275);}@keyframes shake{0%{transform:translate(2px,2px) rotate(1deg);}25%{transform:translate(-2px,-2px) rotate(-1deg);}50%{transform:translate(-2px,2px) rotate(0deg);}75%{transform:translate(2px,-2px) rotate(1deg);}100%{transform:translate(2px,2px) rotate(0deg);}}@keyframes popIn{0%{transform:scale(0) rotate(-10deg);opacity:0;}70%{transform:scale(1.3) rotate(5deg);opacity:1;}100%{transform:scale(1) rotate(0deg);opacity:1;}}@keyframes dropIn{0%{transform:translateY(-200%) scale(1.5);opacity:0;}60%{transform:translateY(20px) scale(0.9);opacity:1;}100%{transform:translateY(0) scale(1);opacity:1;}}#bet-info{position:absolute;bottom:10%;font-family:'Fredoka',sans-serif;font-size:4vw;color:white;text-shadow:3px 3px 0 #000;opacity:0;transition:opacity 0.3s;}#bet-info.active{opacity:1;}#proof-hash{position:absolute;top:5%;right:5%;font-family:'JetBrains Mono',monospace;font-size:2vw;color:rgba(255,255,255,0.6);background:rgba(0,0,0,0.4);padding:10px 20px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);opacity:0;transition:opacity 0.3s;}#proof-hash.active{opacity:1;}</style></head><body><div id="main-container"><div id="dice-container"></div><div id="display"></div></div><div id="bet-info"></div><div id="proof-hash"></div><script>let lastTimestamp=0;const display=document.getElementById('display');const betInfo=document.getElementById('bet-info');const proofHash=document.getElementById('proof-hash');const diceContainer=document.getElementById('dice-container');const colorMap={'red':'#ef4444','orange':'#f97316','yellow':'#eab308','green':'#22c55e','blue':'#3b82f6','purple':'#a855f7'};async function poll(){try{const res=await fetch('/api/last-roll?user=${safeUsername}');const data=await res.json();if(data&&data.timestamp>lastTimestamp){lastTimestamp=data.timestamp;runSequence(data);}}catch(e){}}async function runSequence(data){display.className='active rolling';display.textContent='ROLLING...';betInfo.className='active';betInfo.textContent='BET: '+data.betColor.toUpperCase();proofHash.className='active';proofHash.textContent='PROOF: '+data.proofHash;diceContainer.className='';diceContainer.innerHTML='';await sleep(1500);data.results.forEach(r=>{const die=document.createElement('div');die.className='overlay-die';const dot=document.createElement('div');dot.className='overlay-dot';dot.style.background=colorMap[r.color]||'#fff';die.appendChild(dot);diceContainer.appendChild(die);});diceContainer.className='active';display.className='';betInfo.className='';const isWin=data.results.some(r=>r.color===data.betColor);if(isWin){display.className='active win';display.textContent='WIN!';}else{display.className='active lose';display.textContent='LOSE!';}await sleep(3000);display.className='';proofHash.className='';diceContainer.className='';}function sleep(ms){return new Promise(r=>setTimeout(r,ms));}setInterval(poll,500);</script></body></html>`;
    res.send(overlayHtml);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
                resultEl.innerHTML = '✅ MATHEMATICALLY VERIFIED<br><span style="font-size: 0.8rem; font-weight: 400;">The dice, hash, and seeds all match perfectly.</span>';

            } catch (e) {
                resultEl.className = 'verify-result fail';
                resultEl.textContent = '❌ ERROR: ' + e.message;
            }
        }

        loadReceipt();
    </script>
</body>
</html>`;
    res.send(html);
});

app.get('/overlay', (req, res) => {
    const username = req.query.user || 'default';
    const safeUsername = username.replace(/['"\\]/g, '');
    
    const overlayHtml = `<!DOCTYPE html><html><head><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&family=Fredoka:wght@700&family=JetBrains+Mono:wght@700&display=swap');*{margin:0;padding:0;box-sizing:border-box;}body{background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Bangers',cursive;overflow:hidden;}#main-container{display:flex;flex-direction:column;align-items:center;gap:2vw;}#dice-container{display:flex;gap:1.5vw;justify-content:center;opacity:0;transition:opacity 0.3s;}#dice-container.active{opacity:1;}#dice-container.active .overlay-die{transform:scale(1);}.overlay-die{width:12vw;height:12vw;background:white;border-radius:20%;display:flex;justify-content:center;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,0.5);transform:scale(0);transition:transform 0.4s cubic-bezier(0.175,0.885,0.32,1.275);}.overlay-dot{width:70%;height:70%;border-radius:50%;box-shadow:inset 0 5px 15px rgba(0,0,0,0.2);}#display{font-size:18vw;color:white;text-shadow:0 0 30px rgba(0,0,0,0.8),8px 8px 0 rgba(0,0,0,0.6);opacity:0;transition:opacity 0.2s;text-align:center;line-height:1;}#display.active{opacity:1;}#display.rolling{animation:shake 0.08s infinite;color:#fbbf24;text-shadow:0 0 50px #f59e0b,8px 8px 0 #000;}#display.win{color:#22c55e;text-shadow:0 0 60px #16a34a,10px 10px 0 #000;animation:popIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);}#display.lose{color:#ef4444;text-shadow:0 0 60px #dc2626,10px 10px 0 #000;animation:dropIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275);}@keyframes shake{0%{transform:translate(2px,2px) rotate(1deg);}25%{transform:translate(-2px,-2px) rotate(-1deg);}50%{transform:translate(-2px,2px) rotate(0deg);}75%{transform:translate(2px,-2px) rotate(1deg);}100%{transform:translate(2px,2px) rotate(0deg);}}@keyframes popIn{0%{transform:scale(0) rotate(-10deg);opacity:0;}70%{transform:scale(1.3) rotate(5deg);opacity:1;}100%{transform:scale(1) rotate(0deg);opacity:1;}}@keyframes dropIn{0%{transform:translateY(-200%) scale(1.5);opacity:0;}60%{transform:translateY(20px) scale(0.9);opacity:1;}100%{transform:translateY(0) scale(1);opacity:1;}}#bet-info{position:absolute;bottom:10%;font-family:'Fredoka',sans-serif;font-size:4vw;color:white;text-shadow:3px 3px 0 #000;opacity:0;transition:opacity 0.3s;}#bet-info.active{opacity:1;}#proof-hash{position:absolute;top:5%;right:5%;font-family:'JetBrains Mono',monospace;font-size:2vw;color:rgba(255,255,255,0.6);background:rgba(0,0,0,0.4);padding:10px 20px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);opacity:0;transition:opacity 0.3s;}#proof-hash.active{opacity:1;}</style></head><body><div id="main-container"><div id="dice-container"></div><div id="display"></div></div><div id="bet-info"></div><div id="proof-hash"></div><script>let lastTimestamp=0;const display=document.getElementById('display');const betInfo=document.getElementById('bet-info');const proofHash=document.getElementById('proof-hash');const diceContainer=document.getElementById('dice-container');const colorMap={'red':'#ef4444','orange':'#f97316','yellow':'#eab308','green':'#22c55e','blue':'#3b82f6','purple':'#a855f7'};async function poll(){try{const res=await fetch('/api/last-roll?user=${safeUsername}');const data=await res.json();if(data&&data.timestamp>lastTimestamp){lastTimestamp=data.timestamp;runSequence(data);}}catch(e){}}async function runSequence(data){display.className='active rolling';display.textContent='ROLLING...';betInfo.className='active';betInfo.textContent='BET: '+data.betColor.toUpperCase();proofHash.className='active';proofHash.textContent='PROOF: '+data.proofHash;diceContainer.className='';diceContainer.innerHTML='';await sleep(1500);data.results.forEach(r=>{const die=document.createElement('div');die.className='overlay-die';const dot=document.createElement('div');dot.className='overlay-dot';dot.style.background=colorMap[r.color]||'#fff';die.appendChild(dot);diceContainer.appendChild(die);});diceContainer.className='active';display.className='';betInfo.className='';const isWin=data.results.some(r=>r.color===data.betColor);if(isWin){display.className='active win';display.textContent='WIN!';}else{display.className='active lose';display.textContent='LOSE!';}await sleep(3000);display.className='';proofHash.className='';diceContainer.className='';}function sleep(ms){return new Promise(r=>setTimeout(r,ms));}setInterval(poll,500);</script></body></html>`;
    res.send(overlayHtml);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
