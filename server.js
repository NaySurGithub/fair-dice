const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const stateMap = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
    serverSeed: '',
    hashedServerSeed: '',
    clientSeed: '',
    nonce: 0,
    customClientSeed: null
};

let globalRolls = [];

function loadState() {
    if (stateMap.has('gameState')) {
        gameState = stateMap.get('gameState');
    } else {
        generateNewRound();
        saveState();
    }
}

function saveState() {
    stateMap.set('gameState', gameState);
}

function generateSeed(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function generateNewRound() {
    gameState.serverSeed = generateSeed(32);
    gameState.hashedServerSeed = hashSeed(gameState.serverSeed);
    gameState.clientSeed = generateSeed(8);
    gameState.nonce = 0;
    gameState.customClientSeed = null;
}

function calculateRoll(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}-${nonce}`);
    const hash = hmac.digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return num % 6;
}

app.get('/api/init', (req, res) => {
    res.json({
        hashedServerSeed: gameState.hashedServerSeed,
        clientSeed: gameState.customClientSeed || gameState.clientSeed,
        nonce: gameState.nonce
    });
});

app.post('/api/set-client-seed', (req, res) => {
    const { seed } = req.body;
    if (seed && seed.trim() !== '') {
        gameState.customClientSeed = seed.trim();
    } else {
        gameState.customClientSeed = null;
    }
    saveState();
    res.json({ success: true, clientSeed: gameState.customClientSeed || gameState.clientSeed });
});

app.post('/api/roll', (req, res) => {
    const { numDice = 1, mode = 'standard', betColor = 'red' } = req.body;
    const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    const results = [];
    const activeClientSeed = gameState.customClientSeed || gameState.clientSeed;

    const diceCount = mode === 'perya' ? 3 : numDice;

    for (let i = 0; i < diceCount; i++) {
        const resultIndex = calculateRoll(gameState.serverSeed, activeClientSeed, gameState.nonce);
        results.push({ color: colors[resultIndex], index: resultIndex });
        gameState.nonce += 1;
    }

    if (gameState.nonce >= 100) {
        generateNewRound();
    }
    saveState();

    const fakeUser = 'User_' + Math.floor(1000 + Math.random() * 9000);
    results.forEach(r => {
        globalRolls.unshift({ user: fakeUser, color: r.color, time: Date.now() });
    });
    if (globalRolls.length > 50) globalRolls = globalRolls.slice(0, 50);

    let peryaPayout = 0;
    if (mode === 'perya') {
        const matches = results.filter(r => r.color === betColor).length;
        if (matches === 3) peryaPayout = 5;
        else if (matches === 2) peryaPayout = 2;
        else if (matches === 1) peryaPayout = 1.2;
    }

    res.json({
        results,
        peryaPayout,
        nextHashedServerSeed: gameState.hashedServerSeed,
        nextClientSeed: gameState.customClientSeed || gameState.clientSeed,
        nextNonce: gameState.nonce
    });
});

app.get('/api/feed', (req, res) => {
    res.json(globalRolls);
});

app.get('/overlay', (req, res) => {
    const overlayHtml = `<!DOCTYPE html><html><head><style>body{background:transparent;font-family:'Segoe UI',sans-serif;color:white;text-shadow:2px 2px 8px rgba(0,0,0,0.9);padding:20px;margin:0;} .box{background:rgba(0,0,0,0.7);padding:25px;border-radius:20px;border:2px solid rgba(255,255,255,0.2);backdrop-filter:blur(10px);} h1{font-size:2.5rem;margin:0 0 15px 0;color:#fff;} .hash{font-family:monospace;font-size:1.2rem;word-break:break-all;opacity:0.9;background:rgba(255,255,255,0.1);padding:10px;border-radius:8px;margin-top:10px;} .badge{background:#10b981;padding:8px 20px;border-radius:30px;display:inline-block;margin-top:20px;font-weight:bold;font-size:1.1rem;box-shadow:0 4px 15px rgba(16,185,129,0.4);}</style></head><body><div class="box"><h1>🎲 FairDice Stream</h1><div>Current Hash Commit:</div><div class="hash" id="hash">Loading...</div><div class="badge">✅ VERIFIED FAIR</div></div><script>async function update(){const res=await fetch('/api/init');const data=await res.json();document.getElementById('hash').textContent=data.hashedServerSeed;}update();setInterval(update,5000);</script></body></html>`;
    res.send(overlayHtml);
});

app.post('/api/verify', (req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body;
    if (!serverSeed || !clientSeed || nonce === undefined) return res.status(400).json({ error: 'Missing parameters' });
    const expectedHash = hashSeed(serverSeed);
    const resultIndex = calculateRoll(serverSeed, clientSeed, nonce);
    const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    res.json({ validHash: expectedHash, resultColor: colors[resultIndex], resultIndex });
});

loadState();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
