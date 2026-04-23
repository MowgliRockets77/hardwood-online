const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── ROOM MANAGEMENT ──────────────────────────────────────
const rooms = new Map(); // roomCode → Room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? makeCode() : c;
}

function makeRoom(code) {
  return {
    code,
    players: [],       // [{id, team, slot, name}]
    state: 'waiting',  // waiting | playing | over
    game: null
  };
}

function makeGameState() {
  const CW = 28, CD = 16;
  const midX = CW / 2, midZ = CD / 2;
  return {
    scores: [0, 0],
    quarter: 1,
    timeLeft: 120,
    tick: 0,
    players: [
      { id: 0, team: 0, wx: midX-4, wz: midZ-1.5, wy: 0, jumpH: 0, hasBall: true,  facing: 1,  shooting: false, shootT: 0, celebrating: 0, shotCD: 0, stealCD: 0 },
      { id: 1, team: 0, wx: midX-4, wz: midZ+1.5, wy: 0, jumpH: 0, hasBall: false, facing: 1,  shooting: false, shootT: 0, celebrating: 0, shotCD: 0, stealCD: 0 },
      { id: 2, team: 1, wx: midX+4, wz: midZ-1.5, wy: 0, jumpH: 0, hasBall: false, facing: -1, shooting: false, shootT: 0, celebrating: 0, shotCD: 0, stealCD: 0 },
      { id: 3, team: 1, wx: midX+4, wz: midZ+1.5, wy: 0, jumpH: 0, hasBall: false, facing: -1, shooting: false, shootT: 0, celebrating: 0, shotCD: 0, stealCD: 0 },
    ],
    ball: { wx: midX-4, wz: midZ-1.5, wy: 0.3, ownerIdx: 0, inFlight: false,
            flightT: 0, flightDur: 0, startWX: 0, startWZ: 0, endWX: 0, endWZ: 0, peakH: 0,
            willScore: false, is3: false, shotByIdx: -1, passToIdx: -1, spin: 0 },
    lastToast: '',
    flashT: 0
  };
}

// ── PHYSICS CONSTANTS ────────────────────────────────────
const CW = 28, CD = 16;
const midX = CW / 2, midZ = CD / 2;
const HOOPS = [
  { wx: 1.8, wy: 3.0, wz: midZ, team: 1 },
  { wx: CW - 1.8, wy: 3.0, wz: midZ, team: 0 }
];
const THREE_DIST = 7.5;
const SPEED = 0.07;
const HOOP_CATCH_R = 1.4;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist2(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
function lerp(a, b, t) { return a + (b - a) * t; }

// ── SERVER-SIDE GAME LOOP ─────────────────────────────────
const TICK_MS = 50; // 20 ticks/sec
const DT = TICK_MS / 1000;

function tickGame(room) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;

  g.tick++;
  g.timeLeft -= DT;
  g.flashT = Math.max(0, g.flashT - DT);

  if (g.timeLeft <= 0) {
    g.timeLeft = 0;
    endQuarter(room);
    return;
  }

  updatePlayers(g);
  updateBall(g);
}

function updatePlayers(g) {
  for (const p of g.players) {
    if (p.celebrating > 0) { p.celebrating -= DT; continue; }
    if (p.shotCD > 0) p.shotCD -= DT;
    if (p.stealCD > 0) p.stealCD -= DT;
    if (p.shooting) {
      p.shootT += DT;
      if (p.shootT > 0.65) releaseShot(g, p);
    }
    if (p.jumpH > 0 || p.jumpV > 0) {
      p.jumpH += (p.jumpV || 0) * DT * 60;
      p.jumpV = (p.jumpV || 0) - 0.015;
      if (p.jumpH <= 0) { p.jumpH = 0; p.jumpV = 0; }
    }

    // AI for un-controlled players (no input this tick)
    if (!p._hasInput) {
      const carrier = g.players.find(pl => pl.hasBall);
      if (carrier && !p.hasBall && !g.ball.inFlight) {
        const tx = carrier.wx + (p.team === 0 ? -3.5 : 3.5);
        const tz = carrier.wz + (p.id % 2 === 0 ? -2 : 2);
        const dx = tx - p.wx, dz = tz - p.wz, dd = Math.hypot(dx, dz);
        if (dd > 0.5) {
          p.wx += (dx / dd) * SPEED * 0.55;
          p.wz += (dz / dd) * SPEED * 0.55;
        }
      }
    }
    p._hasInput = false;
    p.wx = clamp(p.wx, 0.5, CW - 0.5);
    p.wz = clamp(p.wz, 0.5, CD - 0.5);
  }
}

