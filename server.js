const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Game State ───────────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function assignRoles(players, settings) {
  const roles = [];
  const mafiaCount = settings.mafiaCount || 2;
  const hasDon = settings.hasDon || false;
  const hasSilencer = settings.hasSilencer || false;
  const hasDoctor = settings.hasDoctor !== false;
  const hasDetective = settings.hasDetective !== false;
  const hasCivilian = true;

  if (hasDon) roles.push('don');
  let mafiaLeft = hasDon ? mafiaCount - 1 : mafiaCount;
  for (let i = 0; i < mafiaLeft; i++) roles.push('mafia');
  if (hasDoctor) roles.push('doctor');
  if (hasDetective) roles.push('detective');
  if (hasSilencer) roles.push('silencer');

  const civiliansNeeded = players.length - roles.length;
  for (let i = 0; i < civiliansNeeded; i++) roles.push('civilian');

  // Shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

function getAlivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function getMafiaPlayers(room) {
  return room.players.filter(p => p.alive && ['mafia','don','silencer'].includes(p.role));
}

function checkWinCondition(room) {
  const alive = getAlivePlayers(room);
  const mafiaAlive = alive.filter(p => ['mafia','don','silencer'].includes(p.role)).length;
  const civiliansAlive = alive.filter(p => !['mafia','don','silencer'].includes(p.role)).length;

  if (mafiaAlive === 0) return 'civilians';
  if (mafiaAlive >= civiliansAlive) return 'mafia';
  return null;
}

function broadcastRoom(room) {
  const sanitized = room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isHost: p.isHost,
    silenced: p.silenced || false
  }));
  io.to(room.code).emit('room_update', {
    players: sanitized,
    phase: room.phase,
    day: room.day,
    settings: room.settings,
    hostId: room.hostId
  });
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('create_room', ({ name, settings }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      phase: 'lobby',
      day: 0,
      settings: settings || {},
      players: [],
      votes: {},
      mafiaVotes: {},
      doctorSave: null,
      detectiveCheck: null,
      silencerTarget: null,
      nightActionsLeft: [],
      chat: []
    };

    const room = rooms[code];
    room.players.push({ id: socket.id, name, alive: true, isHost: true, role: null });
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastRoom(room);
  });

  // Join room
  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'room_not_found' });
    if (room.phase !== 'lobby') return socket.emit('error', { msg: 'game_started' });
    if (room.players.length >= 15) return socket.emit('error', { msg: 'room_full' });

    room.players.push({ id: socket.id, name, alive: true, isHost: false, role: null });
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastRoom(room);
  });

  // Start game
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 4) return socket.emit('error', { msg: 'need_more_players' });

    const roles = assignRoles(room.players, room.settings);
    room.players.forEach((p, i) => { p.role = roles[i]; });
    room.phase = 'night';
    room.day = 1;

    // Send each player their role privately
    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        const mafiaTeam = ['mafia','don','silencer'].includes(p.role)
          ? getMafiaPlayers(room).map(m => ({ id: m.id, name: m.name, role: m.role }))
          : null;
        sock.emit('role_assigned', { role: p.role, mafiaTeam });
      }
    });

    // Setup night actions
    setupNightActions(room);
    broadcastRoom(room);
    const sanitizedStart = room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, isHost: p.isHost, silenced: false }));
    io.to(room.code).emit('phase_change', { phase: 'night', day: room.day, players: sanitizedStart });
  });

  function setupNightActions(room) {
    room.mafiaVotes = {};
    room.doctorSave = null;
    room.detectiveCheck = null;
    room.silencerTarget = null;
    room.nightActionsLeft = [];

    const alive = getAlivePlayers(room);
    if (alive.some(p => ['mafia','don'].includes(p.role))) room.nightActionsLeft.push('mafia_kill');
    if (alive.some(p => p.role === 'silencer')) room.nightActionsLeft.push('silencer');
    if (alive.some(p => p.role === 'doctor')) room.nightActionsLeft.push('doctor');
    if (alive.some(p => p.role === 'detective')) room.nightActionsLeft.push('detective');
  }

  // Night action: Mafia kill vote
  socket.on('mafia_vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !['mafia','don'].includes(player.role)) return;

    room.mafiaVotes[socket.id] = targetId;

    // Only mafia + don vote to kill (silencer acts separately)
    const mafiaKillers = room.players.filter(p => p.alive && ['mafia','don'].includes(p.role));
    if (Object.keys(room.mafiaVotes).length >= mafiaKillers.length) {
      // Majority vote
      const counts = {};
      Object.values(room.mafiaVotes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
      const targetId = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
      room.mafiaKillTarget = targetId;
      room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'mafia_kill');
      io.to(room.code).emit('mafia_voted');
      checkNightComplete(room);
    }
  });

  // Night action: Silencer
  socket.on('silencer_action', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    room.silencerTarget = targetId;
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'silencer');
    checkNightComplete(room);
  });

  // Night action: Doctor save
  socket.on('doctor_save', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    room.doctorSave = targetId;
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'doctor');
    checkNightComplete(room);
  });

  // Night action: Detective check
  socket.on('detective_check', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    const isMafia = target && ['mafia','don','silencer'].includes(target.role);
    socket.emit('detective_result', { targetName: target?.name, isMafia });
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'detective');
    checkNightComplete(room);
  });

  function checkNightComplete(room) {
    if (room.nightActionsLeft.length > 0) return;
    resolveNight(room);
  }

  function resolveNight(room) {
    const results = [];
    let killed = null;

    // Apply silencer
    if (room.silencerTarget) {
      const target = room.players.find(p => p.id === room.silencerTarget);
      if (target) { target.silenced = true; }
    }

    // Apply kill
    if (room.mafiaKillTarget) {
      if (room.mafiaKillTarget === room.doctorSave) {
        results.push({ type: 'saved' });
      } else {
        const target = room.players.find(p => p.id === room.mafiaKillTarget);
        if (target) {
          target.alive = false;
          killed = { name: target.name, role: target.role };
          results.push({ type: 'killed', name: target.name, role: target.role });
        }
      }
    }

    const win = checkWinCondition(room);
    if (win) {
      endGame(room, win);
      return;
    }

    room.phase = 'day';
    room.votes = {};
    const sanitizedDay = room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, isHost: p.isHost, silenced: p.silenced || false }));
    broadcastRoom(room);
    io.to(room.code).emit('phase_change', { phase: 'day', day: room.day, results, players: sanitizedDay });
  }

  // Day vote
  socket.on('day_vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive || voter.silenced) return;

    room.votes[socket.id] = targetId;

    const alivePlayers = getAlivePlayers(room);
    io.to(room.code).emit('vote_update', { votes: room.votes, total: alivePlayers.length });

    // Check if all voted
    if (Object.keys(room.votes).length >= alivePlayers.length) {
      resolveDay(room);
    }
  });

  // Host force end voting
  socket.on('end_voting', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    resolveDay(room);
  });

  function resolveDay(room) {
    const counts = {};
    Object.values(room.votes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });

    let eliminated = null;
    if (Object.keys(counts).length > 0) {
      const topId = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
      const target = room.players.find(p => p.id === topId);
      if (target) {
        target.alive = false;
        eliminated = { name: target.name, role: target.role };
      }
    }

    // Reset silenced
    room.players.forEach(p => { p.silenced = false; });

    const win = checkWinCondition(room);
    if (win) {
      endGame(room, win);
      return;
    }

    room.phase = 'night';
    room.day++;
    setupNightActions(room);
    const sanitizedNight = room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, isHost: p.isHost, silenced: p.silenced || false }));
    broadcastRoom(room);
    io.to(room.code).emit('phase_change', { phase: 'night', day: room.day, eliminated, players: sanitizedNight });
  }

  function endGame(room, winner) {
    room.phase = 'ended';
    const rolesReveal = room.players.map(p => ({ name: p.name, role: p.role, alive: p.alive }));
    io.to(room.code).emit('game_over', { winner, rolesReveal });
    broadcastRoom(room);
  }

  // Chat
  socket.on('send_message', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    // During night, only mafia can chat (to each other)
    if (room.phase === 'night') {
      if (!['mafia','don','silencer'].includes(player.role)) return;
      getMafiaPlayers(room).forEach(m => {
        const sock = io.sockets.sockets.get(m.id);
        if (sock) sock.emit('chat_message', { name: player.name, text, type: 'mafia' });
      });
      return;
    }

    io.to(room.code).emit('chat_message', { name: player.name, text, type: 'public' });
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const player = room.players[idx];
      io.to(code).emit('player_left', { name: player.name });

      if (room.phase === 'lobby') {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (player.isHost) {
            room.players[0].isHost = true;
            room.hostId = room.players[0].id;
          }
          broadcastRoom(room);
        }
      } else {
        // In-game: mark as dead
        player.alive = false;
        broadcastRoom(room);
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mafia server running on port ${PORT}`));
