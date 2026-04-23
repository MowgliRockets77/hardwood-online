const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 8000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── CONSTANTS ─────────────────────────────────────────────
const CW = 28, CD = 16, MX = CW / 2, MZ = CD / 2;
const HOOPS = [{ wx: 1.8, wy: 3, wz: MZ, team: 1 }, { wx: CW - 1.8, wy: 3, wz: MZ, team: 0 }];
const THREE_DIST = 7.5;
const TICK_MS = 50, DT = TICK_MS / 1000;
const BASE_SPEED = 0.08, SPRINT_SPEED = 0.14;
const FRICTION = 0.78;
const ITEM_KEYS = ['rocket','freeze','bomb','mega','speed','shield','gun','tornado','star'];
const BOX_POS = [[MX,MZ-5],[MX,MZ+5],[5,MZ],[CW-5,MZ],[MX-5,MZ-3],[MX+5,MZ+3],[8,3],[CW-8,CD-3]];
const ITEM_ICONS  = {rocket:'🚀',freeze:'❄️',bomb:'💥',mega:'💪',speed:'⚡',shield:'🛡️',gun:'🔫',tornado:'🌀',star:'⭐'};
const ITEM_NAMES  = {rocket:'ROCKET!',freeze:'FREEZE RAY!',bomb:'BOMB!',mega:'MEGA SIZE!',speed:'SPEED BOOST!',shield:'SHIELD!',gun:'GUN!',tornado:'TORNADO!',star:'STAR POWER!'};
const ITEM_COLORS = {rocket:'#ff6600',freeze:'#44aaff',bomb:'#ff4444',mega:'#ff00cc',speed:'#ffff00',shield:'#00ffaa',gun:'#ff8800',tornado:'#cc44ff',star:'#ffcc00'};

const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const dist2 = (ax,az,bx,bz) => Math.hypot(ax-bx, az-bz);
const lerp  = (a,b,t) => a + (b-a)*t;
const randItem = () => ITEM_KEYS[Math.floor(Math.random()*ITEM_KEYS.length)];

// ── ROOMS ─────────────────────────────────────────────────
const rooms = new Map();

function makeCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random()*c.length)];
  return rooms.has(s) ? makeCode() : s;
}

// ── FACTORIES ─────────────────────────────────────────────
function makePlayer(id, team) {
  return {
    id, team,
    wx: id < 2 ? MX-4 : MX+4,
    wz: id % 2 === 0 ? MZ-1.5 : MZ+1.5,
    wy: 0,
    // velocity for momentum-based movement
    vx: 0, vz: 0,
    jumpH: 0, jumpV: 0,
    bobT: 0,
    hasBall: id === 0,
    facing: team === 0 ? 1 : -1,
    shotCD: 0, stealCD: 0, blockCD: 0,
    shooting: false, shootT: 0,
    // BLOCK system
    blocking: false, blockT: 0, blockPower: 0,
    blockSuccess: false, blockCooldownAnim: 0,
    celebrating: 0,
    item: null,
    frozen: 0, stunned: 0,
    mega: 0, speed: 0,
    shield: false, shieldT: 0,
    star: 0, gunAmmo: 0, gunCD: 0,
    _hasInput: false,
  };
}

function makeBall() {
  return {
    wx: MX-4, wz: MZ-1.5, wy: 0.3,
    // physics velocity
    bvx: 0, bvz: 0, bvy: 0,
    spin: 0, spinX: 0,
    inFlight: false, isPass: false,
    ownerIdx: 0,
    flightT: 0, flightDur: 0,
    sWX: 0, sWZ: 0, eWX: 0, eWZ: 0, peakH: 0,
    willScore: false, is3: false,
    shotByIdx: -1, passToIdx: -1,
    meterQuality: 'normal',
    // bouncing loose ball
    loose: false,
    bounces: 0,
  };
}

function makeGame() {
  return {
    scores: [0,0], quarter: 1, timeLeft: 120, tick: 0,
    players: [0,1,2,3].map(i => makePlayer(i, i<2?0:1)),
    ball: makeBall(),
    itemBoxes: BOX_POS.map(([wx,wz],i) => ({ id:i, wx, wz, alive:true, respawn:0, item:randItem() })),
    projectiles: [], tornado: null,
    toast: '', toastColor: '#ff7700',
    flashT: 0, _pid: 0,
  };
}

// ── GAME TICK ─────────────────────────────────────────────
function tickGame(room) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  g.tick++;
  g.timeLeft -= DT;
  g.toast = '';
  if (g.timeLeft <= 0) { g.timeLeft = 0; endQuarter(room); return; }
  tickTimers(g);
  tickPlayers(g);
  tickBall(g);
  tickBlocking(g);
  tickProjectiles(g);
  tickItemBoxes(g);
  tickTornado(g);
  tickPlayerCollisions(g);
}

