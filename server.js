const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  allowUpgrades: false,
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

const PRODUCTS = [
  'bega','blackstone','chicken','cottage','disan',
  'eltora','hillcrest','trimat','tricare','berg',
  'wisdom','bebeto','colway'
];

function buildDeck(biased=false){
  const deck = [];
  PRODUCTS.forEach(id => { for(let i=0;i<4;i++) deck.push(id); });
  if(biased) return biasedShuffle(deck);
  return shuffle(deck);
}

function biasedShuffle(deck){
  // Start with a full random shuffle
  const d = shuffle(deck);

  // Inject 6 guaranteed adjacent pairs at random positions
  // Pick 6 random products, find two copies each and place them adjacent
  const targets = shuffle([...PRODUCTS]).slice(0, 6);

  targets.forEach(product => {
    // Find two instances of this product in the deck
    const indices = [];
    for(let i=0;i<d.length;i++){
      if(d[i]===product) indices.push(i);
      if(indices.length===2) break;
    }
    if(indices.length < 2) return;

    const [i1, i2] = indices;
    // Remove second instance from its current position
    d.splice(i2, 1);
    // Re-find first instance (index may have shifted)
    const newI1 = d.indexOf(product);
    // Insert second instance right after first — but not at position 0 or 1
    // to avoid a match on the very first flip
    const insertAt = Math.max(2, newI1 + 1);
    d.splice(insertAt, 0, product);
  });

  return d;
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
  const deck = buildDeck(true); // biased for first deal
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
  // Deal alternating cards so pile plays in true deck order
  // p0 gets cards 0,2,4,6... p1 gets 1,3,5,7...
  // When they alternate flipping the pile sequence is deck[0],deck[1],deck[2]...
  const h0 = [], h1 = [];
  for(let i=0;i<d.length;i++){
    if(i%2===0) h0.push(d[i]);
    else h1.push(d[i]);
  }
  room.hands[p[0].socketId] = h0;
  room.hands[p[1].socketId] = h1;
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
    room.deck = buildDeck(true); // biased on manual reshuffle too
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
    // If this player has no cards, pass turn to other player
    const hand = room.hands[socket.id];
    if(!hand || !hand.length){
      const other = getOther(room, socket.id);
      if(other){
        room.turn = other.socketId;
        io.to(socket.roomId).emit('turn_change', { turn: room.turn });
      }
      return;
    }

    const card = hand.shift();
    room.pile.push(card);

    const isMatch = room.pile.length >= 2 &&
                    room.pile[room.pile.length-1] === room.pile[room.pile.length-2];

    // Switch turn to other player
    const other = getOther(room, socket.id);
    if(other) room.turn = other.socketId;

    // If next player has no cards, skip back to current player immediately
    if(other && room.hands[other.socketId].length === 0){
      room.turn = socket.id;
    }

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

    // Check if both hands empty — reshuffle and redeal
    const p0 = room.players[0], p1 = room.players[1];
    if(room.hands[p0.socketId].length === 0 && room.hands[p1.socketId].length === 0 && room.pile.length === 0){
      // Full deck exhausted with no match — reshuffle everything
      room.deck = buildDeck(false); // normal shuffle after deck exhausted
      dealHands(room);
      room.turn = room.players[0].socketId;
      io.to(socket.roomId).emit('deck_empty');
      // After short delay send new hand counts
      setTimeout(()=>{
        io.to(p0.socketId).emit('new_deal', {
          handCount: room.hands[p0.socketId].length,
          oppCount:  room.hands[p1.socketId].length,
          turn:      room.turn,
          mySocketId: p0.socketId,
        });
        io.to(p1.socketId).emit('new_deal', {
          handCount: room.hands[p1.socketId].length,
          oppCount:  room.hands[p0.socketId].length,
          turn:      room.turn,
          mySocketId: p1.socketId,
        });
      }, 3200);
    }

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

    // Snapshot hand sizes BEFORE adding pile cards — for win condition check
    const grabberCountBefore = room.hands[grabber.socketId].length;
    const otherCountBefore   = room.hands[other.socketId].length;

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

    const p0 = room.players[0];
    const p1 = room.players[1];
    const p0Hand = room.hands[p0.socketId];
    const p1Hand = room.hands[p1.socketId];

    if(isMatch){
      // Game over only if loser had zero cards BEFORE the grab
      // (they had no hand cards and just lost the pile too)
      if(otherCountBefore === 0){
        io.to(socket.roomId).emit('game_over', { winner: grabber.name });
        return;
      }
    } else {
      // False grab — game over only if grabber had zero cards before grab
      if(grabberCountBefore === 0){
        io.to(socket.roomId).emit('game_over', { winner: other.name });
        return;
      }
    }

    // If one player has no cards, the other keeps flipping
    if(p0Hand.length === 0) room.turn = p1.socketId;
    if(p1Hand.length === 0) room.turn = p0.socketId;

    // Unlock after animations complete
    setTimeout(() => { room.grabLocked = false; }, 3500);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if(!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    // If game not started yet and only 1 player, just clean up silently
    // Give 30 seconds grace period for reconnection before closing room
    setTimeout(() => {
      if(!rooms[roomId]) return;
      const other = getOther(rooms[roomId], socket.id);
      if(other) io.to(other.socketId).emit('opponent_left');
      delete rooms[roomId];
      console.log(`Room ${roomId} closed`);
    }, room.phase === 'waiting' ? 0 : 30000);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`GRAB server on port ${PORT}`));

// Keepalive — prevent Render from sleeping
const https = require('https');
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_URL;
  if(host){
    https.get(host, ()=>{}).on('error', ()=>{});
  }
}, 840000); // ping every 14 minutes