function updateBall(g) {
  const b = g.ball;
  b.spin += DT * 6;

  if (b.inFlight) {
    b.flightT += DT;
    const t = clamp(b.flightT / b.flightDur, 0, 1);
    b.wx = lerp(b.startWX, b.endWX, t);
    b.wz = lerp(b.startWZ, b.endWZ, t);
    b.wy = 0.3 + Math.sin(t * Math.PI) * b.peakH;

    // Pass reception
    if (b.passToIdx >= 0 && t >= 0.95) {
      const recv = g.players[b.passToIdx];
      b.inFlight = false; recv.hasBall = true;
      b.ownerIdx = b.passToIdx; b.passToIdx = -1;
      b.wy = 0.3; b.wx = recv.wx; b.wz = recv.wz;
      return;
    }

    // Shot lands
    if (t >= 1.0) {
      if (b.willScore) {
        const shooter = g.players[b.shotByIdx];
        const pts = b.is3 ? 3 : 2;
        g.scores[shooter.team] += pts;
        g.lastToast = pts === 3 ? 'THREE POINTER!' : 'BUCKET! +2';
        g.flashT = 0.5;
        shooter.celebrating = 1.5;
        shooter.jumpV = 0.22;
      } else {
        g.lastToast = 'MISS!';
      }
      b.inFlight = false; b.willScore = false;
      // Give to defense
      const def = g.players.filter(pl => pl.team !== (g.players[b.shotByIdx]?.team ?? -1));
      const recv = def[Math.floor(Math.random() * def.length)] || g.players[0];
      recv.hasBall = true; b.ownerIdx = recv.id;
      b.wx = recv.wx; b.wz = recv.wz; b.wy = 0.3;
      b.shotByIdx = -1;
    }
  } else {
    const owner = b.ownerIdx >= 0 ? g.players[b.ownerIdx] : null;
    if (owner) {
      b.wx = lerp(b.wx, owner.wx, 0.35);
      b.wz = lerp(b.wz, owner.wz, 0.35);
      b.wy = 0.3;
    }
  }
}

function releaseShot(g, p) {
  if (!p.hasBall || !p.shooting) return;
  p.shooting = false;
  const charge = clamp(p.shootT, 0.08, 0.55);
  const hoop = HOOPS.find(h => h.team !== p.team) || HOOPS[0];
  const d = dist2(p.wx, p.wz, hoop.wx, hoop.wz);
  const is3 = d > THREE_DIST;
  const perfect = Math.abs(charge - 0.32) < 0.09;
  const acc = perfect ? 0.90 : is3 ? 0.52 : 0.68;
  const makes = Math.random() < acc;

  p.hasBall = false; p.shotCD = 0.9; p.jumpV = 0.18;
  const b = g.ball;
  b.inFlight = true; b.shotByIdx = p.id; b.passToIdx = -1;
  b.ownerIdx = -1; b.willScore = makes; b.is3 = is3;
  b.startWX = p.wx; b.startWZ = p.wz;
  b.endWX = makes ? hoop.wx : hoop.wx + (Math.random() - 0.5) * 2.5;
  b.endWZ = makes ? hoop.wz : hoop.wz + (Math.random() - 0.5) * 2.5;
  b.flightT = 0; b.flightDur = 0.65 + d * 0.02;
  b.peakH = 3 + d * 0.15;
}

