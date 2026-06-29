const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};
const MAFIA_ROLES = ['mafia', 'don', 'silencer'];
const GOOD_ROLES  = ['doctor', 'detective', 'elder', 'avenger', 'sniper', 'civilian'];

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// chance: 0, 25, 50, 75, 100
function rollRole(chance) {
  if (chance === 0)   return false;
  if (chance === 100) return true;
  return Math.random() * 100 < chance;
}

function assignRoles(players, settings) {
  const count = players.length;
  const roles = [];

  // ── Step 1: Mafia team (always guaranteed) ──
  const mafiaCount = Math.min(settings.mafiaCount || 2, Math.floor(count / 2));
  let mafiaLeft = mafiaCount;

  // Don and silencer use probability
  if (mafiaLeft > 0 && rollRole(settings.donChance ?? (settings.hasDon ? 100 : 0))) {
    roles.push('don'); mafiaLeft--;
  }
  if (mafiaLeft > 0 && rollRole(settings.silencerChance ?? (settings.hasSilencer ? 100 : 0))) {
    roles.push('silencer'); mafiaLeft--;
  }
  for (let i = 0; i < mafiaLeft; i++) roles.push('mafia');

  // ── Step 2: Good special roles via probability ──
  const specials = [
    { role: 'doctor',    chance: settings.doctorChance    ?? (settings.hasDoctor    ? 100 : 0) },
    { role: 'detective', chance: settings.detectiveChance ?? (settings.hasDetective ? 100 : 0) },
    { role: 'elder',     chance: settings.elderChance     ?? (settings.hasElder     ? 100 : 0) },
    { role: 'avenger',   chance: settings.avengerChance   ?? (settings.hasAvenger   ? 100 : 0) },
    { role: 'sniper',    chance: settings.sniperChance    ?? (settings.hasSniper    ? 100 : 0) },
  ];

  for (const { role, chance } of specials) {
    if (roles.length < count - 1 && rollRole(chance)) { // always leave room for ≥1 civilian
      roles.push(role);
    }
  }

  // ── Step 3: Fill with civilians ──
  while (roles.length < count) roles.push('civilian');

  // Shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

function getAlive(room)  { return room.players.filter(p => p.alive); }
function getMafia(room)  { return room.players.filter(p => p.alive && MAFIA_ROLES.includes(p.role)); }

function checkWin(room) {
  const alive     = getAlive(room);
  const mafiaLeft = alive.filter(p => MAFIA_ROLES.includes(p.role)).length;
  const goodLeft  = alive.filter(p => !MAFIA_ROLES.includes(p.role)).length;
  if (mafiaLeft === 0)          return 'civilians';
  if (mafiaLeft >= goodLeft)    return 'mafia';
  return null;
}

function sanitize(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, alive: p.alive,
    isHost: p.isHost, silenced: p.silenced || false
  }));
}

function broadcast(room) {
  io.to(room.code).emit('room_update', {
    players: sanitize(room), phase: room.phase,
    day: room.day, settings: room.settings, hostId: room.hostId
  });
}

function setupNight(room) {
  room.mafiaVotes   = {};
  room.mafiaKillTarget = null;
  room.doctorSave   = null;
  room.silencerTarget = null;
  room.nightActionsLeft = [];

  const alive = getAlive(room);
  // Any alive mafia member can vote to kill (even if don is dead)
  if (alive.some(p => MAFIA_ROLES.includes(p.role))) room.nightActionsLeft.push('mafia_kill');
  if (alive.some(p => p.role === 'doctor'))            room.nightActionsLeft.push('doctor');
  if (alive.some(p => p.role === 'detective'))         room.nightActionsLeft.push('detective');
  if (alive.some(p => p.role === 'silencer'))          room.nightActionsLeft.push('silencer');
}

function endGame(room, winner) {
  room.phase = 'ended';
  const reveal = room.players.map(p => ({ name: p.name, role: p.role, alive: p.alive }));
  io.to(room.code).emit('game_over', { winner, rolesReveal: reveal });
  broadcast(room);
}