function tickTimers(g) {
  if (g.flashT > 0) g.flashT -= DT;
  for (const p of g.players) {
    if (p.frozen > 0) p.frozen -= DT;
    if (p.stunned > 0) p.stunned -= DT;
    if (p.mega > 0) p.mega -= DT;
    if (p.speed > 0) p.speed -= DT;
    if (p.shieldT > 0) { p.shieldT -= DT; if (p.shieldT <= 0) p.shield = false; }
    if (p.shotCD > 0) p.shotCD -= DT;
    if (p.stealCD > 0) p.stealCD -= DT;
    if (p.blockCD > 0) p.blockCD -= DT;
    if (p.blockCooldownAnim > 0) p.blockCooldownAnim -= DT;
    if (p.gunCD > 0) p.gunCD -= DT;
    if (p.celebrating > 0) p.celebrating -= DT;
    // Jump physics
    if (p.jumpH > 0 || p.jumpV > 0) {
      p.jumpH += p.jumpV * DT * 55;
      p.jumpV -= 0.018;
      if (p.jumpH <= 0) { p.jumpH = 0; p.jumpV = 0; }
    }
    p.bobT += DT * 4;
  }
}

function tickPlayers(g) {
  for (const p of g.players) {
    if (p.frozen > 0 || p.stunned > 0) {
      // Apply friction when frozen/stunned
      p.vx *= 0.7; p.vz *= 0.7;
      p.wx += p.vx; p.wz += p.vz;
      p.wx = clamp(p.wx, 0.5, CW-0.5);
      p.wz = clamp(p.wz, 0.5, CD-0.5);
      p._hasInput = false;
      continue;
    }

    // Auto-shoot when overcharged
    if (p.shooting) {
      p.shootT += DT;
      if (p.shootT > 0.75) releaseShot(g, p);
    }

    // Block charging
    if (p.blocking) {
      p.blockT += DT;
      if (p.blockT > 0.5) finishBlock(g, p); // max block hold
    }

    // AI for uncontrolled players
    if (!p._hasInput) {
      const carrier = g.players.find(pl => pl.hasBall);
      if (carrier && !p.hasBall && !g.ball.inFlight && !g.ball.loose) {
        const tx = carrier.wx + (p.team===0 ? -4 : 4);
        const tz = carrier.wz + (p.id%2===0 ? -2.5 : 2.5);
        const dx = tx-p.wx, dz = tz-p.wz, dd = Math.hypot(dx,dz);
        if (dd > 0.5) {
          const spd = getSpeed(p) * 0.5;
          p.vx = lerp(p.vx, (dx/dd)*spd, 0.2);
          p.vz = lerp(p.vz, (dz/dd)*spd, 0.2);
        }
      }
    }
    p._hasInput = false;

    // Apply momentum + friction
    p.vx *= FRICTION; p.vz *= FRICTION;
    p.wx += p.vx; p.wz += p.vz;
    p.wx = clamp(p.wx, 0.5, CW-0.5);
    p.wz = clamp(p.wz, 0.5, CD-0.5);
  }
}

function getSpeed(p) {
  let spd = p.speed > 0 ? SPRINT_SPEED : BASE_SPEED;
  if (p.mega > 0) spd *= 0.65;
  return spd;
}

// ── BLOCKING ──────────────────────────────────────────────
function startBlock(g, p) {
  if (p.blockCD > 0 || p.blocking || p.hasBall) return;
  p.blocking = true;
  p.blockT = 0;
  p.blockPower = 0;
  p.jumpV = 0.22; // jump up for block
}

