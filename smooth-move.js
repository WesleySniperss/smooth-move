/**
 * smooth-move.js — Foundry VTT v13
 */

const MODULE_ID = "smooth-move";
console.log("[smooth-move] FILE LOADED");

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "animMs", {
    name: "Animation duration (ms, full path)",
    scope: "client", config: true,
    type: Number, default: 900, range: { min: 0, max: 3000, step: 50 },
  });
  game.settings.register(MODULE_ID, "stepSound", {
    name: "Walking step sounds",
    scope: "client", config: true,
    type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "playersOnly", {
    name: "Animate player tokens only",
    hint: "When enabled, NPC tokens move instantly without animation.",
    scope: "world", config: true,
    type: Boolean, default: false,
  });
});

Hooks.once("setup", () => {
  const Base = CONFIG.Token.objectClass ?? foundry.canvas.placeables.Token;

  class SmoothMoveToken extends Base {

    _refreshPosition(...args) {
      if (this._smActive || this._smCommitting) return;
      return super._refreshPosition?.(...args);
    }

    async animateMovement(...args) {
      if (this._smActive || this._smCommitting) return;
      return super.animateMovement?.(...args);
    }

    async _animateMovement(...args) {
      if (this._smActive || this._smCommitting) return;
      return super._animateMovement?.(...args);
    }

    _onUpdate(data, options, userId) {
      // Case 1: finishing our own local drag — document is updated, sync visuals
      if (this._smCommitting) {
        super._onUpdate(data, options, userId);
        delete this._smCommitting;
        canvas.tokens?.recalculatePlannedMovementPaths?.();
        syncPosAndPerception(this);
        return;
      }

      // Case 2: position update sent by another client with animate:false
      // (smooth-move always sends animate:false, so other clients need to animate themselves)
      const hasPos = data.x != null || data.y != null;
      if (hasPos && !this._smActive && options?.animate === false) {
        const startX = this.mesh?.position.x;
        const startY = this.mesh?.position.y;

        super._onUpdate(data, options, userId); // updates document, snaps mesh to new pos

        const w = this.w ?? 0, h = this.h ?? 0;
        const wps = options?.movement?.[this.id]?.waypoints;
        let pts;
        if (wps?.length >= 2) {
          pts = wps.map(wp => ({ x: wp.x + w/2, y: wp.y + h/2 }));
          if (startX != null) pts[0] = { x: startX, y: startY };
        } else {
          const endX = (data.x ?? this.document.x) + w/2;
          const endY = (data.y ?? this.document.y) + h/2;
          if (startX == null || (Math.abs(startX - endX) < 2 && Math.abs(startY - endY) < 2)) return;
          pts = [{ x: startX, y: startY }, { x: endX, y: endY }];
        }
        if (pts.length >= 2) {
          if (this.mesh) this.mesh.position.set(pts[0].x, pts[0].y);
          animate(this, pts, getMoveMode(this)).catch(() => {});
        }
        return;
      }

      super._onUpdate(data, options, userId);
    }

    _onDragLeftStart(event, ...args) {
      const r = super._onDragLeftStart(event, ...args);
      if (this.isOwner && this.mesh)
        this._smStartPx = { x: this.mesh.position.x, y: this.mesh.position.y };
      return r;
    }

    _onDragLeftCancel(event, ...args) {
      if (this._smStartPx) {
        const ctx = event?.interactionData?.contexts?.[this.document.id];
        if (ctx?.waypoints) {
          const isCtrl = event.ctrlKey || event.metaKey;
          if (isCtrl) this._removeDragWaypoint?.();
          else this._addDragWaypoint?.(event.interactionData.destination, { snap: !event.shiftKey });
          return false;
        }
      }
      const startPx = this._smStartPx;
      if (startPx && this.mesh) {
        this.mesh.position.set(startPx.x, startPx.y);
        syncPosAndPerception(this);
      }
      delete this._smStartPx;
      return super._onDragLeftCancel(event, ...args);
    }

    _onDragLeftDrop(event, ...args) {
      const startPx = this._smStartPx;
      if (!startPx) return super._onDragLeftDrop(event, ...args);

      // Only the first selected token to drop handles the group — others are animated via _onUpdate
      if (this.layer?._smGroupDrop) { delete this._smStartPx; return; }

      if ((game.settings.get(MODULE_ID, "playersOnly") ?? false) && !this.actor?.hasPlayerOwner) {
        delete this._smStartPx;
        return super._onDragLeftDrop(event, ...args);
      }

      let tokenUpdates, updateOptions;
      try {
        const raw = this._prepareDragLeftDropUpdates?.(event);
        if (Array.isArray(raw?.[0])) [tokenUpdates, updateOptions] = raw;
        else { tokenUpdates = raw ?? []; updateOptions = {}; }
      } catch (e) { console.warn("[smooth-move] _prepareDragLeftDropUpdates error:", e); }

      if (!tokenUpdates?.length) { delete this._smStartPx; return super._onDragLeftDrop(event, ...args); }

      // Build animation jobs for every token in this group move
      const jobs = [];
      for (const upd of tokenUpdates) {
        const tid = upd._id ?? upd.id;
        const t   = tid === this.id ? this : canvas.tokens?.get(tid);
        if (!t?.mesh) continue;
        const tStart = t._smStartPx ?? { x: t.mesh.position.x, y: t.mesh.position.y };
        delete t._smStartPx;
        const tWPs = updateOptions?.movement?.[tid]?.waypoints;
        if (!tWPs?.length) continue;
        const tw = t.w ?? 0, th = t.h ?? 0;
        const meshWPs = tWPs.map(wp => ({ x: wp.x + tw/2, y: wp.y + th/2 }));
        const first   = meshWPs[0];
        const skip    = Math.abs(first.x - tStart.x) < 2 && Math.abs(first.y - tStart.y) < 2;
        const raw     = skip ? [tStart, ...meshWPs.slice(1)] : [tStart, ...meshWPs];
        const tMode   = getMoveMode(t);
        const pts     = (tMode === "walk" || tMode === "climb") ? expandToGridCells(raw, t) : raw;
        jobs.push({ token: t, pts, mode: tMode, upd });
      }

      if (!jobs.length) { delete this._smStartPx; return super._onDragLeftDrop(event, ...args); }

      const capturedUpdates = tokenUpdates;
      const capturedOptions = updateOptions;
      this.layer._smGroupDrop = true;

      (async () => {
        this.layer?.clearPreviewContainer?.();
        for (const j of jobs) if (j.token.mesh) j.token.mesh.position.set(j.pts[0].x, j.pts[0].y);

        await Promise.all(jobs.map(j => animate(j.token, j.pts, j.mode)));

        // Build commit movement for all tokens
        const commitMovement = {};
        for (const j of jobs) {
          const origMov = capturedOptions?.movement?.[j.token.id] ?? {};
          commitMovement[j.token.id] = { ...origMov, waypoints: [origMov.waypoints?.at(-1) ?? j.upd] };
          j.token._smCommitting = true;
          setTimeout(() => { delete j.token._smCommitting; }, 500);
        }

        await canvas.scene?.updateEmbeddedDocuments("Token", capturedUpdates,
          { animate: false, panCamera: false, movement: commitMovement });

        for (const j of jobs) {
          const t = j.token;
          if (t.mesh) {
            const docX = t.document?.x ?? j.upd.x;
            const docY = t.document?.y ?? j.upd.y;
            if (docX != null) t.mesh.position.set(docX + (t.w ?? 0)/2, docY + (t.h ?? 0)/2);
          }
          delete t.x; delete t.y;
        }
      })().catch(err => console.error("[smooth-move] animation error:", err))
        .finally(() => { this.layer._smGroupDrop = false; });
    }
  }

  CONFIG.Token.objectClass = SmoothMoveToken;
});