function doPass(g, p) {
  const teammates = g.players.filter(pl => pl.team === p.team && pl.id !== p.id);
  if (!teammates.length) return;
  const target = teammates.reduce((a, b) =>
    dist2(p.wx, p.wz, a.wx, a.wz) < dist2(p.wx, p.wz, b.wx, b.wz) ? a : b);
  p.hasBall = false; p.shotCD = 0.45;
  const b = g.ball;
  b.inFlight = true; b.passToIdx = target.id; b.shotByIdx = -1;
  b.ownerIdx = -1; b.willScore = false;
  b.startWX = p.wx; b.startWZ = p.wz;
  b.endWX = target.wx; b.endWZ = target.wz;
  const d = dist2(p.wx, p.wz, target.wx, target.wz);
  b.flightT = 0; b.flightDur = 0.25 + d * 0.015; b.peakH = 1.2;
}

function doSteal(g, stealer) {
  for (const opp of g.players.filter(pl => pl.team !== stealer.team && pl.hasBall)) {
    if (dist2(stealer.wx, stealer.wz, opp.wx, opp.wz) < 1.8) {
      opp.hasBall = false; stealer.hasBall = true; stealer.stealCD = 0.7;
      g.ball.ownerIdx = stealer.id; g.ball.inFlight = false;
      g.ball.wx = stealer.wx; g.ball.wz = stealer.wz;
      g.lastToast = 'STEAL!';
      return;
    }
  }
  if (g.ball.inFlight && g.ball.passToIdx < 0) {
    const b = g.ball;
    if (dist2(b.wx, b.wz, stealer.wx, stealer.wz) < 1.6 && b.wy < 2.5) {
      b.inFlight = false; stealer.hasBall = true;
      b.ownerIdx = stealer.id; b.wx = stealer.wx; b.wz = stealer.wz; b.wy = 0.3;
      stealer.stealCD = 0.6;
      g.lastToast = 'BLOCKED!';
    }
  }
}

function endQuarter(room) {
  const g = room.game;
  if (g.quarter >= 4) {
    room.state = 'over';
    io.to(room.code).emit('gameOver', { scores: g.scores });
    clearInterval(room._interval);
    return;
  }
  g.quarter++;
  g.timeLeft = 120;
  g.lastToast = 'Q' + g.quarter + ' START!';
  // Reset positions
  g.players.forEach(p => { p.hasBall = false; p.celebrating = 0; p.jumpH = 0; p.jumpV = 0; p.shooting = false; });
  g.players[0].wx = midX-4; g.players[0].wz = midZ-1.5; g.players[0].hasBall = true;
  g.players[1].wx = midX-4; g.players[1].wz = midZ+1.5;
  g.players[2].wx = midX+4; g.players[2].wz = midZ-1.5;
  g.players[3].wx = midX+4; g.players[3].wz = midZ+1.5;
  const b = g.ball;
  b.ownerIdx = 0; b.inFlight = false; b.wx = g.players[0].wx; b.wz = g.players[0].wz; b.wy = 0.3;
}