function finishBlock(g, p) {
  if (!p.blocking) return;
  p.blocking = false;
  const charge = clamp(p.blockT, 0.05, 0.5);
  const norm = charge / 0.5;
  // Perfect block window: 0.55-0.85 normalized
  const perfect = norm >= 0.55 && norm <= 0.85;
  p.blockPower = perfect ? 1.0 : norm > 0.85 ? 0.4 : norm * 0.6;
  p.blockCD = perfect ? 0.8 : 1.4; // shorter CD for perfect
  p.blockCooldownAnim = 0.5;
  p.blockSuccess = false;

  // Check if ball is in range and in flight (shot, not pass)
  const b = g.ball;
  if (b.inFlight && !b.isPass && b.shotByIdx >= 0) {
    const shooter = g.players[b.shotByIdx];
    if (shooter && shooter.team !== p.team) {
      const reach = p.mega > 0 ? 5 : (perfect ? 3.5 : 2.5);
      const ballDist = dist2(b.wx, b.wz, p.wx, p.wz);
      // Can only block if ball is reachable height-wise
      const heightOK = b.wy < 4.5 && p.jumpH > 0.3;
      if (ballDist < reach && heightOK) {
        // BLOCK SUCCESS
        p.blockSuccess = true;
        b.inFlight = false;
        b.willScore = false;
        b.loose = true;
        // Knock ball away from basket
        const dx = b.wx - p.wx || 0.1;
        const dz = b.wz - p.wz || 0.1;
        const d = Math.hypot(dx, dz) || 1;
        b.bvx = (dx/d) * 0.18 * (1 + p.blockPower);
        b.bvz = (dz/d) * 0.18 * (1 + p.blockPower);
        b.bvy = 0.25 * p.blockPower;
        b.wy = Math.max(b.wy, 1.5);
        b.ownerIdx = -1;
        b.shotByIdx = -1;
        g.toast = perfect ? 'PERFECT BLOCK! 🖐️' : 'BLOCKED! ✋';
        g.toastColor = perfect ? '#00ffaa' : '#ffffff';
        g.flashT = 0.35;
        return;
      }
    }
  }

  // Attempt block steal on ball carrier
  if (!b.inFlight) {
    for (const opp of g.players.filter(pl => pl.team !== p.team && pl.hasBall)) {
      const reach = p.mega > 0 ? 4.5 : (perfect ? 2.5 : 1.8);
      if (dist2(p.wx, p.wz, opp.wx, opp.wz) < reach) {
        if (opp.shield) { opp.shield = false; opp.shieldT = 0; g.toast='SHIELD BLOCK!'; g.toastColor='#00ffaa'; return; }
        if (Math.random() < (perfect ? 0.85 : 0.45)) {
          opp.hasBall = false;
          p.hasBall = true;
          b.ownerIdx = p.id;
          p.blockSuccess = true;
          g.toast = perfect ? 'STRIP! 💥' : 'KNOCKED LOOSE!';
          g.toastColor = '#ff7700';
        } else {
          g.toast = 'BLOCKED OUT!';
          g.toastColor = '#888888';
        }
        return;
      }
    }
  }
}

function tickBlocking(g) {
  // Check loose ball pickup
  const b = g.ball;
  if (b.loose) {
    for (const p of g.players) {
      if (p.hasBall || p.frozen > 0 || p.stunned > 0) continue;
      if (dist2(b.wx, b.wz, p.wx, p.wz) < (p.mega > 0 ? 3 : 1.4)) {
        b.loose = false;
        b.inFlight = false;
        p.hasBall = true;
        b.ownerIdx = p.id;
        b.bvx = 0; b.bvz = 0; b.bvy = 0;
        break;
      }
    }
  }
}

