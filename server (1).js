const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 2000, pingTimeout: 5000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const CW=28,CD=16,MX=CW/2,MZ=CD/2;
const HOOPS=[{wx:1.8,wy:3,wz:MZ,team:1},{wx:CW-1.8,wy:3,wz:MZ,team:0}];
const THREE_DIST=7.5,TICK_MS=50,DT=TICK_MS/1000;
const ITEM_KEYS=['rocket','freeze','bomb','mega','speed','shield','gun','tornado','star'];
const BOX_POS=[[MX,MZ-5],[MX,MZ+5],[5,MZ],[CW-5,MZ],[MX-5,MZ-3],[MX+5,MZ+3],[8,3],[CW-8,CD-3]];
const ITEM_ICONS={rocket:'🚀',freeze:'❄️',bomb:'💥',mega:'💪',speed:'⚡',shield:'🛡️',gun:'🔫',tornado:'🌀',star:'⭐'};
const ITEM_NAMES={rocket:'ROCKET!',freeze:'FREEZE RAY!',bomb:'BOMB!',mega:'MEGA SIZE!',speed:'SPEED BOOST!',shield:'SHIELD!',gun:'GUN!',tornado:'TORNADO!',star:'STAR POWER!'};
const ITEM_COLORS={rocket:'#ff6600',freeze:'#44aaff',bomb:'#ff4444',mega:'#ff00cc',speed:'#ffff00',shield:'#00ffaa',gun:'#ff8800',tornado:'#cc44ff',star:'#ffcc00'};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist2=(ax,az,bx,bz)=>Math.hypot(ax-bx,az-bz);
const lerp=(a,b,t)=>a+(b-a)*t;
const randItem=()=>ITEM_KEYS[Math.floor(Math.random()*ITEM_KEYS.length)];

const rooms=new Map();
function makeCode(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<4;i++)s+=c[Math.floor(Math.random()*c.length)];return rooms.has(s)?makeCode():s;}

function makePlayer(id,team){
  return{id,team,wx:id<2?MX-4:MX+4,wz:id%2===0?MZ-1.5:MZ+1.5,wy:0,jumpH:0,jumpV:0,bobT:0,
    hasBall:id===0,facing:team===0?1:-1,shotCD:0,stealCD:0,shooting:false,shootT:0,celebrating:0,
    item:null,frozen:0,stunned:0,mega:0,speed:0,shield:false,shieldT:0,star:0,gunAmmo:0,gunCD:0,_hasInput:false};
}
function makeBall(){return{wx:MX-4,wz:MZ-1.5,wy:0.3,spin:0,inFlight:false,ownerIdx:0,flightT:0,flightDur:0,sWX:0,sWZ:0,eWX:0,eWZ:0,peakH:0,willScore:false,is3:false,shotByIdx:-1,passToIdx:-1,meterQuality:'normal'};}
function makeGame(){return{scores:[0,0],quarter:1,timeLeft:120,tick:0,players:[0,1,2,3].map(i=>makePlayer(i,i<2?0:1)),ball:makeBall(),itemBoxes:BOX_POS.map(([wx,wz],i)=>({id:i,wx,wz,alive:true,respawn:0,item:randItem()})),projectiles:[],tornado:null,toast:'',toastColor:'#ff7700',flashT:0,flashCol:'rgba(255,200,0,1)',_pid:0};}

function tickGame(room){
  const g=room.game;if(!g||room.state!=='playing')return;
  g.tick++;g.timeLeft-=DT;g.toast='';
  if(g.timeLeft<=0){g.timeLeft=0;endQuarter(room);return;}
  tickTimers(g);tickPlayers(g);tickBall(g);tickProjectiles(g);tickItemBoxes(g);tickTornado(g);
}

