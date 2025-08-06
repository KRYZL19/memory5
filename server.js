const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });
const multer = require('multer');
const path = require('path');

app.use(express.static('public'));

// Bildupload-Setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Upload-Route
app.post('/upload', upload.array('images', 20), (req, res) => {
    const files = req.files.map(f => `/uploads/${f.filename}`);
    console.log(`[UPLOAD] ${files.length} Bilder hochgeladen:`, files);
    res.json({ success: true, filenames: files });
});

// Standardbilder
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);
const rooms = new Map();

function getRandomImages(count) {
    return [...images].sort(() => 0.5 - Math.random()).slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`🔌 [CONNECT] Neuer Spieler verbunden: ${socket.id}`);

    // Raum erstellen
    socket.on('createRoom', ({ roomId, playerName, turnTime, customImages = [], pairCount = 8 }) => {
        console.log(`[CREATE ROOM] ${playerName} erstellt Raum: ${roomId}, Paare: ${pairCount}, Zugzeit: ${turnTime}s`);

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
        logRoom(roomId);
    });

    // Raum beitreten
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        console.log(`[JOIN ROOM] Spieler ${playerName} versucht Raum ${roomId} zu joinen.`);

        if (!room) return socket.emit('joinError', 'Raum nicht gefunden.');
        if (room.players.length >= 2) return socket.emit('joinError', 'Raum voll.');

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);
        logRoom(roomId);

        // Spiel starten, wenn 2 Spieler da sind
        if (room.players.length === 2) {
            console.log(`[START GAME] 2 Spieler im Raum ${roomId}. Spiel startet...`);
            startGame(roomId);
        }
    });

    // Spiel starten
    function startGame(roomId) {
        const room = rooms.get(roomId);
        if (!room) return;

        const needed = room.pairCount;
        const custom = room.customImages || [];

        // Bilder auffüllen
        const filledImages = custom.length >= needed 
            ? [...custom].sort(() => 0.5 - Math.random()).slice(0, needed)
            : [...custom, ...getRandomImages(needed - custom.length)];

        const cardPairs = [...filledImages, ...filledImages].sort(() => 0.5 - Math.random());
        room.cards = cardPairs.map((img, i) => ({ id: i, image: img, isFlipped: false, isMatched: false }));
        room.currentTurn = room.players[0].id;
        room.gameStarted = true;

        console.log(`[GAME STARTED] Raum ${roomId} mit ${needed} Paaren`);
        logRoom(roomId);

        io.to(roomId).emit('gameStart', { 
            cards: room.cards, 
            currentTurn: room.currentTurn, 
            players: room.players, 
            roomId, 
            pairCount: needed 
        });
    }

    // Karte flippen
    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('flipError', 'Raum nicht verfügbar.');
        if (!room.gameStarted || room.locked) return;
        if (socket.id !== room.currentTurn) return socket.emit('flipError', 'Nicht dein Zug.');

        const card = room.cards[cardId];
        if (!card || card.isFlipped || card.isMatched) return;

        console.log(`[FLIP] Spieler ${socket.id} flippt Karte ${cardId} im Raum ${roomId}`);
        card.isFlipped = true;
        io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players, pairCount: room.pairCount });

        const flipped = room.cards.filter(c => c.isFlipped && !c.isMatched);

        if (flipped.length === 2) {
            room.locked = true;
            if (flipped[0].image === flipped[1].image) {
                flipped.forEach(c => c.isMatched = true);
                const player = room.players.find(p => p.id === socket.id);
                player.score++;
                console.log(`[MATCH] Spieler ${player.name} hat ein Paar gefunden.`);
                room.locked = false;
            } else {
                console.log(`[NO MATCH] Karten drehen sich zurück...`);
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

    // Spielende
    function endGame(roomId) {
        const room = rooms.get(roomId);
        const [p1, p2] = room.players;
        const winner = p1.score === p2.score ? 'Unentschieden' : (p1.score > p2.score ? p1.name : p2.name);
        console.log(`[GAME END] Raum ${roomId} beendet. Gewinner: ${winner}`);
        io.to(roomId).emit('gameEnd', { winner });
        rooms.delete(roomId);
    }

    // Chat
    socket.on('sendChatMessage', ({ roomId, name, message }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const chatMessage = { name, message, time: new Date().toLocaleTimeString() };
        room.chat.push(chatMessage);
        io.to(roomId).emit('newChatMessage', chatMessage);
        console.log(`[CHAT] ${name}: ${message}`);
    });

    // Debug-Hilfsfunktion
    function logRoom(roomId) {
        const room = rooms.get(roomId);
        console.log(`[DEBUG] Raum ${roomId}:`, {
            players: room.players.map(p => `${p.name} (Score: ${p.score})`),
            currentTurn: room.currentTurn,
            pairs: room.pairCount,
            started: room.gameStarted
        });
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`✅ Server läuft auf Port ${PORT}`));