Hooks.once("ready", () => {
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    for (const token of canvas.tokens?.placeables ?? []) {
      if (!token._smStartPx) continue;
      if (token.mesh) { token.mesh.position.set(token._smStartPx.x, token._smStartPx.y); syncPos(token); }
      delete token._smStartPx;
    }
  }, { capture: true });
  Hooks.on("canvasReady",    () => { for (const t of canvas.tokens?.placeables ?? []) delete t._smStartPx; _fly.destroy(); _fly.init(); });
  Hooks.on("canvasTearDown", () => _fly.destroy());
  // canvasReady fires before ready, so init immediately if canvas is already up
  if (canvas?.ready) _fly.init();
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const eio   = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
const eio4  = t => t < 0.5 ? 8*t*t*t*t : 1 - 8*(1-t)*(1-t)*(1-t)*(1-t);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const animMs = () => game.settings.get(MODULE_ID, "animMs") ?? 900;

const STEP_SOUNDS = [
  "modules/aeris-tokens/assets/sfx_step_grass_l.ogg",
  "modules/aeris-tokens/assets/sfx_step_grass_r.ogg",
];
function playStepSound(i) {
  try {
    if (!game.settings.get(MODULE_ID, "stepSound")) return;
    const vol = Number(game.settings?.storage?.get("client")?.["core.globalInterfaceVolume"] ?? "1");
    game.audio?.play(STEP_SOUNDS[i % 2], { volume: vol * 0.5 });
  } catch (_) {}
}

function syncPos(token) {
  const mesh = token.mesh;
  if (!mesh) return;
  Object.assign(token, {
    x: mesh.position.x - (token.w ?? 0) / 2,
    y: mesh.position.y - (token.h ?? 0) / 2,
  });
}

function syncPosAndPerception(token) {
  syncPos(token);
  token.initializeSources?.();
  canvas.perception?.update({ refreshVision: true });
}

function getMoveMode(token) {
  return (
    token.dragActionHandler?.currentAction
    ?? token.document?.movementAction
    ?? token.document?.getFlag?.("aeris-tokens", "movementAction")
    ?? "walk"
  ).toLowerCase();
}

function expandToGridCells(pts, token) {
  const gs = canvas.grid.size ?? 100;
  const w  = token.w ?? gs, h = token.h ?? gs;
  const toCell = px => ({ col: Math.round((px.x - w/2) / gs), row: Math.round((px.y - h/2) / gs) });
  const toPx   = (col, row) => ({ x: col*gs + w/2, y: row*gs + h/2 });

  const result = [];
  let first = true;
  for (let i = 0; i < pts.length - 1; i++) {
    const { col: c0, row: r0 } = toCell(pts[i]);
    const { col: c1, row: r1 } = toCell(pts[i+1]);
    if (first) { result.push(toPx(c0, r0)); first = false; }
    let col = c0, row = r0;
    while (col !== c1 || row !== r1) {
      col += Math.sign(c1 - col); row += Math.sign(r1 - row);
      result.push(toPx(col, row));
    }
  }
  return result.length >= 2 ? result : pts;
}

// ═══════════════════════════════════════════════════════════════════════════
// Particle system
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates unit-scale polygon vertices for an irregular chunk.
 * Scale at draw time by multiplying by current radius.
 */
function makeChunkVerts(n = 6) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n) * 1.3;
    const d = 0.5 + Math.random() * 0.6;
    v.push([Math.cos(a) * d, Math.sin(a) * d]);
  }
  return v;
}

/**
 * Particle properties:
 *   x, y, vx, vy  — position & velocity (px/frame)
 *   r0, r1         — start/end radius
 *   drag           — per-frame velocity retention (e.g. 0.88^(1/60) → 0.88 after 1 s at 60 fps)
 *   color          — PIXI hex
 *   alpha          — peak opacity
 *   life, age      — seconds
 *   ring, lw       — draw as circle outline instead of fill
 *   shape          — 'circle' | 'ellipse' | 'streak' | 'poly'
 *   rotV           — rotation velocity (rad/frame), for poly
 *   rot            — current rotation (rad)
 *   verts          — unit polygon verts [[x,y]…], for poly
 *   sdx, sdy       — initial dir (normalised), for streak
 *   rx, ry         — ellipse half-radii relative to r, for ellipse
 */
