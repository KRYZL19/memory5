const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });
const multer = require('multer');
const path = require('path');

app.use(express.static('public'));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ 
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif'];
        if (allowed.includes(file.mimetype)) cb(null, true); 
        else cb(new Error('Nur Bilder erlaubt.'));
    }
});

app.post('/upload', upload.array('images', 20), (req, res) => {
    const files = req.files.map(f => `/uploads/${f.filename}`);
    res.json({ success: true, filenames: files });
});

const rooms = new Map();
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i+1}.jpg`);

function getRandomImages(count) {
    return [...images].sort(() => 0.5 - Math.random()).slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`🔌 Neue Verbindung: ${socket.id}`);

    socket.on('createRoom', ({ roomId, playerName, turnTime, customImages = [], pairCount = 8 }) => {
        if (!roomId || !playerName || !turnTime) return socket.emit('joinError', 'Alle Felder erforderlich.');
        if (rooms.has(roomId)) return socket.emit('joinError', 'Raum-ID vergeben.');

        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false,
            chat: [],
            turnTime,
            customImages,
            pairCount: parseInt(pairCount)
        });

        socket.join(roomId);
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('joinError', 'Raum nicht gefunden.');
        if (room.players.length >= 2) return socket.emit('joinError', 'Raum voll.');

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);

        if (room.players.length === 2) startGame(roomId);
    });

    function startGame(roomId) {
        const room = rooms.get(roomId);
        const needed = room.pairCount;
        const custom = room.customImages || [];

        // Auffüllen mit Standardbildern falls nötig
        const filledImages = custom.length >= needed 
            ? [...custom].sort(() => 0.5 - Math.random()).slice(0, needed)
            : [...custom, ...getRandomImages(needed - custom.length)];

        const cardPairs = [...filledImages, ...filledImages].sort(() => 0.5 - Math.random());
        room.cards = cardPairs.map((img, i) => ({ id: i, image: img, isFlipped: false, isMatched: false }));
        room.currentTurn = room.players[0].id;
        room.gameStarted = true;
        io.to(roomId).emit('gameStart', { cards: room.cards, currentTurn: room.currentTurn, players: room.players, roomId, pairCount: needed });
    }

    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('flipError', 'Raum nicht verfügbar.');
        if (!room.gameStarted || room.locked) return;
        if (socket.id !== room.currentTurn) return socket.emit('flipError', 'Nicht dein Zug.');

        const card = room.cards[cardId];
        if (!card || card.isFlipped || card.isMatched) return;

        card.isFlipped = true;
        io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players, pairCount: room.pairCount });
        const flipped = room.cards.filter(c => c.isFlipped && !c.isMatched);

        if (flipped.length === 2) {
            room.locked = true;
            if (flipped[0].image === flipped[1].image) {
                flipped.forEach(c => c.isMatched = true);
                const player = room.players.find(p => p.id === socket.id);
                player.score++;
                room.locked = false;
            } else {
                setTimeout(() => {
                    flipped.forEach(c => c.isFlipped = false);
                    room.currentTurn = room.players.find(p => p.id !== room.currentTurn).id;
                    room.locked = false;
                    io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players, pairCount: room.pairCount });
                }, 2000);
            }
            io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players, pairCount: room.pairCount });
            if (room.cards.every(c => c.isMatched)) endGame(roomId);
        }
    });

    function endGame(roomId) {
        const room = rooms.get(roomId);
        const [p1, p2] = room.players;
        const winner = p1.score === p2.score ? 'Unentschieden' : (p1.score > p2.score ? p1.name : p2.name);
        io.to(roomId).emit('gameEnd', { winner });
        rooms.delete(roomId);
    }

    socket.on('sendChatMessage', ({ roomId, name, message }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const chatMessage = { name, message, time: new Date().toLocaleTimeString() };
        room.chat.push(chatMessage);
        io.to(roomId).emit('newChatMessage', chatMessage);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`✅ Server läuft auf Port ${PORT}`));