// ── SOCKET EVENTS ─────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('createRoom', ({ name }) => {
    const code = makeCode();
    const room = makeRoom(code);
    rooms.set(code, room);
    const slot = { socketId: socket.id, team: 0, playerIdx: 0, name: name || 'P1' };
    room.players.push(slot);
    socket.join(code);
    socket.roomCode = code;
    socket.playerIdx = 0;
    socket.emit('roomCreated', { code, team: 0, playerIdx: 0 });
    console.log('Room created:', code);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'waiting') { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 4) { socket.emit('error', 'Room is full'); return; }

    // Assign team & player slot
    const taken = room.players.map(p => p.playerIdx);
    let playerIdx = [0,1,2,3].find(i => !taken.includes(i));
    const team = playerIdx < 2 ? 0 : 1;
    const slot = { socketId: socket.id, team, playerIdx, name: name || ('P'+(playerIdx+1)) };
    room.players.push(slot);
    socket.join(code.toUpperCase());
    socket.roomCode = code.toUpperCase();
    socket.playerIdx = playerIdx;
    socket.emit('joinedRoom', { code: code.toUpperCase(), team, playerIdx });
    io.to(code.toUpperCase()).emit('playerList', room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx})));
    console.log('Joined room:', code, 'as player', playerIdx);

    // Auto-start when 2+ players
    if (room.players.length >= 2 && room.state === 'waiting') {
      startRoom(room);
    }
  });

  socket.on('input', (input) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.state !== 'playing') return;
    const g = room.game;
    const pIdx = socket.playerIdx;
    if (pIdx === undefined || pIdx < 0 || pIdx > 3) return;
    const p = g.players[pIdx];
    if (!p) return;

    // Apply movement
    let mx = 0, mz = 0;
    if (input.u) { mx += 0.7; mz -= 0.7; }
    if (input.d) { mx -= 0.7; mz += 0.7; }
    if (input.l) { mx -= 0.7; mz -= 0.7; }
    if (input.r) { mx += 0.7; mz += 0.7; }
    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz) || 1;
      p.wx += mx / len * SPEED;
      p.wz += mz / len * SPEED;
      p.facing = mx > 0 ? 1 : -1;
      p._hasInput = true;
      p.wx = clamp(p.wx, 0.5, CW-0.5);
      p.wz = clamp(p.wz, 0.5, CD-0.5);
    }

    // Shoot
    if (input.shootStart && p.hasBall && !p.shooting && p.shotCD <= 0) {
      p.shooting = true; p.shootT = 0;
    }
    if (input.shootEnd && p.shooting && p.hasBall) {
      releaseShot(g, p);
    }
    // Pass
    if (input.pass && p.hasBall && p.shotCD <= 0) {
      doPass(g, p);
    }
    // Steal
    if (input.steal && !p.hasBall && p.stealCD <= 0) {
      doSteal(g, p);
    }
  });

  socket.on('ping_', () => socket.emit('pong_'));

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.socketId !== socket.id);
    if (room.players.length === 0) {
      clearInterval(room._interval);
      rooms.delete(code);
      console.log('Room destroyed:', code);
    } else {
      io.to(code).emit('playerLeft', { playerIdx: socket.playerIdx });
    }
  });
});

function startRoom(room) {
  room.state = 'playing';
  room.game = makeGameState();
  io.to(room.code).emit('gameStart', {
    playerList: room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx}))
  });

  room._interval = setInterval(() => {
    tickGame(room);
    // Broadcast state
    const g = room.game;
    const toast = g.lastToast; g.lastToast = '';
    io.to(room.code).emit('state', {
      players: g.players.map(p => ({
        id:p.id, wx:+p.wx.toFixed(3), wz:+p.wz.toFixed(3), wy:+p.wy.toFixed(3),
        jumpH:+p.jumpH.toFixed(3), hasBall:p.hasBall, facing:p.facing,
        shooting:p.shooting, shootT:+p.shootT.toFixed(3), celebrating:+p.celebrating.toFixed(2)
      })),
      ball: {
        wx:+g.ball.wx.toFixed(3), wz:+g.ball.wz.toFixed(3), wy:+g.ball.wy.toFixed(3),
        spin:+g.ball.spin.toFixed(3), inFlight:g.ball.inFlight, ownerIdx:g.ball.ownerIdx
      },
      scores: g.scores,
      timeLeft: +g.timeLeft.toFixed(2),
      quarter: g.quarter,
      flashT: +g.flashT.toFixed(2),
      toast
    });
  }, TICK_MS);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏀 Hardwood server running on port ${PORT}`));