function checkNightDone(room) {
  const alive = getAlive(room);

  // For each action still in the list, check if a living player can still do it
  // If the role-holder is dead/disconnected, remove that action automatically
  room.nightActionsLeft = room.nightActionsLeft.filter(action => {
    if (action === 'mafia_kill')
      return alive.some(p => MAFIA_ROLES.includes(p.role));
    if (action === 'doctor')
      return alive.some(p => p.role === 'doctor');
    if (action === 'detective')
      return alive.some(p => p.role === 'detective');
    if (action === 'silencer')
      return alive.some(p => p.role === 'silencer');
    return false;
  });

  checkNightDone(room);
}

function resolveNight(room) {
  const results = [];

  // Silencer
  if (room.silencerTarget) {
    const t = room.players.find(p => p.id === room.silencerTarget);
    if (t) t.silenced = true;
  }

  // Mafia kill vs doctor save
  if (room.mafiaKillTarget) {
    if (room.mafiaKillTarget === room.doctorSave) {
      results.push({ type: 'saved' });
    } else {
      const t = room.players.find(p => p.id === room.mafiaKillTarget);
      if (t) {
        t.alive = false;
        results.push({ type: 'killed', name: t.name, role: t.role });

        // Avenger: drags someone with them when killed
        if (t.role === 'avenger' && t.avengerTarget) {
          const victim = room.players.find(p => p.id === t.avengerTarget && p.alive);
          if (victim) {
            victim.alive = false;
            results.push({ type: 'avenger', killedName: t.name, draggedName: victim.name, draggedRole: victim.role });
          }
        }
      }
    }
  }

  const win = checkWin(room);
  if (win) { endGame(room, win); return; }

  room.phase = 'day';
  room.votes = {};
  broadcast(room);
  io.to(room.code).emit('phase_change', {
    phase: 'day', day: room.day, results, players: sanitize(room)
  });
}

function resolveDay(room) {
  const counts = {};
  Object.entries(room.votes).forEach(([voterId, targetId]) => {
    const voter = room.players.find(p => p.id === voterId);
    // Elder vote counts as 3
    const weight = (voter && voter.role === 'elder' && voter.elderRevealed) ? 3 : 1;
    counts[targetId] = (counts[targetId] || 0) + weight;
  });

  let eliminated = null;
  if (Object.keys(counts).length > 0) {
    const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const target = room.players.find(p => p.id === topId);
    if (target) {
      target.alive = false;
      eliminated = { name: target.name, role: target.role };

      // Avenger: drags someone when eliminated by vote
      if (target.role === 'avenger' && target.avengerTarget) {
        const victim = room.players.find(p => p.id === target.avengerTarget && p.alive);
        if (victim) {
          victim.alive = false;
          eliminated.avengerDragged = { name: victim.name, role: victim.role };
        }
      }
    }
  }

  room.players.forEach(p => { p.silenced = false; });

  const win = checkWin(room);
  if (win) { endGame(room, win); return; }

  room.phase = 'night';
  room.day++;
  setupNight(room);
  broadcast(room);
  io.to(room.code).emit('phase_change', {
    phase: 'night', day: room.day, eliminated, players: sanitize(room)
  });
}