// ── BALL PHYSICS ──────────────────────────────────────────
function tickBall(g) {
  const b = g.ball;
  b.spin += DT * 5;
  b.spinX += DT * 4;

  if (b.loose) {
    // Physics-based loose ball
    b.wx += b.bvx; b.wz += b.bvz;
    b.wy += b.bvy;
    b.bvy -= 0.014; // gravity
    b.bvx *= 0.96; b.bvz *= 0.96; // air resistance

    // Floor bounce
    if (b.wy <= 0.15) {
      b.wy = 0.15;
      b.bvy *= -0.45;
      b.bvx *= 0.8; b.bvz *= 0.8;
      if (Math.abs(b.bvy) < 0.02) {
        b.bvy = 0;
        // Settle — give to nearest player if very slow
        if (Math.abs(b.bvx) < 0.02 && Math.abs(b.bvz) < 0.02) {
          const nearest = g.players.filter(p => p.frozen<=0 && p.stunned<=0)
            .reduce((a, c) => dist2(b.wx,b.wz,a.wx,a.wz) < dist2(b.wx,b.wz,c.wx,c.wz) ? a : c, g.players[0]);
          if (dist2(b.wx, b.wz, nearest.wx, nearest.wz) < 3.5) {
            b.loose = false;
            nearest.hasBall = true;
            b.ownerIdx = nearest.id;
            b.bvx = 0; b.bvz = 0;
          }
        }
      }
    }

    // Wall bounce
    if (b.wx < 0.3) { b.wx = 0.3; b.bvx = Math.abs(b.bvx) * 0.6; }
    if (b.wx > CW-0.3) { b.wx = CW-0.3; b.bvx = -Math.abs(b.bvx) * 0.6; }
    if (b.wz < 0.3) { b.wz = 0.3; b.bvz = Math.abs(b.bvz) * 0.6; }
    if (b.wz > CD-0.3) { b.wz = CD-0.3; b.bvz = -Math.abs(b.bvz) * 0.6; }
    return;
  }

  if (b.inFlight) {
    b.flightT += DT;
    const t = clamp(b.flightT / b.flightDur, 0, 1);
    b.wx = lerp(b.sWX, b.eWX, t);
    b.wz = lerp(b.sWZ, b.eWZ, t);
    // Parabolic arc with slight wobble for misses
    const arc = Math.sin(t * Math.PI);
    b.wy = 0.3 + arc * b.peakH;
    if (!b.isPass && !b.willScore && t > 0.5) {
      b.wy += Math.sin(t * Math.PI * 3) * 0.15 * (1-t); // miss wobble
    }

    // Pass reception
    if (b.isPass && b.passToIdx >= 0 && t >= 0.92) {
      const recv = g.players[b.passToIdx];
      b.inFlight = false; b.isPass = false;
      recv.hasBall = true; b.ownerIdx = recv.id;
      b.passToIdx = -1; b.wy = 0.3;
      return;
    }

    // Shot lands
    if (t >= 1.0) {
      if (b.willScore) {
        const shooter = g.players[b.shotByIdx];
        const pts = b.is3 ? 3 : 2;
        g.scores[shooter.team] += pts;
        g.toast = pts === 3 ? 'THREE POINTER! 🔥' : 'BUCKET! +2 🏀';
        g.toastColor = pts === 3 ? '#ffcc00' : '#00ff88';
        g.flashT = 0.5;
        shooter.celebrating = 1.5; shooter.jumpV = 0.25;
        // Ball goes loose after score (comes through net)
        b.inFlight = false; b.willScore = false; b.loose = true;
        b.wy = HOOPS.find(h=>h.team!==shooter.team)?.wy - 0.5 || 2.5;
        b.bvx = (Math.random()-0.5)*0.08;
        b.bvz = (Math.random()-0.5)*0.08;
        b.bvy = -0.05;
        b.ownerIdx = -1;
        b.shotByIdx = -1;
        // Give to defense after brief delay (handled by loose ball pickup)
        const def = g.players.filter(pl => pl.team !== shooter.team);
        const recv = def[Math.floor(Math.random()*def.length)] || g.players[0];
        // Place recv near their hoop to grab it
        setTimeout_safe(g, () => {
          if (!b.loose) return;
          b.loose = false;
          recv.hasBall = true;
          b.ownerIdx = recv.id;
          b.wx = recv.wx; b.wz = recv.wz;
        }, 800);
      } else {
        // Miss — ball bounces off rim area
        g.toast = 'MISS! 🙈'; g.toastColor = '#888888';
        b.inFlight = false; b.willScore = false; b.loose = true;
        b.bvy = 0.12;
        b.bvx = (Math.random()-0.5)*0.2;
        b.bvz = (Math.random()-0.5)*0.2;
        b.wy = Math.max(b.wy, 1.8);
        b.ownerIdx = -1; b.shotByIdx = -1;
      }
    }
  } else if (!b.loose) {
    // Owned by player — follow with slight dribble
    const owner = b.ownerIdx >= 0 ? g.players[b.ownerIdx] : null;
    if (owner) {
      b.wx = lerp(b.wx, owner.wx, 0.4);
      b.wz = lerp(b.wz, owner.wz, 0.4);
      const dribbleHeight = Math.max(0, Math.abs(Math.sin(owner.bobT * 1.5)) * 0.4);
      b.wy = lerp(b.wy, 0.12 + dribbleHeight, 0.35);
    }
  }
}

// Safe delayed callback that checks game still running
const _timeouts = new Set();
function setTimeout_safe(g, fn, ms) {
  const id = setTimeout(() => { _timeouts.delete(id); fn(); }, ms);
  _timeouts.add(id);
}

function releaseShot(g, p) {
  if (!p.hasBall || !p.shooting) return;
  const charge = clamp(p.shootT, 0.05, 0.75);
  p.shooting = false;
  const hoop = HOOPS.find(h => h.team !== p.team) || HOOPS[0];
  const d = dist2(p.wx, p.wz, hoop.wx, hoop.wz);
  const is3 = d > THREE_DIST;
  const norm = charge / 0.75;
  const inGreen = norm >= 0.72 && norm <= 0.92;
  const perfect  = norm >= 0.78 && norm <= 0.88;
  const hasStar  = p.star > 0;
  const acc = (hasStar || perfect) ? 0.97 : inGreen ? 0.85 : is3 ? 0.42 : 0.60;
  const makes = Math.random() < acc;
  if (hasStar && p.star > 0) p.star--;
  p.hasBall = false; p.shotCD = 0.9; p.jumpV = 0.2;
  const b = g.ball;
  b.inFlight = true; b.isPass = false;
  b.shotByIdx = p.id; b.passToIdx = -1; b.ownerIdx = -1;
  b.willScore = makes; b.is3 = is3;
  b.meterQuality = perfect ? 'perfect' : inGreen ? 'good' : 'bad';
  b.sWX = p.wx; b.sWZ = p.wz;
  b.eWX = makes ? hoop.wx : hoop.wx + (Math.random()-0.5)*2.8;
  b.eWZ = makes ? hoop.wz : hoop.wz + (Math.random()-0.5)*2.8;
  b.flightT = 0; b.flightDur = 0.55 + d*0.022; b.peakH = 2.8 + d*0.16;
  b.loose = false;
  g.toast = perfect ? 'PERFECT! 🎯' : inGreen ? 'GOOD RELEASE! ✅' : 'EARLY / LATE ❌';
  g.toastColor = inGreen ? '#00ff88' : '#ff8800';
}