function makeParticleLayer() {
  const gfx = new PIXI.Graphics();
  canvas.stage.addChild(gfx);
  const ps = [];

  const tick = () => {
    const dt = clamp((canvas.app.ticker.deltaMS || 16.667) / 1000, 0, 0.1);
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) { ps.splice(i, 1); continue; }
      // Trail particles: velocity direction evolves over lifetime via curve
      if (p.shape === 'trail' && p.ang0 !== undefined) {
        const lt  = clamp(p.age / p.life, 0, 1);
        const ea  = lt < 0.5 ? 2*lt*lt : -1+(4-2*lt)*lt; // ease in-out
        const ang = p.ang0 + (p.ang1 - p.ang0) * ea
                  + Math.sin(lt * (p.oscF ?? 5) + (p.oscPh ?? 0)) * (p.oscA ?? 0.35);
        const spd = (p.spd ?? 80) * (1 - lt * 0.5); // gradually decelerates
        p.vx = Math.cos(ang) * spd;
        p.vy = Math.sin(ang) * spd;
      }
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      const df = Math.pow(p.drag, dt * 60);
      p.vx *= df; p.vy *= df;
      if (p.rotV) p.rot = (p.rot ?? 0) + p.rotV;
      // Record position history for trail rendering
      if (p.shape === 'trail') {
        if (!p.hist) p.hist = [];
        p.hist.push({ x: p.x, y: p.y });
        if (p.hist.length > (p.histLen ?? 18)) p.hist.shift();
      }
    }

    gfx.clear();
    for (const p of ps) {
      const tf  = p.age / p.life;
      const fi  = p.fadeIn ? clamp(tf / p.fadeIn, 0, 1) : 1;
      const fo  = p.fadeIn
        ? clamp(1 - (tf - p.fadeIn) / Math.max(1 - p.fadeIn, 0.001), 0, 1)
        : (1 - tf) * (1 - tf);
      const a   = p.alpha * fi * fo;
      const r   = p.r0 + (p.r1 - p.r0) * tf;
      if (r <= 0 || a <= 0.01) continue;

      const shape = p.shape ?? 'circle';

      if (p.ring) {
        const sq = p.squash ?? 1;
        gfx.lineStyle(p.lw ?? 1, p.color, a);
        if (sq < 1) gfx.drawEllipse(p.x, p.y, r, r * sq);
        else        gfx.drawCircle(p.x, p.y, r);
        gfx.lineStyle(0);
      } else if (shape === 'poly' && p.verts) {
        const cos = Math.cos(p.rot ?? 0), sin = Math.sin(p.rot ?? 0);
        const pts = [];
        for (const [vx, vy] of p.verts) {
          pts.push(p.x + (vx * cos - vy * sin) * r, p.y + (vx * sin + vy * cos) * r);
        }
        gfx.beginFill(p.color, a);
        gfx.drawPolygon(pts);
        gfx.endFill();
        // edge highlight
        gfx.lineStyle(0.7, p.color + 0x303010, a * 0.4);
        gfx.drawPolygon(pts);
        gfx.lineStyle(0);
      } else if (shape === 'windstreak' && p.p0) {
        // Growing animated bezier streaks with flutter
        const growT  = Math.min(1, p.age / (p.life * 0.40));
        const flutter = Math.sin(p.age * 20 + (p.phase ?? 0)) * (p.fm ?? 0) * (1 - tf) * 0.8;
        const qx = (p0, cp, p1, t) => (1-t)*(1-t)*p0 + 2*(1-t)*t*cp + t*t*p1;
        const N = 18;
        for (const ln of (p.lines ?? [])) {
          const la = a * ln.af * (0.3 + growT * 0.7);
          if (la <= 0.01 || ln.lw <= 0) continue;
          const fpx = p.fpx ?? 0, fpy = p.fpy ?? 0;
          const ox  = ln.ox + fpx * flutter, oy = ln.oy + fpy * flutter;
          const p0x = p.p0.x+ox,   p0y = p.p0.y+oy;
          const cpX = p.cp.x+ox+fpx*flutter*.7, cpY = p.cp.y+oy+fpy*flutter*.7;
          const p1x = p.p1.x+ox,   p1y = p.p1.y+oy;
          const ncpx = p0x+(cpX-p0x)*growT, ncpy = p0y+(cpY-p0y)*growT;
          const np1x = (1-growT)*(1-growT)*p0x + 2*(1-growT)*growT*cpX + growT*growT*p1x;
          const np1y = (1-growT)*(1-growT)*p0y + 2*(1-growT)*growT*cpY + growT*growT*p1y;
          for (let i = 0; i < N; i++) {
            const t0 = i/N, t1 = (i+1)/N;
            const tMid = (t0+t1)*0.5;
            const segA = la * (Math.sin(Math.PI * tMid) * 0.85 + 0.15);
            if (segA <= 0.01) continue;
            gfx.lineStyle(ln.lw * (0.4 + growT * 0.6), p.color, segA);
            gfx.moveTo(qx(p0x,ncpx,np1x,t0), qx(p0y,ncpy,np1y,t0));
            gfx.lineTo(qx(p0x,ncpx,np1x,t1), qx(p0y,ncpy,np1y,t1));
          }
          gfx.lineStyle(0);
        }
      } else if (shape === 'trail') {
        const hist = p.hist;
        if (!hist || hist.length < 2) continue;
        const n = hist.length;
        const tw = p.trailW ?? 2.2;
        for (let i = 1; i < n; i++) {
          const frac = i / (n - 1);
          const segA = a * frac * frac * frac;
          const segW = tw * frac * (0.3 + 0.7 * (1 - tf));
          if (segA <= 0.008 || segW <= 0.04) continue;
          gfx.lineStyle(segW, p.color, segA);
          gfx.moveTo(hist[i - 1].x, hist[i - 1].y);
          gfx.lineTo(hist[i].x,     hist[i].y);
        }
        gfx.lineStyle(0);
      } else if (p.soft) {
        // Soft radial gradient blob: concentric ellipses outer→inner
        const sy = p.squash ?? 0.85;
        for (let s = 3; s >= 1; s--) {
          const rs = r * (s / 3);
          const as = a * ((4 - s) / 3) * 0.42;
          gfx.beginFill(p.color, as);
          gfx.drawEllipse(p.x, p.y, rs, rs * sy);
          gfx.endFill();
        }
      } else {
        gfx.beginFill(p.color, a);
        gfx.drawCircle(p.x, p.y, r);
        gfx.endFill();
      }
    }
  };

  canvas.app.ticker.add(tick);
  return {
    spawn(p) {
      ps.push({ age: 0, drag: 0.90, alpha: 1, ring: false, lw: 1,
                r1: 0, shape: 'circle', rot: 0, ...p, r0: p.r ?? p.r0 ?? 2 });
    },
    destroy() {
      canvas.app.ticker.remove(tick);
      try { gfx.destroy(); } catch (_) {}
    },
  };
}