// ─── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create_room', ({ name, settings }) => {
    const code = generateCode();
    rooms[code] = {
      code, hostId: socket.id, phase: 'lobby', day: 0,
      settings: settings || {}, players: [],
      votes: {}, mafiaVotes: {}, mafiaKillTarget: null,
      doctorSave: null, silencerTarget: null,
      nightActionsLeft: [], sniperUsed: false
    };
    rooms[code].players.push({ id: socket.id, name, alive: true, isHost: true, role: null });
    socket.join(code);
    socket.emit('room_created', { code });
    broadcast(rooms[code]);
  });

  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room)                    return socket.emit('error', { msg: 'room_not_found' });
    if (room.phase !== 'lobby')   return socket.emit('error', { msg: 'game_started' });
    if (room.players.length >= (room.settings.maxPlayers || 8)) return socket.emit('error', { msg: 'room_full' });
    room.players.push({ id: socket.id, name, alive: true, isHost: false, role: null });
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcast(room);
  });

  // Host can update settings while in lobby
  socket.on('update_settings', ({ code, settings }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    room.settings = { ...room.settings, ...settings };
    broadcast(room); // sends updated settings to all players
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 4) return socket.emit('error', { msg: 'need_more_players' });

    const roles = assignRoles(room.players, room.settings);
    room.players.forEach((p, i) => { p.role = roles[i]; p.elderRevealed = false; p.avengerTarget = null; });
    room.phase = 'night';
    room.day = 1;
    room.sniperUsed = false;

    // Send each player their role privately
    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (!sock) return;
      const mafiaTeam = MAFIA_ROLES.includes(p.role)
        ? getMafia(room).map(m => ({ id: m.id, name: m.name, role: m.role }))
        : null;
      sock.emit('role_assigned', { role: p.role, mafiaTeam });
    });

    setupNight(room);
    broadcast(room);
    io.to(code).emit('phase_change', { phase: 'night', day: room.day, players: sanitize(room) });
  });

  // ── Night: Mafia kill — any alive mafia member can vote ──
  socket.on('mafia_vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    // All mafia roles except silencer-only participate in kill vote
    if (!player || !MAFIA_ROLES.includes(player.role)) return;

    room.mafiaVotes[socket.id] = targetId;

    // Count how many alive mafia should vote (all mafia roles)
    const killers = room.players.filter(p => p.alive && MAFIA_ROLES.includes(p.role));
    if (Object.keys(room.mafiaVotes).length >= killers.length) {
      // Pick target by majority
      const counts = {};
      Object.values(room.mafiaVotes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
      room.mafiaKillTarget = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
      room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'mafia_kill');
      io.to(code).emit('mafia_voted');
      checkNightDone(room);
    }
  });

  // ── Night: Silencer (can silence self) ──
  socket.on('silencer_action', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'silencer') return;
    room.silencerTarget = targetId;
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'silencer');
    checkNightDone(room);
  });

  // ── Night: Doctor ──
  socket.on('doctor_save', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    room.doctorSave = targetId;
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'doctor');
    checkNightDone(room);
  });

  // ── Night: Detective ──
  socket.on('detective_check', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    const isMafia = target && MAFIA_ROLES.includes(target.role);
    socket.emit('detective_result', { targetName: target?.name, isMafia });
    room.nightActionsLeft = room.nightActionsLeft.filter(a => a !== 'detective');
    checkNightDone(room);
  });

  // ── Avenger: sets their drag target (can change any time while alive) ──
  socket.on('avenger_set_target', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'avenger' || !player.alive) return;
    player.avengerTarget = targetId;
    socket.emit('avenger_confirmed', { targetId });
  });

  // ── Elder: reveal card to triple vote weight ──
  socket.on('elder_reveal', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'elder' || !player.alive) return;
    player.elderRevealed = true;
    // Announce to room that elder revealed (everyone sees)
    io.to(code).emit('elder_revealed', { name: player.name });
  });

  // ── Sniper: one shot per game, during day ──
  socket.on('sniper_shoot', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const sniper = room.players.find(p => p.id === socket.id);
    if (!sniper || sniper.role !== 'sniper' || !sniper.alive) return;
    if (room.sniperUsed) return socket.emit('error', { msg: 'sniper_used' });
    room.sniperUsed = true;

    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target) return;

    const isMafia = MAFIA_ROLES.includes(target.role);
    if (isMafia) {
      // Hit: target dies, sniper survives, role stays hidden
      target.alive = false;
      broadcast(room);
      io.to(code).emit('sniper_result', { hit: true, targetName: target.name, targetRole: target.role });
      const win = checkWin(room);
      if (win) endGame(room, win);
    } else {
      // Miss: both die
      target.alive = false;
      sniper.alive = false;
      broadcast(room);
      io.to(code).emit('sniper_result', { hit: false, targetName: target.name, targetRole: target.role, sniperName: sniper.name });
      const win = checkWin(room);
      if (win) endGame(room, win);
    }
  });

  // ── Day vote ──
  socket.on('day_vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive || voter.silenced) return;
    room.votes[socket.id] = targetId;
    broadcast(room); // so others see vote counts
    io.to(code).emit('vote_update', { votes: room.votes });
    // Auto-resolve when all non-silenced alive players voted
    const eligible = getAlive(room).filter(p => !p.silenced);
    if (Object.keys(room.votes).length >= eligible.length) resolveDay(room);
  });

  socket.on('end_voting', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    resolveDay(room);
  });

  // ── Chat ──
  socket.on('send_message', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    if (room.phase === 'night') {
      if (!MAFIA_ROLES.includes(player.role)) return;
      getMafia(room).forEach(m => {
        const s = io.sockets.sockets.get(m.id);
        if (s) s.emit('chat_message', { name: player.name, text, type: 'mafia' });
      });
      return;
    }
    io.to(code).emit('chat_message', { name: player.name, text, type: 'public' });
  });

  // ── Rejoin (after disconnect/refresh) ──
  socket.on('rejoin_room', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'room_not_found' });

    // Find disconnected player by name
    const player = room.players.find(p => p.name === name && p.disconnected);
    if (player) {
      // Restore their socket id
      const oldId = player.id;
      player.id = socket.id;
      player.disconnected = false;

      // Update votes/actions that referenced old id
      if (room.votes[oldId])      { room.votes[socket.id] = room.votes[oldId];      delete room.votes[oldId]; }
      if (room.mafiaVotes[oldId]) { room.mafiaVotes[socket.id] = room.mafiaVotes[oldId]; delete room.mafiaVotes[oldId]; }
      if (room.hostId === oldId)  room.hostId = socket.id;
      if (player.isHost)          player.isHost = true;

      socket.join(code);
      socket.emit('room_joined', { code, rejoin: true });

      // Resend their role if game is running
      if (room.phase !== 'lobby' && room.phase !== 'ended' && player.role) {
        const mafiaTeam = MAFIA_ROLES.includes(player.role)
          ? getMafia(room).map(m => ({ id: m.id, name: m.name, role: m.role }))
          : null;
        socket.emit('role_assigned', { role: player.role, mafiaTeam });
        socket.emit('phase_change', {
          phase: room.phase, day: room.day, players: sanitize(room)
        });
      }
      broadcast(room);
    } else {
      // Not found as disconnected — try normal join
      if (room.phase !== 'lobby') return socket.emit('error', { msg: 'game_started' });
      if (room.players.length >= (room.settings.maxPlayers || 8)) return socket.emit('error', { msg: 'room_full' });
      room.players.push({ id: socket.id, name, alive: true, isHost: false, role: null });
      socket.join(code);
      socket.emit('room_joined', { code });
      broadcast(room);
    }
  });

  // ── Rematch: reset room to lobby, keep same players ──
  socket.on('rematch', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;

    // Reset game state but keep players and settings
    room.phase = 'lobby';
    room.day = 0;
    room.votes = {};
    room.mafiaVotes = {};
    room.mafiaKillTarget = null;
    room.doctorSave = null;
    room.silencerTarget = null;
    room.nightActionsLeft = [];
    room.sniperUsed = false;
    room.players.forEach(p => {
      p.alive = true;
      p.role = null;
      p.silenced = false;
      p.elderRevealed = false;
      p.avengerTarget = null;
      p.disconnected = false;
    });

    broadcast(room);
    io.to(code).emit('rematch_started');
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      const player = room.players[idx];

      if (room.phase === 'lobby') {
        // In lobby: remove immediately
        room.players.splice(idx, 1);
        io.to(code).emit('player_left', { name: player.name });
        if (room.players.length === 0) { delete rooms[code]; }
        else {
          if (player.isHost) { room.players[0].isHost = true; room.hostId = room.players[0].id; }
          broadcast(room);
        }
      } else if (room.phase === 'ended') {
        // After game ended: remove
        room.players.splice(idx, 1);
        if (room.players.length === 0) delete rooms[code];
      } else {
        // Mid-game: mark as disconnected, give 60s to rejoin
        player.disconnected = true;
        io.to(code).emit('player_disconnected', { name: player.name });
        broadcast(room);

        setTimeout(() => {
          // Still disconnected after 60s? Mark dead
          if (player.disconnected) {
            player.alive = false;
            player.disconnected = false;
            io.to(code).emit('player_left', { name: player.name });
            broadcast(room);
            // Check if game should end
            const win = checkWin(room);
            if (win) { endGame(room, win); return; }
            // If night, their action might have been pending — check if night can resolve now
            if (room.phase === 'night') checkNightDone(room);
          }
        }, 60000);
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mafia server running on port ${PORT}`));