function doPass(g, p) {
  const tm = g.players.filter(pl => pl.team === p.team && pl.id !== p.id);
  if (!tm.length) return;
  const target = tm.reduce((a,b) => dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  p.hasBall = false; p.shotCD = 0.35;
  const b = g.ball;
  b.inFlight = true; b.isPass = true;
  b.passToIdx = target.id; b.shotByIdx = -1; b.ownerIdx = -1;
  b.willScore = false; b.loose = false;
  b.sWX = p.wx; b.sWZ = p.wz; b.eWX = target.wx; b.eWZ = target.wz;
  const d = dist2(p.wx,p.wz,target.wx,target.wz);
  b.flightT = 0; b.flightDur = 0.18 + d*0.012; b.peakH = 0.8;
}

function doSteal(g, p) {
  const b = g.ball;
  for (const opp of g.players.filter(pl => pl.team !== p.team && pl.hasBall)) {
    const reach = p.mega > 0 ? 4.5 : 1.9;
    if (dist2(p.wx,p.wz,opp.wx,opp.wz) < reach) {
      if (opp.shield) { opp.shield=false; opp.shieldT=0; g.toast='SHIELD BLOCK!'; g.toastColor='#00ffaa'; return; }
      opp.hasBall = false; p.hasBall = true; p.stealCD = 0.8;
      b.ownerIdx = p.id; b.inFlight = false; b.loose = false;
      b.wx = p.wx; b.wz = p.wz;
      g.toast = 'STEAL! 💨'; g.toastColor = '#ff7700';
      return;
    }
  }
  // Intercept a pass
  if (b.inFlight && b.isPass && b.passToIdx >= 0) {
    if (dist2(b.wx,b.wz,p.wx,p.wz) < 2.0 && b.wy < 2) {
      const recv = g.players[b.passToIdx];
      if (recv && recv.team !== p.team) {
        b.inFlight = false; b.isPass = false;
        p.hasBall = true; b.ownerIdx = p.id;
        b.wx = p.wx; b.wz = p.wz; b.wy = 0.3;
        p.stealCD = 0.5;
        g.toast = 'INTERCEPT! 🙌'; g.toastColor = '#ff7700';
      }
    }
  }
}

// Player-player collision (push apart)
function tickPlayerCollisions(g) {
  for (let i = 0; i < g.players.length; i++) {
    for (let j = i+1; j < g.players.length; j++) {
      const a = g.players[i], b = g.players[j];
      const minDist = (a.mega>0||b.mega>0) ? 2.8 : 1.4;
      const dx = a.wx-b.wx, dz = a.wz-b.wz;
      const d = Math.hypot(dx,dz);
      if (d < minDist && d > 0.01) {
        const push = (minDist-d)/2;
        const nx = dx/d, nz = dz/d;
        a.wx += nx*push; a.wz += nz*push;
        b.wx -= nx*push; b.wz -= nz*push;
        // Transfer some momentum
        const relVx = a.vx-b.vx, relVz = a.vz-b.vz;
        const dot = relVx*nx + relVz*nz;
        if (dot < 0) {
          a.vx -= dot*nx*0.4; a.vz -= dot*nz*0.4;
          b.vx += dot*nx*0.4; b.vz += dot*nz*0.4;
        }
      }
    }
  }
}

// ── ITEMS ─────────────────────────────────────────────────
function useItem(g, p) {
  if (!p.item) return;
  const item = p.item; p.item = null;
  switch(item) {
    case 'rocket':  fireRocket(g,p); break;
    case 'freeze':  doFreeze(g,p); break;
    case 'bomb':    doBomb(g,p); break;
    case 'mega':    p.mega=5;  g.toast='💪 MEGA SIZE!';        g.toastColor='#ff00cc'; break;
    case 'speed':   p.speed=4; g.toast='⚡ SPEED BOOST!';      g.toastColor='#ffff00'; break;
    case 'shield':  p.shield=true; p.shieldT=6; g.toast='🛡️ SHIELDED!'; g.toastColor='#00ffaa'; break;
    case 'gun':     p.gunAmmo=6; p.gunCD=0; g.toast='🔫 LOCKED & LOADED!'; g.toastColor='#ff8800'; break;
    case 'tornado': g.tornado={t:4,wx:MX,wz:MZ,ownerIdx:p.id}; g.toast='🌀 TORNADO!'; g.toastColor='#cc44ff'; break;
    case 'star':    p.star=3; g.toast='⭐ STAR POWER! (3 shots)'; g.toastColor='#ffcc00'; break;
  }
}

function fireRocket(g,p) {
  const enemies = g.players.filter(pl=>pl.team!==p.team);
  if (!enemies.length) return;
  const target = enemies.reduce((a,b)=>dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  const dx=target.wx-p.wx, dz=target.wz-p.wz, d=Math.max(0.1,Math.hypot(dx,dz));
  g.projectiles.push({id:g._pid++,wx:p.wx,wy:0.8,wz:p.wz,vx:dx/d*0.25,vz:dz/d*0.25,type:'rocket',ownerIdx:p.id,targetIdx:target.id,t:0});
  g.toast='🚀 ROCKET AWAY!'; g.toastColor='#ff6600';
}
function fireGun(g,p) {
  if(p.gunAmmo<=0||p.gunCD>0) return;
  p.gunAmmo--; p.gunCD=0.18;
  const enemies=g.players.filter(pl=>pl.team!==p.team);
  if(!enemies.length) return;
  const target=enemies.reduce((a,b)=>dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  const dx=target.wx-p.wx,dz=target.wz-p.wz,d=Math.max(0.1,Math.hypot(dx,dz));
  g.projectiles.push({id:g._pid++,wx:p.wx,wy:0.8,wz:p.wz,vx:dx/d*0.38,vz:dz/d*0.38,type:'bullet',ownerIdx:p.id,t:0});
}
function doFreeze(g,p) {
  for(const e of g.players.filter(pl=>pl.team!==p.team)) {
    if(e.shield){e.shield=false;e.shieldT=0;continue;}
    e.frozen=3;
  }
  g.toast='❄️ EVERYONE FROZEN!'; g.toastColor='#44aaff'; g.flashT=0.4;
}
function doBomb(g,p) {
  g.toast='💥 BOOM!'; g.toastColor='#ff4444'; g.flashT=0.6;
  for(const o of g.players) {
    if(o===p) continue;
    if(dist2(p.wx,p.wz,o.wx,o.wz)<3.8) {
      if(o.shield){o.shield=false;o.shieldT=0;continue;}
      o.stunned=1.5;
      if(o.hasBall) {
        o.hasBall=false;
        const b=g.ball; b.loose=true; b.ownerIdx=-1;
        b.bvy=0.18; b.bvx=(Math.random()-0.5)*0.22; b.bvz=(Math.random()-0.5)*0.22;
      }
      const dx=o.wx-p.wx||0.1, dz=o.wz-p.wz||0.1, d=Math.hypot(dx,dz)||1;
      o.vx=(dx/d)*0.35; o.vz=(dz/d)*0.35; // momentum knockback
    }
  }
}
function tickProjectiles(g) {
  g.projectiles=g.projectiles.filter(pr=>{
    pr.t+=DT; pr.wx+=pr.vx; pr.wz+=pr.vz;
    if(pr.wx<0||pr.wx>CW||pr.wz<0||pr.wz>CD||pr.t>4) return false;
    if(pr.type==='rocket'&&pr.targetIdx>=0) {
      const tgt=g.players[pr.targetIdx];
      if(tgt){const dx=tgt.wx-pr.wx,dz=tgt.wz-pr.wz,d=Math.max(0.1,Math.hypot(dx,dz));pr.vx=lerp(pr.vx,dx/d*0.25,0.09);pr.vz=lerp(pr.vz,dz/d*0.25,0.09);}
    }
    for(const p of g.players) {
      if(p.id===pr.ownerIdx) continue;
      if(dist2(pr.wx,pr.wz,p.wx,p.wz)<(pr.type==='rocket'?2:1.5)) {
        if(p.shield){p.shield=false;p.shieldT=0;return false;}
        if(pr.type==='rocket'){
          p.stunned=2; g.flashT=0.4; g.toast='🚀 DIRECT HIT!'; g.toastColor='#ff6600';
          if(p.hasBall){
            p.hasBall=false;
            const b=g.ball; b.loose=true; b.ownerIdx=-1;
            b.bvy=0.2; b.bvx=(Math.random()-0.5)*0.25; b.bvz=(Math.random()-0.5)*0.25;
          }
          // Knockback
          const dx=p.wx-pr.wx||0.1,dz=p.wz-pr.wz||0.1,d=Math.hypot(dx,dz)||1;
          p.vx=(dx/d)*0.3; p.vz=(dz/d)*0.3;
        } else {
          p.stunned=0.8;
        }
        return false;
      }
    }
    return true;
  });
}
function tickItemBoxes(g) {
  for(const box of g.itemBoxes) {
    if(!box.alive){box.respawn-=DT;if(box.respawn<=0){box.alive=true;box.item=randItem();}continue;}
    for(const p of g.players) {
      if(p.item) continue;
      if(dist2(p.wx,p.wz,box.wx,box.wz)<1.7) {
        p.item=box.item; box.alive=false; box.respawn=12;
        g.toast=`${ITEM_ICONS[box.item]} ${ITEM_NAMES[box.item]}`; g.toastColor=ITEM_COLORS[box.item];
      }
    }
  }
}
function tickTornado(g) {
  if(!g.tornado) return;
  g.tornado.t-=DT; if(g.tornado.t<=0){g.tornado=null;return;}
  const ang=g.tornado.t*2; g.tornado.wx=MX+Math.cos(ang)*6; g.tornado.wz=MZ+Math.sin(ang)*3.5;
  for(const p of g.players) {
    if(p.id===g.tornado.ownerIdx) continue;
    if(dist2(p.wx,p.wz,g.tornado.wx,g.tornado.wz)<3.5) {
      const dx=p.wx-g.tornado.wx||0.1,dz=p.wz-g.tornado.wz||0.1,d=Math.hypot(dx,dz)||1;
      p.vx+=(dx/d)*0.06; p.vz+=(dz/d)*0.06;
    }
  }
}
function endQuarter(room) {
  const g=room.game;
  if(g.quarter>=4){room.state='over';io.to(room.code).emit('gameOver',{scores:g.scores});clearInterval(room._interval);return;}
  g.quarter++;g.timeLeft=120;
  g.toast='Q'+g.quarter+' START! 🏀'; g.toastColor='#ff7700';
  g.players.forEach(p=>{
    p.hasBall=false;p.celebrating=0;p.jumpH=0;p.jumpV=0;p.shooting=false;p.blocking=false;
    p.frozen=0;p.stunned=0;p.mega=0;p.speed=0;p.shield=false;p.star=0;p.gunAmmo=0;p.item=null;
    p.vx=0;p.vz=0;
  });
  [[MX-4,MZ-1.5],[MX-4,MZ+1.5],[MX+4,MZ-1.5],[MX+4,MZ+1.5]].forEach(([wx,wz],i)=>{g.players[i].wx=wx;g.players[i].wz=wz;});
  g.players[0].hasBall=true;
  g.ball=makeBall(); g.projectiles=[]; g.tornado=null;
}

// ── SOCKET IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connect:', socket.id);
  socket.on('ping_', ()=>socket.emit('pong_'));

  socket.on('createRoom', ({name})=>{
    const code=makeCode();
    const room={code,players:[],state:'waiting',game:null,_interval:null};
    rooms.set(code,room);
    const pname=(name||'P1').slice(0,10).toUpperCase();
    room.players.push({socketId:socket.id,playerIdx:0,team:0,name:pname});
    socket.join(code); socket.roomCode=code; socket.playerIdx=0;
    socket.emit('roomCreated',{code,team:0,playerIdx:0});
    console.log(`Room ${code} created by ${pname}`);
  });

  socket.on('joinRoom', ({code,name})=>{
    const rc=(code||'').toUpperCase().trim();
    const room=rooms.get(rc);
    if(!room){socket.emit('joinError','Room not found — check the code!');return;}
    if(room.state!=='waiting'){socket.emit('joinError','Game already started');return;}
    if(room.players.length>=4){socket.emit('joinError','Room is full (max 4)');return;}
    const taken=room.players.map(p=>p.playerIdx);
    const playerIdx=[0,1,2,3].find(i=>!taken.includes(i));
    const team=playerIdx<2?0:1;
    const pname=(name||('P'+(playerIdx+1))).slice(0,10).toUpperCase();
    room.players.push({socketId:socket.id,playerIdx,team,name:pname});
    socket.join(rc); socket.roomCode=rc; socket.playerIdx=playerIdx;
    socket.emit('joinedRoom',{code:rc,team,playerIdx});
    io.to(rc).emit('playerList',room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx})));
    console.log(`${pname} joined room ${rc} as P${playerIdx+1}`);
    if(room.players.length>=2&&room.state==='waiting') startRoom(room);
  });

  socket.on('input', input=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.state!=='playing') return;
    const g=room.game, p=g.players[socket.playerIdx];
    if(!p||p.frozen>0||p.stunned>0) return;
    const spd=getSpeed(p);
    let mx=0, mz=0;
    if(input.u){mx+=0.7;mz-=0.7;} if(input.d){mx-=0.7;mz+=0.7;}
    if(input.l){mx-=0.7;mz-=0.7;} if(input.r){mx+=0.7;mz+=0.7;}
    if(mx!==0||mz!==0){
      const len=Math.hypot(mx,mz)||1;
      const accel=spd*(p.blocking?0.3:1);
      p.vx=lerp(p.vx,(mx/len)*spd,0.3*accel);
      p.vz=lerp(p.vz,(mz/len)*spd,0.3*accel);
      p.facing=mx>0?1:-1;
      p._hasInput=true;
    }
    if(input.shootStart && p.hasBall && !p.shooting && p.shotCD<=0){p.shooting=true;p.shootT=0;}
    if(input.shootEnd && p.shooting && p.hasBall) releaseShot(g,p);
    if(input.pass && p.hasBall && p.shotCD<=0) doPass(g,p);
    if(input.steal && !p.hasBall && p.stealCD<=0) doSteal(g,p);
    if(input.blockStart && !p.hasBall && !p.blocking && p.blockCD<=0) startBlock(g,p);
    if(input.blockEnd && p.blocking) finishBlock(g,p);
    if(input.useItem && p.item) useItem(g,p);
    if(input.fireGun && p.gunAmmo>0 && p.gunCD<=0) fireGun(g,p);
  });

  socket.on('disconnect', ()=>{
    console.log('- disconnect:', socket.id);
    const room=rooms.get(socket.roomCode);
    if(!room) return;
    room.players=room.players.filter(p=>p.socketId!==socket.id);
    if(room.players.length===0){clearInterval(room._interval);rooms.delete(socket.roomCode);}
    else io.to(socket.roomCode).emit('playerLeft',{playerIdx:socket.playerIdx,remaining:room.players.length});
  });
});