// ─── Spawners ────────────────────────────────────────────────────────────────

// tr = token half-size (radius), used to spread spawn across the token area.

function spawnWalkDust(layer, x, y, dirX, dirY, tr) {
  const r   = tr ?? 30;
  const bAng = Math.atan2(-dirY, -dirX);
  const count = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const ang = bAng + (Math.random() - 0.5) * 1.7;
    const spd = (30 + Math.random() * 55) / 60;
    // spawn from back half of the token footprint
    const ox = x - dirX * r * (0.2 + Math.random() * 0.8) + (Math.random() - 0.5) * r * 1.2;
    const oy = y - dirY * r * (0.2 + Math.random() * 0.8) + (Math.random() - 0.5) * r * 1.2;
    layer.spawn({
      x: ox, y: oy,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      r0: 1.8 + Math.random() * 2.5, r1: 0,
      color: 0xc4a882, alpha: 0.55 + Math.random() * 0.3,
      life: 0.22 + Math.random() * 0.2,
      drag: Math.pow(0.85, 1/60),
      shape: 'circle',
    });
  }
}

function spawnSwimBubble(layer, x, y, dirX, dirY, tr) {
  if (Math.random() > 0.55) return;
  const r    = tr ?? 30;
  const bAng = Math.atan2(-dirY, -dirX);
  const n    = 1 + (Math.random() > 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const ang  = bAng + (Math.random() - 0.5) * 2.0;
    const spd  = (8 + Math.random() * 18) / 60;
    const sz   = 3 + Math.random() * 5;
    // spawn from anywhere inside the token circle
    const a2 = Math.random() * Math.PI * 2;
    const d2 = Math.random() * r * 0.9;
    layer.spawn({
      x: x + Math.cos(a2)*d2, y: y + Math.sin(a2)*d2,
      vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd,
      r0: sz * 0.35, r1: sz,
      color: 0x99ccee, alpha: 0.75,
      life: 0.65 + Math.random() * 0.55,
      drag: Math.pow(0.96, 1/60),
      ring: true, lw: 1.2,
    });
  }
}

// Burst of soft air blobs at takeoff / landing
function spawnFlyBurst(layer, x, y, tr) {
  const r    = Math.max(tr ?? 30, 25);
  const n    = 32;
  const drag = Math.pow(0.91, 1 / 60);
  const sq   = 0.55;

  for (let i = 0; i < n; i++) {
    const ang    = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
    const radSpd = (30 + Math.random() * 28) / 60;
    const tanSpd = (12 + Math.random() * 14) / 60;
    const tanDir = Math.random() > 0.5 ? 1 : -1;
    const dist   = r * (0.2 + Math.random() * 0.35);
    layer.spawn({
      x: x + Math.cos(ang) * dist,
      y: y + Math.sin(ang) * dist * sq,
      vx: Math.cos(ang) * radSpd + Math.cos(ang + Math.PI * 0.5) * tanSpd * tanDir,
      vy: Math.sin(ang) * radSpd * sq + Math.sin(ang + Math.PI * 0.5) * tanSpd * tanDir * sq,
      drag,
      r0: r * (0.10 + Math.random() * 0.10),
      r1: r * (0.25 + Math.random() * 0.20),
      color: 0xdcedff,
      alpha: 0.32 + Math.random() * 0.20,
      life:  0.55 + Math.random() * 0.40,
      soft: true, squash: sq,
      fadeIn: 0.10,
    });
  }
}