function tickTimers(g){
  if(g.flashT>0)g.flashT-=DT;
  for(const p of g.players){
    if(p.frozen>0)p.frozen-=DT;if(p.stunned>0)p.stunned-=DT;
    if(p.mega>0)p.mega-=DT;if(p.speed>0)p.speed-=DT;
    if(p.shieldT>0){p.shieldT-=DT;if(p.shieldT<=0)p.shield=false;}
    if(p.shotCD>0)p.shotCD-=DT;if(p.stealCD>0)p.stealCD-=DT;if(p.gunCD>0)p.gunCD-=DT;
    if(p.celebrating>0)p.celebrating-=DT;
    if(p.jumpH>0||p.jumpV>0){p.jumpH+=(p.jumpV||0)*DT*60;p.jumpV=(p.jumpV||0)-0.015;if(p.jumpH<=0){p.jumpH=0;p.jumpV=0;}}
    p.bobT+=DT*4;
  }
}

function tickPlayers(g){
  for(const p of g.players){
    if(p.frozen>0||p.stunned>0)continue;
    if(p.shooting){p.shootT+=DT;if(p.shootT>0.75)releaseShot(g,p);}
    if(!p._hasInput){
      const carrier=g.players.find(pl=>pl.hasBall);
      if(carrier&&!p.hasBall&&!g.ball.inFlight){
        const tx=carrier.wx+(p.team===0?-4:4),tz=carrier.wz+(p.id%2===0?-2.5:2.5);
        const dx=tx-p.wx,dz=tz-p.wz,dd=Math.hypot(dx,dz);
        if(dd>0.5){const spd=(p.speed>0?0.19:0.07)*(p.mega>0?0.65:1);p.wx+=dx/dd*spd*0.55;p.wz+=dz/dd*spd*0.55;}
      }
    }
    p._hasInput=false;
    p.wx=clamp(p.wx,0.5,CW-0.5);p.wz=clamp(p.wz,0.5,CD-0.5);
  }
}

function releaseShot(g,p){
  if(!p.hasBall||!p.shooting)return;
  const charge=clamp(p.shootT,0.05,0.75);p.shooting=false;
  const hoop=HOOPS.find(h=>h.team!==p.team)||HOOPS[0];
  const d=dist2(p.wx,p.wz,hoop.wx,hoop.wz),is3=d>THREE_DIST;
  const norm=charge/0.75,inGreen=norm>=0.72&&norm<=0.92,perfect=norm>=0.78&&norm<=0.88;
  let acc=p.star>0||perfect?0.97:inGreen?0.85:is3?0.45:0.60;
  const makes=Math.random()<acc;
  if(p.star>0)p.star--;
  p.hasBall=false;p.shotCD=0.9;p.jumpV=0.18;
  const b=g.ball;b.inFlight=true;b.shotByIdx=p.id;b.passToIdx=-1;b.ownerIdx=-1;
  b.willScore=makes;b.is3=is3;b.meterQuality=perfect?'perfect':inGreen?'good':'bad';
  b.sWX=p.wx;b.sWZ=p.wz;b.eWX=makes?hoop.wx:hoop.wx+(Math.random()-0.5)*3;b.eWZ=makes?hoop.wz:hoop.wz+(Math.random()-0.5)*3;
  b.flightT=0;b.flightDur=0.6+d*0.02;b.peakH=3+d*0.15;
  g.toast=perfect?'PERFECT! 🎯':inGreen?'GOOD RELEASE! ✅':'EARLY / LATE ❌';
  g.toastColor=inGreen?'#00ff88':'#ff8800';
}