function startRoom(room) {
  room.state='playing'; room.game=makeGame();
  io.to(room.code).emit('gameStart',{playerList:room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx}))});
  console.log(`Game started in ${room.code} with ${room.players.length} players`);
  room._interval=setInterval(()=>{
    tickGame(room);
    const g=room.game;
    io.to(room.code).emit('state',{
      players:g.players.map(p=>({
        id:p.id,wx:+p.wx.toFixed(3),wz:+p.wz.toFixed(3),wy:+p.wy.toFixed(2),
        jumpH:+p.jumpH.toFixed(3),hasBall:p.hasBall,facing:p.facing,
        shooting:p.shooting,shootT:+p.shootT.toFixed(3),
        blocking:p.blocking,blockT:+p.blockT.toFixed(3),blockSuccess:p.blockSuccess,blockCD:+p.blockCD.toFixed(2),
        celebrating:+p.celebrating.toFixed(2),
        frozen:+p.frozen.toFixed(2),stunned:+p.stunned.toFixed(2),
        mega:+p.mega.toFixed(2),speed:+p.speed.toFixed(2),
        shield:p.shield,star:p.star,gunAmmo:p.gunAmmo,item:p.item,
        bobT:+p.bobT.toFixed(3),
      })),
      ball:{
        wx:+g.ball.wx.toFixed(3),wz:+g.ball.wz.toFixed(3),wy:+g.ball.wy.toFixed(3),
        spin:+g.ball.spin.toFixed(3),spinX:+g.ball.spinX.toFixed(3),
        inFlight:g.ball.inFlight,isPass:g.ball.isPass,loose:g.ball.loose,
        ownerIdx:g.ball.ownerIdx,meterQuality:g.ball.meterQuality,
        bvx:+g.ball.bvx.toFixed(3),bvz:+g.ball.bvz.toFixed(3),
      },
      itemBoxes:g.itemBoxes.map(b=>({id:b.id,wx:b.wx,wz:b.wz,alive:b.alive,item:b.item})),
      projectiles:g.projectiles.map(pr=>({id:pr.id,wx:+pr.wx.toFixed(3),wz:+pr.wz.toFixed(3),wy:pr.wy,vx:pr.vx,vz:pr.vz,type:pr.type})),
      tornado:g.tornado?{wx:+g.tornado.wx.toFixed(3),wz:+g.tornado.wz.toFixed(3),t:+g.tornado.t.toFixed(2)}:null,
      scores:g.scores,timeLeft:+g.timeLeft.toFixed(2),quarter:g.quarter,
      flashT:+g.flashT.toFixed(2),toast:g.toast,toastColor:g.toastColor,
    });
  }, TICK_MS);
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🏀 Hardwood Chaos on port ${PORT}`));
