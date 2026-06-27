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
const lastRolls = new Map(); // Tracks last roll PER USERNAME
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
    const username = req.headers['x-username'] || sessionId; // Get the streamer name from headers
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

    // Save the last roll specifically for this username
    lastRolls.set(username, {
        betColor: betColor,
        results: results,
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

app.get('/overlay', (req, res) => {
    const username = req.query.user || 'default';
    const safeUsername = username.replace(/['"\\]/g, ''); // Prevent XSS
    
    const overlayHtml = `<!DOCTYPE html><html><head><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&family=Fredoka:wght@700&display=swap');*{margin:0;padding:0;box-sizing:border-box;}body{background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Bangers',cursive;overflow:hidden;}#display{font-size:20vw;color:white;text-shadow:0 0 30px rgba(0,0,0,0.8),8px 8px 0 rgba(0,0,0,0.6);opacity:0;transition:opacity 0.2s;text-align:center;line-height:1;}#display.active{opacity:1;}#display.rolling{animation:shake 0.08s infinite;color:#fbbf24;text-shadow:0 0 50px #f59e0b,8px 8px 0 #000;}#display.win{color:#22c55e;text-shadow:0 0 60px #16a34a,10px 10px 0 #000;animation:popIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);}#display.lose{color:#ef4444;text-shadow:0 0 60px #dc2626,10px 10px 0 #000;animation:dropIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275);}@keyframes shake{0%{transform:translate(2px,2px) rotate(1deg);}25%{transform:translate(-2px,-2px) rotate(-1deg);}50%{transform:translate(-2px,2px) rotate(0deg);}75%{transform:translate(2px,-2px) rotate(1deg);}100%{transform:translate(2px,2px) rotate(0deg);}}@keyframes popIn{0%{transform:scale(0) rotate(-10deg);opacity:0;}70%{transform:scale(1.3) rotate(5deg);opacity:1;}100%{transform:scale(1) rotate(0deg);opacity:1;}}@keyframes dropIn{0%{transform:translateY(-200%) scale(1.5);opacity:0;}60%{transform:translateY(20px) scale(0.9);opacity:1;}100%{transform:translateY(0) scale(1);opacity:1;}}#bet-info{position:absolute;bottom:10%;font-family:'Fredoka',sans-serif;font-size:4vw;color:white;text-shadow:3px 3px 0 #000;opacity:0;transition:opacity 0.3s;}#bet-info.active{opacity:1;}</style></head><body><div id="display"></div><div id="bet-info"></div><script>let lastTimestamp=0;const display=document.getElementById('display');const betInfo=document.getElementById('bet-info');async function poll(){try{const res=await fetch('/api/last-roll?user=${safeUsername}');const data=await res.json();if(data&&data.timestamp>lastTimestamp){lastTimestamp=data.timestamp;runSequence(data);}}catch(e){}}async function runSequence(data){display.className='active rolling';display.textContent='ROLLING...';betInfo.className='active';betInfo.textContent='BET: '+data.betColor.toUpperCase();await sleep(1500);betInfo.className='';display.className='';const isWin=data.results.some(r=>r.color===data.betColor);if(isWin){display.className='active win';display.textContent='WIN!';}else{display.className='active lose';display.textContent='LOSE!';}await sleep(3000);display.className='';}function sleep(ms){return new Promise(r=>setTimeout(r,ms));}setInterval(poll,500);</script></body></html>`;
    res.send(overlayHtml);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