function doPass(g,p){
  const tm=g.players.filter(pl=>pl.team===p.team&&pl.id!==p.id);if(!tm.length)return;
  const target=tm.reduce((a,b)=>dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  p.hasBall=false;p.shotCD=0.4;const b=g.ball;
  b.inFlight=true;b.passToIdx=target.id;b.shotByIdx=-1;b.ownerIdx=-1;b.willScore=false;
  b.sWX=p.wx;b.sWZ=p.wz;b.eWX=target.wx;b.eWZ=target.wz;
  b.flightT=0;b.flightDur=0.22+dist2(p.wx,p.wz,target.wx,target.wz)*0.013;b.peakH=1.0;
}

function doSteal(g,p){
  for(const opp of g.players.filter(pl=>pl.team!==p.team&&pl.hasBall)){
    if(dist2(p.wx,p.wz,opp.wx,opp.wz)<(p.mega>0?4.5:1.8)){
      if(opp.shield){opp.shield=false;opp.shieldT=0;g.toast='SHIELD BLOCK!';g.toastColor='#00ffaa';return;}
      opp.hasBall=false;p.hasBall=true;p.stealCD=0.7;
      g.ball.ownerIdx=p.id;g.ball.inFlight=false;g.ball.wx=p.wx;g.ball.wz=p.wz;
      g.toast='STEAL! 💨';g.toastColor='#ff7700';return;
    }
  }
  if(g.ball.inFlight&&g.ball.passToIdx<0){
    const b=g.ball;
    if(dist2(b.wx,b.wz,p.wx,p.wz)<2&&b.wy<2.5){
      b.inFlight=false;p.hasBall=true;b.ownerIdx=p.id;b.wx=p.wx;b.wz=p.wz;b.wy=0.3;
      p.stealCD=0.5;g.toast='BLOCKED! ✋';g.toastColor='#ffffff';
    }
  }
}

function tickBall(g){
  const b=g.ball;b.spin+=DT*6;
  if(b.inFlight){
    b.flightT+=DT;const t=clamp(b.flightT/b.flightDur,0,1);
    b.wx=lerp(b.sWX,b.eWX,t);b.wz=lerp(b.sWZ,b.eWZ,t);b.wy=0.3+Math.sin(t*Math.PI)*b.peakH;
    if(b.passToIdx>=0&&t>=0.95){const r=g.players[b.passToIdx];b.inFlight=false;r.hasBall=true;b.ownerIdx=r.id;b.passToIdx=-1;b.wy=0.3;return;}
    if(t>=1.0){
      if(b.willScore){
        const sh=g.players[b.shotByIdx],pts=b.is3?3:2;
        g.scores[sh.team]+=pts;g.toast=pts===3?'THREE POINTER! 🔥':'BUCKET! +2 🏀';g.toastColor=pts===3?'#ffcc00':'#00ff88';
        g.flashT=0.5;sh.celebrating=1.4;sh.jumpV=0.25;
      }else{g.toast='MISS! 🙈';g.toastColor='#888888';}
      b.inFlight=false;b.willScore=false;
      const def=g.players.filter(pl=>pl.team!==(g.players[b.shotByIdx]?.team??-1));
      const recv=def[Math.floor(Math.random()*def.length)]||g.players[0];
      recv.hasBall=true;b.ownerIdx=recv.id;b.wx=recv.wx;b.wz=recv.wz;b.wy=0.3;b.shotByIdx=-1;
    }
  }else{const o=b.ownerIdx>=0?g.players[b.ownerIdx]:null;if(o){b.wx=lerp(b.wx,o.wx,0.35);b.wz=lerp(b.wz,o.wz,0.35);b.wy=0.3;}}
}

function useItem(g,p){
  if(!p.item)return;const item=p.item;p.item=null;
  switch(item){
    case'rocket':fireRocket(g,p);break;case'freeze':doFreeze(g,p);break;case'bomb':doBomb(g,p);break;
    case'mega':p.mega=5;g.toast='💪 MEGA SIZE!';g.toastColor='#ff00cc';break;
    case'speed':p.speed=4;g.toast='⚡ SPEED BOOST!';g.toastColor='#ffff00';break;
    case'shield':p.shield=true;p.shieldT=6;g.toast='🛡️ SHIELDED!';g.toastColor='#00ffaa';break;
    case'gun':p.gunAmmo=6;p.gunCD=0;g.toast='🔫 LOCKED & LOADED!';g.toastColor='#ff8800';break;
    case'tornado':g.tornado={t:4,wx:MX,wz:MZ,ownerIdx:p.id};g.toast='🌀 TORNADO!';g.toastColor='#cc44ff';break;
    case'star':p.star=3;g.toast='⭐ STAR POWER! (3 shots)';g.toastColor='#ffcc00';break;
  }
}

function fireRocket(g,p){
  const enemies=g.players.filter(pl=>pl.team!==p.team);if(!enemies.length)return;
  const target=enemies.reduce((a,b)=>dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  const dx=target.wx-p.wx,dz=target.wz-p.wz,d=Math.max(0.1,Math.hypot(dx,dz));
  g.projectiles.push({id:g._pid++,wx:p.wx,wy:0.8,wz:p.wz,vx:dx/d*0.25,vz:dz/d*0.25,type:'rocket',ownerIdx:p.id,targetIdx:target.id,t:0});
  g.toast='🚀 ROCKET AWAY!';g.toastColor='#ff6600';
}
function fireGun(g,p){
  if(p.gunAmmo<=0||p.gunCD>0)return;p.gunAmmo--;p.gunCD=0.18;
  const enemies=g.players.filter(pl=>pl.team!==p.team);if(!enemies.length)return;
  const target=enemies.reduce((a,b)=>dist2(p.wx,p.wz,a.wx,a.wz)<dist2(p.wx,p.wz,b.wx,b.wz)?a:b);
  const dx=target.wx-p.wx,dz=target.wz-p.wz,d=Math.max(0.1,Math.hypot(dx,dz));
  g.projectiles.push({id:g._pid++,wx:p.wx,wy:0.8,wz:p.wz,vx:dx/d*0.35,vz:dz/d*0.35,type:'bullet',ownerIdx:p.id,t:0});
}
function doFreeze(g,p){
  for(const e of g.players.filter(pl=>pl.team!==p.team)){if(e.shield){e.shield=false;e.shieldT=0;continue;}e.frozen=3;}
  g.toast='❄️ FROZEN!';g.toastColor='#44aaff';g.flashT=0.4;
}
function doBomb(g,p){
  g.toast='💥 BOOM!';g.toastColor='#ff4444';g.flashT=0.6;
  for(const o of g.players){if(o===p)continue;
    if(dist2(p.wx,p.wz,o.wx,o.wz)<3.5){
      if(o.shield){o.shield=false;o.shieldT=0;continue;}
      o.stunned=1.5;if(o.hasBall){o.hasBall=false;p.hasBall=true;g.ball.ownerIdx=p.id;g.ball.wx=p.wx;g.ball.wz=p.wz;}
      const dx=o.wx-p.wx||0.1,dz=o.wz-p.wz||0.1,d=Math.hypot(dx,dz)||1;
      o.wx=clamp(o.wx+dx/d*3,0.5,CW-0.5);o.wz=clamp(o.wz+dz/d*3,0.5,CD-0.5);
    }
  }
}
function tickProjectiles(g){
  g.projectiles=g.projectiles.filter(pr=>{
    pr.t+=DT;pr.wx+=pr.vx;pr.wz+=pr.vz;
    if(pr.wx<0||pr.wx>CW||pr.wz<0||pr.wz>CD||pr.t>4)return false;
    if(pr.type==='rocket'&&pr.targetIdx>=0){const tgt=g.players[pr.targetIdx];if(tgt){const dx=tgt.wx-pr.wx,dz=tgt.wz-pr.wz,d=Math.max(0.1,Math.hypot(dx,dz));pr.vx=lerp(pr.vx,dx/d*0.25,0.08);pr.vz=lerp(pr.vz,dz/d*0.25,0.08);}}
    for(const p of g.players){
      if(p.id===pr.ownerIdx)continue;const hr=pr.type==='rocket'?2:1.5;
      if(dist2(pr.wx,pr.wz,p.wx,p.wz)<hr){
        if(p.shield){p.shield=false;p.shieldT=0;return false;}
        if(pr.type==='rocket'){p.stunned=2;g.flashT=0.4;g.toast='🚀 DIRECT HIT!';g.toastColor='#ff6600';if(p.hasBall){p.hasBall=false;g.ball.inFlight=false;g.ball.ownerIdx=-1;g.ball.wx=p.wx;g.ball.wz=p.wz;g.ball.wy=0.3;}}
        else{p.stunned=0.8;}return false;
      }
    }
    return true;
  });
}
function tickItemBoxes(g){
  for(const box of g.itemBoxes){
    if(!box.alive){box.respawn-=DT;if(box.respawn<=0){box.alive=true;box.item=randItem();}continue;}
    for(const p of g.players){
      if(p.item)continue;
      if(dist2(p.wx,p.wz,box.wx,box.wz)<1.6){p.item=box.item;box.alive=false;box.respawn=12;g.toast=`${ITEM_ICONS[box.item]} ${ITEM_NAMES[box.item]}`;g.toastColor=ITEM_COLORS[box.item];}
    }
  }
}
function tickTornado(g){
  if(!g.tornado)return;g.tornado.t-=DT;if(g.tornado.t<=0){g.tornado=null;return;}
  const ang=g.tornado.t*2;g.tornado.wx=MX+Math.cos(ang)*6;g.tornado.wz=MZ+Math.sin(ang)*3.5;
  for(const p of g.players){
    if(p.id===g.tornado.ownerIdx)continue;
    const dd=dist2(p.wx,p.wz,g.tornado.wx,g.tornado.wz);
    if(dd<3.5){const dx=p.wx-g.tornado.wx||0.1,dz=p.wz-g.tornado.wz||0.1,d=Math.hypot(dx,dz)||1;p.wx=clamp(p.wx+dx/d*0.15,0.5,CW-0.5);p.wz=clamp(p.wz+dz/d*0.15,0.5,CD-0.5);}
  }
}
function endQuarter(room){
  const g=room.game;
  if(g.quarter>=4){room.state='over';io.to(room.code).emit('gameOver',{scores:g.scores});clearInterval(room._interval);return;}
  g.quarter++;g.timeLeft=120;g.toast='Q'+g.quarter+' START! 🏀';g.toastColor='#ff7700';
  g.players.forEach(p=>{p.hasBall=false;p.celebrating=0;p.jumpH=0;p.jumpV=0;p.shooting=false;p.frozen=0;p.stunned=0;p.mega=0;p.speed=0;p.shield=false;p.star=0;p.gunAmmo=0;p.item=null;});
  [[MX-4,MZ-1.5],[MX-4,MZ+1.5],[MX+4,MZ-1.5],[MX+4,MZ+1.5]].forEach(([wx,wz],i)=>{g.players[i].wx=wx;g.players[i].wz=wz;});
  g.players[0].hasBall=true;g.ball=makeBall();g.projectiles=[];g.tornado=null;
}

io.on('connection',socket=>{
  socket.on('ping_',()=>socket.emit('pong_'));
  socket.on('createRoom',({name})=>{
    const code=makeCode(),room={code,players:[],state:'waiting',game:null,_interval:null};
    rooms.set(code,room);room.players.push({socketId:socket.id,playerIdx:0,team:0,name:name||'P1'});
    socket.join(code);socket.roomCode=code;socket.playerIdx=0;
    socket.emit('roomCreated',{code,team:0,playerIdx:0});
  });
  socket.on('joinRoom',({code,name})=>{
    const room=rooms.get(code?.toUpperCase());
    if(!room){socket.emit('error','Room not found');return;}
    if(room.state!=='waiting'){socket.emit('error','Game already started');return;}
    if(room.players.length>=4){socket.emit('error','Room is full');return;}
    const taken=room.players.map(p=>p.playerIdx),playerIdx=[0,1,2,3].find(i=>!taken.includes(i)),team=playerIdx<2?0:1;
    room.players.push({socketId:socket.id,playerIdx,team,name:name||('P'+(playerIdx+1))});
    socket.join(code.toUpperCase());socket.roomCode=code.toUpperCase();socket.playerIdx=playerIdx;
    socket.emit('joinedRoom',{code:code.toUpperCase(),team,playerIdx});
    io.to(code.toUpperCase()).emit('playerList',room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx})));
    if(room.players.length>=2&&room.state==='waiting')startRoom(room);
  });
  socket.on('input',input=>{
    const room=rooms.get(socket.roomCode);if(!room||room.state!=='playing')return;
    const g=room.game,p=g.players[socket.playerIdx];if(!p||p.frozen>0||p.stunned>0)return;
    const spd=(p.speed>0?0.19:0.07)*(p.mega>0?0.65:1);
    let mx=0,mz=0;
    if(input.u){mx+=0.7;mz-=0.7;}if(input.d){mx-=0.7;mz+=0.7;}if(input.l){mx-=0.7;mz-=0.7;}if(input.r){mx+=0.7;mz+=0.7;}
    if(mx!==0||mz!==0){const len=Math.hypot(mx,mz)||1;p.wx+=mx/len*spd;p.wz+=mz/len*spd;p.facing=mx>0?1:-1;p._hasInput=true;p.wx=clamp(p.wx,0.5,CW-0.5);p.wz=clamp(p.wz,0.5,CD-0.5);}
    if(input.shootStart&&p.hasBall&&!p.shooting&&p.shotCD<=0){p.shooting=true;p.shootT=0;}
    if(input.shootEnd&&p.shooting&&p.hasBall)releaseShot(g,p);
    if(input.pass&&p.hasBall&&p.shotCD<=0)doPass(g,p);
    if(input.steal&&!p.hasBall&&p.stealCD<=0)doSteal(g,p);
    if(input.useItem)useItem(g,p);
    if(input.fireGun&&p.gunAmmo>0&&p.gunCD<=0)fireGun(g,p);
  });
  socket.on('disconnect',()=>{
    const room=rooms.get(socket.roomCode);if(!room)return;
    room.players=room.players.filter(p=>p.socketId!==socket.id);
    if(room.players.length===0){clearInterval(room._interval);rooms.delete(socket.roomCode);}
    else io.to(socket.roomCode).emit('playerLeft',{playerIdx:socket.playerIdx});
  });
});

