const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PRODUCTS = [
  'bega','blackstone','chicken','cottage','disan',
  'eltora','hillcrest','trimat','tricare','berg',
  'wisdom','bebeto','colway'
];

function buildDeck(){
  const deck = [];
  PRODUCTS.forEach(id => { for(let i=0;i<4;i++) deck.push(id); });
  return shuffle(deck);
}

function shuffle(a){
  const arr = [...a];
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

const rooms = {};

function makeRoomId(){
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

function createRoom(){
  const deck = buildDeck();
  return {
    players:       [],
    deck,
    hands:         {},
    pile:          [],
    turn:          null,
    reshuffleUsed: false,
    gameStarted:   false,
    grabLocked:    false,
    phase:         'waiting',
  };
}

function dealHands(room){
  const d = [...room.deck];
  const p = room.players;
  room.hands[p[0].socketId] = d.slice(0,26);
  room.hands[p[1].socketId] = d.slice(26,52);
}

function getOther(room, socketId){
  return room.players.find(p => p.socketId !== socketId);
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name }, cb) => {
    const roomId = makeRoomId();
    rooms[roomId] = createRoom();
    const room = rooms[roomId];
    room.players.push({ socketId: socket.id, name });
    socket.join(roomId);
    socket.roomId = roomId;
    cb({ roomId });
    console.log(`Room ${roomId} created by ${name}`);
  });

  socket.on('join_room', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if(!room)              return cb({ error: 'Room not found' });
    if(room.players.length >= 2) return cb({ error: 'Room is full' });

    room.players.push({ socketId: socket.id, name });
    socket.join(roomId);
    socket.roomId = roomId;

    dealHands(room);
    // Player who created room (index 0) goes first
    room.turn  = room.players[0].socketId;
    room.phase = 'reshuffle';

    const p0 = room.players[0];
    const p1 = room.players[1];

    io.to(p0.socketId).emit('game_ready', {
      mySocketId: p0.socketId,
      myName:     p0.name,
      oppName:    p1.name,
      handCount:  room.hands[p0.socketId].length,
      oppCount:   room.hands[p1.socketId].length,
      turn:       room.turn,
    });

    io.to(p1.socketId).emit('game_ready', {
      mySocketId: p1.socketId,
      myName:     p1.name,
      oppName:    p0.name,
      handCount:  room.hands[p1.socketId].length,
      oppCount:   room.hands[p0.socketId].length,
      turn:       room.turn,
    });

    cb({ ok: true });
    console.log(`${name} joined room ${roomId}`);
  });

  socket.on('reshuffle', () => {
    const room = rooms[socket.roomId];
    if(!room || room.reshuffleUsed || room.phase !== 'reshuffle') return;
    room.reshuffleUsed = true;
    room.deck = buildDeck();
    dealHands(room);

    const p0 = room.players[0];
    const p1 = room.players[1];
    const by = room.players.find(p => p.socketId === socket.id)?.name || '';

    io.to(p0.socketId).emit('reshuffled', {
      handCount: room.hands[p0.socketId].length,
      oppCount:  room.hands[p1.socketId].length,
      by,
    });
    io.to(p1.socketId).emit('reshuffled', {
      handCount: room.hands[p1.socketId].length,
      oppCount:  room.hands[p0.socketId].length,
      by,
    });
  });

  // Only first start_game emission counts
  socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if(!room || room.gameStarted) return;
    room.gameStarted = true;
    room.phase = 'playing';
    io.to(socket.roomId).emit('game_start', { turn: room.turn });
  });

  socket.on('flip', (_, cb) => {
    const room = rooms[socket.roomId];
    if(!room || room.phase !== 'playing') return;
    // Must be this player's turn
    if(room.turn !== socket.id) return;
    // Must have cards
    const hand = room.hands[socket.id];
    if(!hand || !hand.length) return;

    const card = hand.shift();
    room.pile.push(card);

    const isMatch = room.pile.length >= 2 &&
                    room.pile[room.pile.length-1] === room.pile[room.pile.length-2];

    // Switch turn to other player BEFORE emitting
    const other = getOther(room, socket.id);
    if(other) room.turn = other.socketId;

    io.to(socket.roomId).emit('card_flipped', {
      by:       socket.id,
      card,
      pileSize: room.pile.length,
      isMatch,
      // Send authoritative hand counts so clients stay in sync
      handCounts: {
        [socket.id]:  room.hands[socket.id].length,
        [other?.socketId]: room.hands[other?.socketId]?.length ?? 0,
      },
      newTurn: room.turn,
    });

    if(cb) cb({ ok: true });
  });

  socket.on('grab', () => {
    const room = rooms[socket.roomId];
    if(!room || room.phase !== 'playing') return;
    if(room.pile.length === 0) return;
    if(room.grabLocked) return;

    room.grabLocked = true;

    const grabber = room.players.find(p => p.socketId === socket.id);
    const other   = getOther(room, socket.id);
    if(!grabber || !other) return;

    const isMatch   = room.pile.length >= 2 &&
                      room.pile[room.pile.length-1] === room.pile[room.pile.length-2];
    const pileCards = [...room.pile];
    room.pile = [];

    if(isMatch){
      // Correct grab — grabber wins pile, grabber flips next
      room.hands[grabber.socketId] = room.hands[grabber.socketId].concat(pileCards);
      room.turn = grabber.socketId;
    } else {
      // False grab — opponent wins pile, opponent flips next
      room.hands[other.socketId] = room.hands[other.socketId].concat(pileCards);
      room.turn = other.socketId;
    }

    io.to(socket.roomId).emit('grab_result', {
      grabbedBy:   grabber.socketId,
      grabberName: grabber.name,
      isMatch,
      pileSize:    pileCards.length,
      newTurn:     room.turn,
      handCounts: {
        [grabber.socketId]: room.hands[grabber.socketId].length,
        [other.socketId]:   room.hands[other.socketId].length,
      },
    });

    // Check win condition
    const p0Hand = room.hands[room.players[0].socketId];
    const p1Hand = room.hands[room.players[1].socketId];
    if(p0Hand.length === 0 || p1Hand.length === 0){
      const winner = p0Hand.length > 0 ? room.players[0] : room.players[1];
      io.to(socket.roomId).emit('game_over', { winner: winner.name });
    }

    // Unlock after animations complete
    setTimeout(() => { room.grabLocked = false; }, 3500);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if(!roomId || !rooms[roomId]) return;
    const other = getOther(rooms[roomId], socket.id);
    if(other) io.to(other.socketId).emit('opponent_left');
    delete rooms[roomId];
    console.log(`Room ${roomId} closed`);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`GRAB server on port ${PORT}`));