function spawnDirtChunk(layer, x, y, _dirX, _dirY, tr, underground) {
  const r = tr ?? 30;
  // More chunks and larger when underground
  const base  = underground ? 4 : 2;
  const count = base + Math.floor(Math.random() * (underground ? 4 : 3));
  const DIRT  = [0x8B5E3C, 0x6B4226, 0x9E7050, 0x5C3A1E, 0xA0784A, 0x7A5030];

  for (let i = 0; i < count; i++) {
    const ang  = Math.random() * Math.PI * 2;
    const spd  = ((underground ? 55 : 40) + Math.random() * 65) / 60;
    const sz   = (underground ? 4 : 2.5) + Math.random() * (underground ? 5 : 4);
    const c    = DIRT[Math.floor(Math.random() * DIRT.length)];
    // spawn from across the full token footprint
    const sa = Math.random() * Math.PI * 2;
    const sd = Math.random() * r * 0.95;
    layer.spawn({
      x: x + Math.cos(sa)*sd, y: y + Math.sin(sa)*sd,
      vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd,
      r0: sz, r1: sz * 0.2,
      color: c, alpha: underground ? 0.95 : 0.88,
      life: (underground ? 0.55 : 0.45) + Math.random() * 0.4,
      drag: Math.pow(0.87, 1/60),
      shape: 'poly',
      verts: makeChunkVerts(5 + Math.floor(Math.random() * 3)),
      rot:   Math.random() * Math.PI * 2,
      rotV:  (Math.random() - 0.5) * 0.12,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Animation profiles
// ═══════════════════════════════════════════════════════════════════════════

const PROFILES = {
  walk:   { kind: "walk",   mult: 1.0 },
  fly:    { kind: "cont",   mult: 1.0, ease: eio4,
            scale: t => 1 + 0.10 * Math.sin(Math.PI * t) },
  swim:   { kind: "cont",   mult: 2.0, ease: eio,
            ox: (t, gs) => Math.sin(t * Math.PI * 4) * gs * 0.07,
            oy: (t, gs) => Math.sin(t * Math.PI * 8) * gs * 0.035,
            effect: spawnSwimBubble, effectHz: 6 },
  climb:  { kind: "step",   mult: 1.2, ease: eio, pause: 80 },
  crawl:  { kind: "cont",   mult: 1.0, ease: eio },
  burrow: { kind: "cont",   mult: 2.0, ease: eio,
            alpha: t => 1 - Math.sin(t * Math.PI) * 0.82,
            effect: spawnDirtChunk, effectHz: 4 },
  teleport: { kind: "teleport", mult: 0.8 },
  blink:    { kind: "teleport", mult: 0.8 },
  tp:       { kind: "teleport", mult: 0.8 },
};

async function animate(token, waypoints, mode) {
  if (!waypoints || waypoints.length < 2) return;
  const totalMs = animMs();
  if (totalMs <= 0) return;

  const prof = PROFILES[mode] ?? PROFILES.walk;
  const dur  = totalMs * prof.mult;
  const gs   = canvas.grid.size ?? 100;
  const bsx  = token.mesh?.scale?.x ?? 1;
  const bsy  = token.mesh?.scale?.y ?? 1;
  const tr   = Math.min(token.w ?? 50, token.h ?? 50) / 2;

  // Takeoff cloud burst for elevated tokens
  const elevated = (token.document?.elevation ?? 0) > 0;
  let burstLayer = null;
  if (elevated) {
    burstLayer = makeParticleLayer();
    spawnFlyBurst(burstLayer, waypoints[0].x, waypoints[0].y, tr);
  }

  token._smActive = true;
  try {
    if (prof.kind === "walk") {
      const steps   = waypoints.length - 1;
      const totalFt = steps * (canvas.grid.distance ?? 5);
      await animWalk(token, waypoints, totalFt < 30 ? steps * 325 : 900, bsx, bsy);
    }
    else if (prof.kind === "step")     await animStep(token, waypoints, dur, prof);
    else if (prof.kind === "teleport") await animTeleport(token, waypoints, dur, bsx, bsy);
    else                               await animCont(token, waypoints, dur, prof, gs, bsx, bsy);
  } finally {
    if (token.mesh) { token.mesh.alpha = 1; token.mesh.rotation = 0; token.mesh.scale.set(bsx, bsy); }
    syncPosAndPerception(token);
    delete token._smActive;
    // Landing cloud burst
    if (elevated && burstLayer) {
      const last = waypoints[waypoints.length - 1];
      spawnFlyBurst(burstLayer, last.x, last.y, tr);
      setTimeout(() => burstLayer.destroy(), 2000);
    }
  }
}

// ─── Fly effect system ───────────────────────────────────────────────────────
const _TAU = Math.PI * 2;
const _lerp = (a, b, t) => a + (b - a) * t;
const _easeOut = t => 1 - Math.pow(1 - t, 2.5);

const _FLY_CFG = {
  ringRateMs:    1200,
  ringLifeMs:    1600,
  ringMaxR:      55,
  ringParticles: 40,
  ringSquashY:   0.55,
  flapMs:        380,
  puffLifeMs:    1000,
  puffSize:      26,
  wingOffsetPx:  14,
  wingBackPx:    4,
  puffOutSpeed:  0.6,
  puffDrag:      0.94,
  moveThreshold: 0.8,
  smoothFactor:  0.2,
  maxPuffsTotal: 200,
  maxRingsTotal: 16,
  zIndex:        200,
  colorCore:     [220, 235, 255],
  colorMid:      [180, 210, 240],
  colorEdge:     [140, 180, 220],
  alphaMax:      0.9,
};

function _mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function _pixiRender(renderer, gfx, rt) {
  try        { renderer.render({ container: gfx, target: rt }); }
  catch (_)  {
    try      { renderer.render(gfx, rt); }
    catch(_2){ renderer.render({ container: gfx, renderTexture: rt }); }
  }
}

function _bakeBlobTexture(renderer, size = 64) {
  const c = size / 2;
  const g = new PIXI.Graphics();
  const [r0,g0,b0] = _FLY_CFG.colorCore, [r1,g1,b1] = _FLY_CFG.colorMid, [r2,g2,b2] = _FLY_CFG.colorEdge;
  for (let i = 12; i >= 1; i--) {
    const t = i / 12;
    let cr, cg, cb, ca;
    if (t < 0.4) {
      const k = t / 0.4;
      cr = _lerp(r0,r1,k); cg = _lerp(g0,g1,k); cb = _lerp(b0,b1,k); ca = _lerp(0.55,0.35,k);
    } else {
      const k = (t-0.4)/0.6;
      cr = _lerp(r1,r2,k); cg = _lerp(g1,g2,k); cb = _lerp(b1,b2,k); ca = _lerp(0.35,0,k);
    }
    g.beginFill((Math.round(cr)<<16)|(Math.round(cg)<<8)|Math.round(cb), ca);
    g.drawCircle(c, c, c * t);
    g.endFill();
  }
  const rt = PIXI.RenderTexture.create({ width: size, height: size });
  _pixiRender(renderer, g, rt);
  g.destroy();
  return rt;
}

function _bakePuffTexture(renderer, seed, size = 128) {
  const rand = _mulberry32(seed);
  const c = size / 2, R = size * 0.38;
  const N = 10 + Math.floor(rand() * 5);
  const g = new PIXI.Graphics();
  const [r0,g0,b0] = _FLY_CFG.colorCore, [r1,g1,b1] = _FLY_CFG.colorMid, [r2,g2,b2] = _FLY_CFG.colorEdge;
  for (let i = 0; i < N; i++) {
    const a = rand()*_TAU, d = rand()*R*0.7;
    const bx = c+Math.cos(a)*d, by = c+Math.sin(a)*d*0.75;
    const br = R*(0.35+rand()*0.3), ba = 0.4+rand()*0.4;
    for (let j = 8; j >= 1; j--) {
      const t = j/8;
      let cr, cg, cb, ca;
      if (t < 0.4) {
        const k=t/0.4; cr=_lerp(r0,r1,k); cg=_lerp(g0,g1,k); cb=_lerp(b0,b1,k); ca=_lerp(0.55,0.30,k)*ba;
      } else {
        const k=(t-0.4)/0.6; cr=_lerp(r1,r2,k); cg=_lerp(g1,g2,k); cb=_lerp(b1,b2,k); ca=_lerp(0.30,0,k)*ba;
      }
      g.beginFill((Math.round(cr)<<16)|(Math.round(cg)<<8)|Math.round(cb), ca);
      g.drawCircle(bx, by, br*t);
      g.endFill();
    }
  }
  const rt = PIXI.RenderTexture.create({ width: size, height: size });
  _pixiRender(renderer, g, rt);
  g.destroy();
  return rt;
}

class _Ring {
  constructor() { this.particles=[]; this.cx=0; this.cy=0; this.age=0; this.life=0; this.maxR=0; this.squashY=0; this.tilt=0; }

  reset(cx, cy, blobTex, container) {
    this.cx=cx; this.cy=cy; this.age=0;
    this.life    = _FLY_CFG.ringLifeMs * (0.85 + Math.random()*0.3);
    this.maxR    = _FLY_CFG.ringMaxR   * (0.9  + Math.random()*0.2);
    this.squashY = _FLY_CFG.ringSquashY + (Math.random()-0.5)*0.15;
    this.tilt    = (Math.random()-0.5)*0.3;
    this.particles.length = 0;
    const N = _FLY_CFG.ringParticles;
    for (let i = 0; i < N; i++) {
      const a = (i/N)*_TAU + (Math.random()-0.5)*0.15;
      if (Math.random() < 0.3) continue;
      const spr = new PIXI.Sprite(blobTex);
      spr.anchor.set(0.5);
      container.addChild(spr);
      this.particles.push({ baseAngle:a, radOff:(Math.random()-0.5)*0.25, driftMul:0.85+Math.random()*0.3, size:0.75+Math.random()*0.6, alphaMul:0.5+Math.random()*0.5, spr });
    }
  }

  update(dt) {
    this.age += dt;
    if (this.age >= this.life) { this.destroy(); return false; }
    const t = this.age / this.life;
    const R = this.maxR * (1 - Math.pow(1-t, 2.2));
    const env = Math.min(t/0.12, 1) * (1 - Math.pow(t, 1.5));
    const baseA = env * _FLY_CFG.alphaMax;
    const grow  = 1 + t * 1.5;
    for (const p of this.particles) {
      const finalR = R*(1+p.radOff*p.driftMul) + t*8*p.driftMul;
      p.spr.x = this.cx + Math.cos(p.baseAngle+this.tilt) * finalR;
      p.spr.y = this.cy + Math.sin(p.baseAngle+this.tilt) * finalR * this.squashY;
      const sz = 14 * p.size * grow;
      p.spr.width = p.spr.height = sz;
      p.spr.alpha = baseA * p.alphaMul;
    }
    return true;
  }

  destroy() {
    for (const p of this.particles) { p.spr.parent?.removeChild(p.spr); p.spr.destroy(); }
    this.particles.length = 0;
  }
}

const _fly = {
  _container:  null,
  _blobTex:    null,
  _puffTexs:   [],
  _tokenState: new Map(),
  _puffs:      [],
  _puffPool:   [],
  _rings:      [],
  _tickFn:     null,

  init() {
    if (this._container) return;
    const renderer = canvas.app.renderer;
    this._blobTex = _bakeBlobTexture(renderer, 64);
    for (let i = 0; i < 6; i++) this._puffTexs.push(_bakePuffTexture(renderer, 7+i*13, 128));
    this._container = new PIXI.Container();
    this._container.zIndex = _FLY_CFG.zIndex;
    const parent = canvas.primary ?? canvas.stage;
    parent.addChild(this._container);
    if (parent.sortableChildren !== undefined) parent.sortableChildren = true;
    this._tickFn = (ticker) => this._tick(ticker);
    canvas.app.ticker.add(this._tickFn);
  },

  destroy() {
    if (this._tickFn) { canvas.app.ticker.remove(this._tickFn); this._tickFn = null; }
    for (const r of this._rings) r.destroy();
    this._rings.length = 0;
    for (const spr of this._puffs) { spr.parent?.removeChild(spr); spr.destroy(); }
    for (const spr of this._puffPool) spr.destroy();
    this._puffs.length = 0; this._puffPool.length = 0;
    this._tokenState.clear();
    this._container?.destroy({ children: true }); this._container = null;
    this._blobTex?.destroy(true); this._blobTex = null;
    for (const t of this._puffTexs) t.destroy(true);
    this._puffTexs.length = 0;
  },

  _borrowPuff() {
    let spr = this._puffPool.pop();
    const tex = this._puffTexs[Math.floor(Math.random()*this._puffTexs.length)];
    if (!spr) { spr = new PIXI.Sprite(tex); spr.anchor.set(0.5); }
    else spr.texture = tex;
    spr.visible = true;
    this._container.addChild(spr);
    return spr;
  },

  _releasePuff(spr) {
    spr.visible = false;
    spr.parent?.removeChild(spr);
    if (this._puffPool.length < 100) this._puffPool.push(spr);
    else spr.destroy();
  },

  _emitWingPair(x, y, dx, dy) {
    if (this._puffs.length + 2 > _FLY_CFG.maxPuffsTotal) return;
    const len = Math.hypot(dx,dy)||1, fx=dx/len, fy=dy/len, px=-fy, py=fx;
    for (const side of [-1,1]) {
      const sx = x - fx*_FLY_CFG.wingBackPx + px*_FLY_CFG.wingOffsetPx*side;
      const sy = y - fy*_FLY_CFG.wingBackPx + py*_FLY_CFG.wingOffsetPx*side;
      const outSpd = _FLY_CFG.puffOutSpeed + Math.random()*0.3;
      const spr = this._borrowPuff();
      spr.x = sx+(Math.random()-0.5)*3; spr.y = sy+(Math.random()-0.5)*3;
      spr.rotation = (Math.random()-0.5)*0.4; spr.alpha = 0;
      spr.__data = { vx:px*side*outSpd+(Math.random()-0.5)*0.1, vy:py*side*outSpd+0.15+Math.random()*0.1,
        age:0, life:_FLY_CFG.puffLifeMs*(0.9+Math.random()*0.3),
        maxR:_FLY_CFG.puffSize*(0.55+Math.random()*0.35), rotV:(Math.random()-0.5)*0.001 };
      this._puffs.push(spr);
    }
  },

  _spawnRing(x, y) {
    if (this._rings.length >= _FLY_CFG.maxRingsTotal) return;
    const r = new _Ring();
    r.reset(x, y, this._blobTex, this._container);
    this._rings.push(r);
  },

  _tick(ticker) {
    if (!this._container) return;
    const dt  = ticker?.deltaMS ?? (canvas.app.ticker.deltaMS ?? 16);
    const now = performance.now();
    const tokens = canvas.tokens?.placeables ?? [];
    const liveIds = new Set();

    for (const token of tokens) {
      const mesh = token.mesh;
      if (!mesh) continue;
      const id = token.id;
      liveIds.add(id);
      const mx = mesh.x, my = mesh.y;
      let st = this._tokenState.get(id);
      if (!st) {
        this._tokenState.set(id, { prevX:mx, prevY:my, smoothSpeed:0, flapPhase:0, wasPeak:false, lastRingTs:0 });
        continue;
      }
      const ddx = mx-st.prevX, ddy = my-st.prevY;
      st.smoothSpeed = _lerp(st.smoothSpeed, Math.hypot(ddx,ddy), _FLY_CFG.smoothFactor);
      st.prevX=mx; st.prevY=my;
      if ((token.document?.elevation??0) <= 0) continue;
      if (st.smoothSpeed > _FLY_CFG.moveThreshold) {
        st.flapPhase += dt / _FLY_CFG.flapMs;
        const peak = Math.sin(st.flapPhase*_TAU) > 0.85;
        if (peak && !st.wasPeak) this._emitWingPair(mx, my, ddx, ddy);
        st.wasPeak = peak;
      } else {
        st.wasPeak = false;
        if (now - st.lastRingTs > _FLY_CFG.ringRateMs) { this._spawnRing(mx,my); st.lastRingTs=now; }
      }
    }

    if (this._tokenState.size > liveIds.size)
      for (const id of [...this._tokenState.keys()]) if (!liveIds.has(id)) this._tokenState.delete(id);

    for (let i = this._rings.length-1; i >= 0; i--)
      if (!this._rings[i].update(dt)) this._rings.splice(i,1);

    const drag = Math.pow(_FLY_CFG.puffDrag, dt/16);
    for (let i = this._puffs.length-1; i >= 0; i--) {
      const spr = this._puffs[i], d = spr.__data;
      d.age += dt;
      if (d.age >= d.life) { this._puffs.splice(i,1); this._releasePuff(spr); continue; }
      const t = d.age/d.life;
      const size  = _lerp(d.maxR*0.5, d.maxR*2.0, _easeOut(Math.min(t*1.6,1)));
      const alpha = t < 0.12 ? _lerp(0,1,t/0.12) : _lerp(1,0,(t-0.12)/0.88);
      spr.x += d.vx*(dt/16); spr.y += d.vy*(dt/16);
      d.vx *= drag; d.vy *= drag;
      spr.rotation += d.rotV*dt;
      spr.width=size*1.15; spr.height=size*0.9;
      spr.alpha = alpha * _FLY_CFG.alphaMax;
    }
  },
};

async function animWalk(token, wpts, totalMs, bsx, bsy) {
  const steps  = wpts.length - 1;
  const stepMs = totalMs / Math.max(steps, 1);
  const tr     = Math.min(token.w ?? 50, token.h ?? 50) / 2;
  let svx = 0, rot = 0;

  const layer = makeParticleLayer();
  for (let i = 0; i < steps; i++) {
    const fx = wpts[i].x,   fy = wpts[i].y;
    const dx = wpts[i+1].x - fx, dy = wpts[i+1].y - fy;
    const len = Math.hypot(dx, dy) || 1;
    spawnWalkDust(layer, fx, fy, dx/len, dy/len, tr);

    await new Promise(res => {
      const t0  = performance.now();
      const vxf = dx / Math.max(stepMs / (1000/60), 1);
      const tick = () => {
        const dt = (canvas.app.ticker.deltaMS || 16.667) / 1000;
        const k  = clamp((performance.now() - t0) / stepMs, 0, 1);
        const ek = eio(k);
        const E  = 1 + 0.12 * Math.sin(Math.PI * k);
        svx += (vxf - svx) * clamp(8 * dt, 0, 1);
        const rTgt = clamp(svx * 0.04, -Math.PI / 10, Math.PI / 10);
        rot += (rTgt - rot) * clamp(4 * dt, 0, 1);
        if (token.mesh) {
          token.mesh.position.set(fx + dx * ek, fy + dy * ek);
          token.mesh.scale.set(bsx * E, bsy * E);
          token.mesh.rotation = rot;
          syncPos(token);
        }
        if (k >= 1) {
          canvas.app.ticker.remove(tick);
          syncPosAndPerception(token);
          playStepSound(i);
          res();
        }
      };
      canvas.app.ticker.add(tick);
    });
  }
  setTimeout(() => layer.destroy(), 1200);
}

function animCont(token, wpts, totalMs, prof, gs, bsx = 1, bsy = 1) {
  const ease = prof.ease ?? (t => t);
  const segs = []; let total = 0;
  for (let i = 0; i < wpts.length - 1; i++) {
    const len = Math.hypot(wpts[i+1].x - wpts[i].x, wpts[i+1].y - wpts[i].y);
    segs.push({ from: wpts[i], to: wpts[i+1], len, s: total });
    total += len;
  }
  if (!total) return Promise.resolve();

  const layer          = prof.effect ? makeParticleLayer() : null;
  const spawnInterval  = prof.effect ? 1 / (prof.effectHz ?? 10) : Infinity;
  const tr             = Math.min(token.w ?? gs, token.h ?? gs) / 2;
  let spawnTimer       = 0;
  let burstDone        = false;

  return new Promise(res => {
    const t0 = performance.now();
    const tick = () => {
      const dt = clamp((canvas.app.ticker.deltaMS || 16.667) / 1000, 0, 0.1);
      const t  = clamp((performance.now() - t0) / totalMs, 0, 1);
      const d  = ease(t) * total;
      let pos  = wpts[wpts.length - 1], dirX = 0, dirY = 0;

      for (const s of segs) {
        if (s.s + s.len >= d - 0.01) {
          const segT = s.len > 0 ? (d - s.s) / s.len : 0;
          pos  = { x: s.from.x + (s.to.x - s.from.x)*segT, y: s.from.y + (s.to.y - s.from.y)*segT };
          const dl = s.len || 1;
          dirX = (s.to.x - s.from.x) / dl; dirY = (s.to.y - s.from.y) / dl;
          break;
        }
      }

      if (layer) {
        // Takeoff burst on first frame
        if (!burstDone && prof.burstEffect) {
          burstDone = true;
          prof.burstEffect(layer, pos.x, pos.y, tr);
        }
        spawnTimer += dt;
        if (spawnTimer >= spawnInterval) {
          spawnTimer -= spawnInterval;
          const underground = prof.effect === spawnDirtChunk && t > 0.2 && t < 0.8;
          prof.effect(layer, pos.x, pos.y, dirX, dirY, tr, underground);
        }
        // Landing burst near end
        if (t > 0.88 && !layer._landingDone && prof.burstEffect) {
          layer._landingDone = true;
          prof.burstEffect(layer, pos.x, pos.y, tr);
        }
      }

      if (token.mesh) {
        token.mesh.position.set(
          pos.x + (prof.ox?.(t, gs) ?? 0),
          pos.y + (prof.oy?.(t, gs) ?? 0),
        );
        if (prof.scale) { const S = prof.scale(t); token.mesh.scale.set(bsx*S, bsy*S); }
        if (prof.alpha !== undefined) token.mesh.alpha = prof.alpha(t);
        syncPos(token);
      }
      if (t >= 1) {
        canvas.app.ticker.remove(tick);
        syncPosAndPerception(token);
        if (layer) setTimeout(() => layer.destroy(), 1500);
        res();
      }
    };
    canvas.app.ticker.add(tick);
  });
}

async function animStep(token, wpts, totalMs, prof) {
  const stepMs = totalMs / Math.max(wpts.length - 1, 1);
  const pause  = prof.pause ?? 65;
  for (let i = 0; i < wpts.length - 1; i++) {
    const from = wpts[i], to = wpts[i+1];
    const mvMs = Math.max(stepMs - pause, 40);
    await new Promise(res => {
      const t0 = performance.now();
      const tick = () => {
        const t = clamp((performance.now() - t0) / mvMs, 0, 1);
        if (token.mesh) {
          token.mesh.position.set(
            from.x + (to.x - from.x) * prof.ease(t),
            from.y + (to.y - from.y) * prof.ease(t),
          );
          syncPos(token);
        }
        if (t >= 1) { canvas.app.ticker.remove(tick); res(); }
      };
      canvas.app.ticker.add(tick);
    });
    if (pause > 0 && i < wpts.length - 2) await new Promise(r => setTimeout(r, pause));
  }
}

async function animTeleport(token, wpts, totalMs, bsx, bsy) {
  const src  = wpts[0], dest = wpts[wpts.length - 1];
  const gs   = canvas.grid.size ?? 100;
  const CLR  = 0x66ccff, CORE = 0xe8f8ff;
  const outMs  = totalMs * 0.28, holdMs = totalMs * 0.18, inMs = totalMs * 0.54;
  const N = 22;
  const parts = Array.from({ length: N }, (_, i) => ({
    angle: (i/N)*Math.PI*2 + i*0.41, speed: 0.7+(i%5)*0.28, size: 2.5+(i%4)*0.9,
  }));
  const fx = new PIXI.Container(), gfx = new PIXI.Graphics(), trail = new PIXI.Graphics();
  canvas.stage.addChild(fx); fx.addChild(trail); fx.addChild(gfx);

  const drawTrail = a => {
    trail.clear(); if (a<=0.01) return;
    trail.lineStyle(18,CLR,0.07*a); trail.moveTo(src.x,src.y); trail.lineTo(dest.x,dest.y);
    trail.lineStyle(8,CLR,0.22*a);  trail.moveTo(src.x,src.y); trail.lineTo(dest.x,dest.y);
    trail.lineStyle(2,CORE,0.90*a); trail.moveTo(src.x,src.y); trail.lineTo(dest.x,dest.y);
  };
  const drawParts = (cx,cy,spread,ta) => {
    for (const p of parts) {
      const px=cx+Math.cos(p.angle)*spread*p.speed, py=cy+Math.sin(p.angle)*spread*p.speed;
      gfx.beginFill(CLR,ta*0.28); gfx.drawCircle(px,py,p.size*2.4); gfx.endFill();
      gfx.beginFill(CORE,ta*0.90); gfx.drawCircle(px,py,p.size*0.65); gfx.endFill();
    }
  };

  await new Promise(res => {
    const t0=performance.now();
    const tick=()=>{
      const k=clamp((performance.now()-t0)/outMs,0,1), eK=k*k;
      gfx.clear(); drawParts(src.x,src.y,eK*gs*0.65,1-eK);
      gfx.lineStyle(2.5,CORE,(1-eK)*0.7); gfx.drawCircle(src.x,src.y,(1-eK*0.5)*gs*0.45); gfx.lineStyle(0);
      drawTrail(k);
      if(token.mesh){token.mesh.alpha=1-eK;token.mesh.scale.set(bsx*(1-k*0.15),bsy*(1-k*0.15));syncPos(token);}
      if(k>=1){canvas.app.ticker.remove(tick);res();}
    };
    canvas.app.ticker.add(tick);
  });

  if(token.mesh){token.mesh.alpha=0;token.mesh.position.set(dest.x,dest.y);syncPos(token);} gfx.clear();

  await new Promise(res => {
    const t0=performance.now();
    const tick=()=>{
      const k=clamp((performance.now()-t0)/holdMs,0,1); gfx.clear(); drawTrail(1);
      const ox=src.x+(dest.x-src.x)*eio4(k), oy=src.y+(dest.y-src.y)*eio4(k);
      gfx.beginFill(CLR,0.35);gfx.drawCircle(ox,oy,13);gfx.endFill();
      gfx.beginFill(CORE,0.95);gfx.drawCircle(ox,oy,5);gfx.endFill();
      if(k>=1){canvas.app.ticker.remove(tick);res();}
    };
    canvas.app.ticker.add(tick);
  });

  await new Promise(res => {
    const t0=performance.now();
    const tick=()=>{
      const k=clamp((performance.now()-t0)/inMs,0,1), eK=1-(1-k)*(1-k);
      gfx.clear(); drawParts(dest.x,dest.y,(1-eK)*gs*0.65,eK);
      gfx.lineStyle(2.5,CORE,(1-k)*0.7); gfx.drawCircle(dest.x,dest.y,eK*gs*0.55); gfx.lineStyle(0);
      drawTrail(1-k);
      if(token.mesh){token.mesh.alpha=eK;const S=1+(1-eK)*0.55;token.mesh.scale.set(bsx*S,bsy*S);syncPos(token);}
      if(k>=1){canvas.app.ticker.remove(tick);res();}
    };
    canvas.app.ticker.add(tick);
  });

  try { fx.destroy({ children: true }); } catch (_) {}
}
