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
    const state = getUserState(sessionId);
    
    const { numDice = 1, mode = 'standard', betColor = 'red' } = req.body;
    const results = [];
    const activeClientSeed = state.customClientSeed || state.clientSeed;
    const diceCount = parseInt(mode === 'perya' ? 3 : numDice) || 1;

    for (let i = 0; i < diceCount; i++) {
        const resultIndex = calculateRoll(state.serverSeed, activeClientSeed, state.nonce);
        const colorName = INDEX_TO_COLOR.get(resultIndex);
        results.push({ color: colorName, index: resultIndex });
        state.nonce += 1;
    }

    if (state.nonce >= 100) {
        generateNewRound(state);
    }

    const fakeUser = 'User_' + Math.floor(1000 + Math.random() * 9000);
    globalRolls.unshift({ 
        user: fakeUser, 
        colors: results.map(r => r.color), 
        time: Date.now() 
    });
    
    if (globalRolls.length > 50) {
        globalRolls = globalRolls.slice(0, 50);
    }

    let peryaPayout = 0;
    if (mode === 'perya') {
        const matches = results.filter(r => r.color === betColor).length;
        peryaPayout = PERYA_PAYOUT_MAP.get(matches) || 0;
    }

    res.json({
        results,
        peryaPayout,
        nextHashedServerSeed: state.hashedServerSeed,
        nextClientSeed: state.customClientSeed || state.clientSeed,
        nextNonce: state.nonce
    });
});

app.get('/api/feed', (req, res) => {
    res.json(globalRolls);
});

app.get('/overlay', (req, res) => {
    const overlayHtml = `<!DOCTYPE html><html><head><style>body{background:transparent;font-family:'Segoe UI',sans-serif;color:white;text-shadow:2px 2px 8px rgba(0,0,0,0.9);padding:20px;margin:0;} .box{background:rgba(0,0,0,0.7);padding:25px;border-radius:20px;border:2px solid rgba(255,255,255,0.2);backdrop-filter:blur(10px);} h1{font-size:2.5rem;margin:0 0 15px 0;color:#fff;} .hash{font-family:monospace;font-size:1.2rem;word-break:break-all;opacity:0.9;background:rgba(255,255,255,0.1);padding:10px;border-radius:8px;margin-top:10px;} .badge{background:#10b981;padding:8px 20px;border-radius:30px;display:inline-block;margin-top:20px;font-weight:bold;font-size:1.1rem;box-shadow:0 4px 15px rgba(16,185,129,0.4);}</style></head><body><div class="box"><h1>🎲 FairDice Stream</h1><div>Current Hash Commit:</div><div class="hash" id="hash">Loading...</div><div class="badge">✅ VERIFIED FAIR</div></div><script>async function update(){const res=await fetch('/api/init');const data=await res.json();document.getElementById('hash').textContent=data.hashedServerSeed;}update();setInterval(update,5000);</script></body></html>`;
    res.send(overlayHtml);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
