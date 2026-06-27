const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

app.use(cors({ origin: 'https://fair-dice.onrender.com' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
    serverSeed: '',
    hashedServerSeed: '',
    clientSeed: '',
    nonce: 0,
    balance: 1000
};

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        gameState = JSON.parse(data);
    } else {
        generateNewRound();
        saveState();
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(gameState, null, 2));
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
}

function calculateRoll(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}-${nonce}`);
    const hash = hmac.digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return num % 4;
}

app.get('/api/init', (req, res) => {
    res.json({
        balance: gameState.balance,
        hashedServerSeed: gameState.hashedServerSeed,
        clientSeed: gameState.clientSeed,
        nonce: gameState.nonce
    });
});

app.post('/api/roll', (req, res) => {
    const { color, betAmount } = req.body;

    if (!color || !betAmount || betAmount <= 0) {
        return res.status(400).json({ error: 'Invalid bet parameters' });
    }

    if (betAmount > gameState.balance) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }

    const colorIndex = { red: 0, blue: 1, green: 2, purple: 3 }[color.toLowerCase()];
    if (colorIndex === undefined) {
        return res.status(400).json({ error: 'Invalid color' });
    }

    const resultIndex = calculateRoll(gameState.serverSeed, gameState.clientSeed, gameState.nonce);
    const colors = ['red', 'blue', 'green', 'purple'];
    const resultColor = colors[resultIndex];
    
    let payout = 0;
    let win = false;

    if (resultIndex === colorIndex) {
        payout = betAmount * 3.5;
        gameState.balance += (payout - betAmount);
        win = true;
    } else {
        gameState.balance -= betAmount;
    }

    const revealedServerSeed = gameState.serverSeed;
    
    gameState.nonce += 1;
    
    if (gameState.nonce >= 10) {
        generateNewRound();
    }
    
    saveState();

    res.json({
        win: win,
        resultColor: resultColor,
        payout: payout,
        newBalance: gameState.balance,
        revealedServerSeed: revealedServerSeed,
        nextHashedServerSeed: gameState.hashedServerSeed,
        nextClientSeed: gameState.clientSeed,
        nextNonce: gameState.nonce
    });
});

app.post('/api/verify', (req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body;
    
    if (!serverSeed || !clientSeed || nonce === undefined) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const expectedHash = hashSeed(serverSeed);
    const resultIndex = calculateRoll(serverSeed, clientSeed, nonce);
    const colors = ['red', 'blue', 'green', 'purple'];

    res.json({
        validHash: expectedHash,
        resultColor: colors[resultIndex],
        resultIndex: resultIndex
    });
});

app.post('/api/reset', (req, res) => {
    gameState.balance = 1000;
    generateNewRound();
    saveState();
    res.json({ balance: gameState.balance });
});

loadState();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