function startRoom(room){
  room.state='playing';room.game=makeGame();
  io.to(room.code).emit('gameStart',{playerList:room.players.map(p=>({name:p.name,team:p.team,playerIdx:p.playerIdx}))});
  room._interval=setInterval(()=>{
    tickGame(room);const g=room.game;
    io.to(room.code).emit('state',{
      players:g.players.map(p=>({id:p.id,wx:+p.wx.toFixed(3),wz:+p.wz.toFixed(3),wy:+p.wy.toFixed(2),jumpH:+p.jumpH.toFixed(3),hasBall:p.hasBall,facing:p.facing,shooting:p.shooting,shootT:+p.shootT.toFixed(3),celebrating:+p.celebrating.toFixed(2),frozen:+p.frozen.toFixed(2),stunned:+p.stunned.toFixed(2),mega:+p.mega.toFixed(2),speed:+p.speed.toFixed(2),shield:p.shield,star:p.star,gunAmmo:p.gunAmmo,item:p.item,bobT:+p.bobT.toFixed(3)})),
      ball:{wx:+g.ball.wx.toFixed(3),wz:+g.ball.wz.toFixed(3),wy:+g.ball.wy.toFixed(3),spin:+g.ball.spin.toFixed(3),inFlight:g.ball.inFlight,ownerIdx:g.ball.ownerIdx,meterQuality:g.ball.meterQuality},
      itemBoxes:g.itemBoxes.map(b=>({id:b.id,wx:b.wx,wz:b.wz,alive:b.alive,item:b.item})),
      projectiles:g.projectiles.map(pr=>({id:pr.id,wx:+pr.wx.toFixed(3),wz:+pr.wz.toFixed(3),wy:pr.wy,vx:pr.vx,vz:pr.vz,type:pr.type})),
      tornado:g.tornado?{wx:+g.tornado.wx.toFixed(3),wz:+g.tornado.wz.toFixed(3),t:+g.tornado.t.toFixed(2)}:null,
      scores:g.scores,timeLeft:+g.timeLeft.toFixed(2),quarter:g.quarter,
      flashT:+g.flashT.toFixed(2),toast:g.toast,toastColor:g.toastColor,
    });
  },TICK_MS);
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🏀 Hardwood Chaos server on port ${PORT}`));
