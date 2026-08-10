/**
 * smooth-move.js — Foundry VTT v14
 */

const MODULE_ID = "smooth-move";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "animMs", {
    name: "Animation duration (ms, full path)",
    scope: "client", config: true,
    type: Number, default: 900, range: { min: 0, max: 3000, step: 50 },
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

    // Foundry v14 removed Token#animateMovement/#_animateMovement. Movement is now
    // dispatched through the public Token#animate under the movement animation name
    // (see Token##onUpdateAnimation). Suppress only that animation while our own
    // ticker owns the mesh — other animations (alpha, bars, texture, ring) must
    // still run normally, so we key on the name rather than blocking everything.
    animate(to, options = {}) {
      if ((this._smActive || this._smCommitting)
          && options.name === this.movementAnimationName) {
        return Promise.resolve();
      }
      return super.animate(to, options);
    }

    _onUpdate(data, options, userId) {
      if (this._smCommitting) {
        super._onUpdate(data, options, userId);
        canvas.tokens?.recalculatePlannedMovementPaths?.();
        syncPosAndPerception(this);
        return;
      }

      // Case 2: position update from another client (animate:false = smooth-move commit).
      // Socket message already started animation on this client; if _smActive is true
      // the animation is running and we just let super._onUpdate update the document.
      // If _smActive is false the socket didn't arrive in time — animate a direct line.
      const hasPos = data.x != null || data.y != null;
      if (hasPos && !this._smActive && options?.animate === false) {
        const startX = this.mesh?.position.x;
        const startY = this.mesh?.position.y;

        super._onUpdate(data, options, userId);

        const w = this.w ?? 0, h = this.h ?? 0;
        const endX = (data.x ?? this.document.x) + w/2;
        const endY = (data.y ?? this.document.y) + h/2;
        if (startX == null || (Math.abs(startX - endX) < 2 && Math.abs(startY - endY) < 2)) return;
        const pts = [{ x: startX, y: startY }, { x: endX, y: endY }];
        if (this.mesh) this.mesh.position.set(pts[0].x, pts[0].y);
        animate(this, pts, getMoveMode(this)).catch(() => {});
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
      // v14 calls this for completed drops and releases too, and guards against
      // them before touching waypoints. Honour those cases first, otherwise a
      // drop would get an extra waypoint appended instead of committing.
      // (_smStartPx is left alone here: _onDragLeftDrop owns its lifecycle, and
      // clearing it early would make a pending drop fall through to vanilla.)
      const id = event?.interactionData;
      if (id?.cancelled || id?.dropped || id?.released) {
        return super._onDragLeftCancel(event, ...args);
      }
      if (this._smStartPx) {
        const ctx = id?.contexts?.[this.document.id];
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

      // v14's Token#_onDragLeftDrop marks the interaction as dropped before
      // delegating, and _onDragLeftCancel keys off that flag to tear the drag
      // down instead of treating the release as a waypoint click. We take over
      // the drop and never reached core's assignment, so cancel fell through to
      // _addDragWaypoint and left a stray ruler dot on the map after every drag.
      if (event?.interactionData) event.interactionData.dropped = true;

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
        const tw = t.w ?? 0, th = t.h ?? 0;
        const meshWPs = tWPs?.length
          ? tWPs.map(wp => ({ x: wp.x + tw/2, y: wp.y + th/2 }))
          : [{ x: (upd.x ?? t.document.x) + tw/2, y: (upd.y ?? t.document.y) + th/2 }];
        const first   = meshWPs[0];
        const skip    = Math.abs(first.x - tStart.x) < 2 && Math.abs(first.y - tStart.y) < 2;
        const raw     = skip ? [tStart, ...meshWPs.slice(1)] : [tStart, ...meshWPs];
        const tMode   = getMoveMode(t);
        // Decide this from the resolved profile, not the action name: animate()
        // dispatches on prof.kind, so keying on the name meant "jump" (and any
        // action falling back to the walk profile) went to animWalk WITHOUT
        // being split into cells — one giant bouncing stride per waypoint
        // instead of a step per square, and a wrong _smRunFt for the dust FX.
        const tProf   = profileFor(tMode);
        const stepped = tProf?.kind === "walk" || tProf?.kind === "step";
        const pts     = stepped ? expandToGridCells(raw, t) : raw;
        // expandToGridCells snaps to cell centres, which would move an unsnapped
        // drop (shift-drag) up to half a cell off target — and the commit takes
        // its destination from this last point, so the token would settle there
        // too. Pin it back to the real final waypoint.
        if (pts.length > 1) pts[pts.length - 1] = meshWPs[meshWPs.length - 1];
        jobs.push({ token: t, pts, mode: tMode, upd });
      }

      if (!jobs.length) { delete this._smStartPx; return super._onDragLeftDrop(event, ...args); }

      const capturedUpdates = tokenUpdates;
      this.layer._smGroupDrop = true;

      (async () => {
        this.layer?.clearPreviewContainer?.();

        // Broadcast path to all other clients so they animate simultaneously
        for (const j of jobs) {
          game.socket.emit(`module.${MODULE_ID}`, {
            type: "smMove",
            userId: game.user?.id,
            sceneId: canvas.scene?.id,
            tokenId: j.token.id,
            pts: j.pts,
            mode: j.mode,
          });
        }

        for (const j of jobs) if (j.token.mesh) j.token.mesh.position.set(j.pts[0].x, j.pts[0].y);

        await Promise.all(jobs.map(j => animate(j.token, j.pts, j.mode)));

        const finalUpdates = capturedUpdates.map(upd => {
          const tid = upd._id ?? upd.id;
          const job = jobs.find(j => j.token.id === tid);
          if (!job) return upd;
          const last = job.pts[job.pts.length - 1];
          const tw = job.token.w ?? 0, th = job.token.h ?? 0;
          return { ...upd, x: last.x - tw/2, y: last.y - th/2 };
        });
        for (const j of jobs) {
          j.token._smCommitting = true;
          setTimeout(() => { delete j.token._smCommitting; }, 500);
        }

        // Commit as a single "displace" waypoint straight to the destination.
        // displace is unmeasured (measure:false, costMultiplier:0), so travelled
        // distance is NOT recorded — that is a deliberate trade, not an oversight.
        //
        // v3.2.0 committed the real waypoints under their real action instead,
        // which does record distance. Reading the v14 source it looked safe: walls
        // bypassed by constrainOptions.ignoreWalls, camera by pan:false, size by
        // the waypoints carrying the token's own dimensions. In play it was not —
        // moves began from the wrong point and the camera misbehaved, the same
        // family of bugs displace was adopted to avoid. Reverted in v3.8.0.
        //
        // If this is ever revisited, start with `method`: "dragging" pulls the
        // commit into core's drag and planned-movement machinery (showRuler,
        // _plannedMovement, recalculatePlannedMovementPath), which a commit we
        // have already animated ourselves has no business re-entering.
        const movement = {};
        for (const j of jobs) {
          const tw = j.token.w ?? 0, th = j.token.h ?? 0;
          const last = j.pts[j.pts.length - 1];
          movement[j.token.id] = {
            waypoints: [{ x: last.x - tw/2, y: last.y - th/2,
              elevation: j.token.document.elevation ?? 0,
              width: j.token.document.width ?? 1,
              height: j.token.document.height ?? 1,
              shape: j.token.document.shape,
              action: "displace", snapped: false, explicit: true, checkpoint: true }],
            method: "api",
            constrainOptions: { ignoreWalls: true, ignoreCost: true },
            autoRotate: false,
            showRuler: false,
          };
        }
        await canvas.scene?.updateEmbeddedDocuments("Token", finalUpdates,
          { animate: false, pan: false, movement });

        for (const j of jobs) syncPosAndPerception(j.token);
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

  game.socket.on(`module.${MODULE_ID}`, msg => {
    if (msg.type !== "smMove") return;
    if (msg.userId === game.user?.id) return;   // ignore own messages (Foundry echoes back)
    if (msg.sceneId !== canvas.scene?.id) return;
    // Note the shape: `msg.pts?.length < 2` would NOT catch a missing pts,
    // because `undefined < 2` is false — and then pts[0] below would throw.
    if (!(msg.pts?.length >= 2)) return;
    const token = canvas.tokens?.get(msg.tokenId);
    if (!token?.mesh || token._smActive) return;
    // Hidden tokens are never rendered to non-GM clients — skip the pointless
    // off-screen animation rather than spinning a ticker on an invisible mesh.
    if (token.document?.hidden && !game.user?.isGM) return;
    token.mesh.position.set(msg.pts[0].x, msg.pts[0].y);
    animate(token, msg.pts, msg.mode).catch(() => {});
  });

  Hooks.on("canvasReady", () => {
    // A reload mid-animation leaves our state flags set on the fresh placeables
    // (finally never ran). Clear them so nothing starts the session stuck. Do
    // NOT call _refreshSize here: at canvasReady token textures may still be the
    // placeholder, and resizing against it produces a giant scale. Foundry draws
    // each token at the correct size itself once its texture finishes loading.
    for (const t of canvas.tokens?.placeables ?? []) {
      delete t._smStartPx;
      delete t._smActive;
      delete t._smCommitting;
      delete t._smBaseScale;
      delete t._smRunFt;
      delete t._smTick;
      if (t.mesh) t.mesh.alpha = 1;
    }
    TokenEffects.instance.destroy();
    TokenEffects.instance.init();
    // Kept independent of TokenEffects: that init() swallows its own errors, and
    // a safety net must not be disabled by an unrelated particle failure.
    startSizeWatchdog();
  });
  Hooks.on("canvasTearDown", () => { TokenEffects.instance.destroy(); stopSizeWatchdog(); });
  Hooks.on("deleteToken",    (doc) => TokenEffects.instance._dropToken(doc.id));
  if (canvas?.ready) { TokenEffects.instance.init(); startSizeWatchdog(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const eio   = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
const eio4  = t => t < 0.5 ? 8*t*t*t*t : 1 - 8*(1-t)*(1-t)*(1-t)*(1-t);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const animMs = () => game.settings.get(MODULE_ID, "animMs") ?? 900;

// True only when the token's texture is actually loaded. Foundry's _refreshSize
// computes mesh scale as baseWidth / texture.width (primary-sprite-mesh resize);
// if the texture is still the ~1px placeholder (e.g. right after a page reload),
// that division yields a giant scale. Never call _refreshSize until this passes.
function meshTextureReady(token) {
  const tex = token?.mesh?.texture;
  return !!(token?.mesh && tex && (tex.width ?? 0) > 1 && (tex.height ?? 0) > 1);
}

// The scale Foundry itself would give the mesh, derived purely from the document
// and the loaded texture — an exact replica of Token#_refreshMeshSizeAndScale +
// PrimarySpriteMesh#resize. Used as a hard backstop: the animation base scale is
// clamped to this, so no code path can make a token grow past its true size,
// no matter what left mesh.scale inflated. Returns null until the texture loads.
function documentScale(token) {
  const tex = token?.mesh?.texture;
  if (!tex || (tex.width ?? 0) <= 1 || (tex.height ?? 0) <= 1) return null;
  const doc = token.document;
  const size = doc?.getSize?.();
  if (!size) return null;
  const texDoc = doc.texture ?? {};
  let scaleX = texDoc.scaleX ?? 1, scaleY = texDoc.scaleY ?? 1;
  if (token.hasDynamicRing && CONFIG.Token?.ring?.isGridFitMode) {
    const adj = token.ring?.subjectScaleAdjustment ?? 1;
    scaleX *= adj; scaleY *= adj;
  }
  const tw = tex.width, th = tex.height;
  const fit = texDoc.fit ?? "fill";
  let sx, sy;
  switch (fit) {
    case "cover":   sx = sy = Math.max(size.width / tw, size.height / th); break;
    case "contain": sx = sy = Math.min(size.width / tw, size.height / th); break;
    case "width":   sx = sy = size.width / tw; break;
    case "height":  sx = sy = size.height / th; break;
    default:        sx = size.width / tw; sy = size.height / th; break; // "fill"
  }
  return { x: Math.abs(sx * scaleX), y: Math.abs(sy * scaleY) };
}

// ── Size watchdog ────────────────────────────────────────────────────────────
// documentScale() already clamps OUR animation base, so this module cannot
// inflate a token. Nothing stops a third party from doing it though, and an
// inflated mesh.scale persists until something re-derives it from the document
// (which is why the old "giant tokens" needed a reload to clear).
//
// The threshold is the whole point. Plenty of modules legitimately animate
// token scale — pulsing auras, hit flashes, target highlights — and those move
// it by a few percent. Forcing every token to its exact document scale would
// break all of them. Catastrophic inflation was 10-100x, so a 3x floor
// separates the two cleanly: no real effect reaches it, no giant escapes it.
const SIZE_WATCHDOG_FACTOR = 3;
const SIZE_WATCHDOG_MS = 1000;

function sizeWatchdogSweep() {
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token._smActive || token._smCommitting) continue;  // our animation owns it
    if (token.isPreview) continue;                         // drag ghost
    if (token.animationContexts?.size) continue;           // core is animating it
    const mesh = token.mesh;
    if (!mesh) continue;
    const ds = documentScale(token);                       // null until texture loads
    if (!ds) continue;
    const fx = Math.abs(mesh.scale.x) / ds.x;
    const fy = Math.abs(mesh.scale.y) / ds.y;
    if (fx <= SIZE_WATCHDOG_FACTOR && fy <= SIZE_WATCHDOG_FACTOR) continue;
    console.warn(`[smooth-move] "${token.document?.name ?? token.id}" was rendering at `
      + `${Math.max(fx, fy).toFixed(1)}x its correct size — resetting from the document. `
      + `smooth-move clamps its own animation, so something else scaled this token.`);
    try { token._refreshSize?.(); } catch (_) {}
  }
}

function startSizeWatchdog() {
  if (sizeWatchdogSweep._tick) return;
  let acc = 0;
  const tick = () => {
    acc += canvas.app.ticker.deltaMS || 16.667;
    if (acc < SIZE_WATCHDOG_MS) return;
    acc = 0;
    sizeWatchdogSweep();
  };
  sizeWatchdogSweep._tick = tick;
  canvas.app.ticker.add(tick);
}

function stopSizeWatchdog() {
  const tick = sizeWatchdogSweep._tick;
  if (!tick) return;
  canvas.app?.ticker?.remove(tick);
  delete sizeWatchdogSweep._tick;
}

function syncPos(token) {
  const mesh = token.mesh;
  if (!mesh) return;
  const x = mesh.position.x - (token.w ?? 0) / 2;
  const y = mesh.position.y - (token.h ?? 0) / 2;
  Object.assign(token, { x, y });

  // Core's own animation writes each interpolated frame straight into the
  // document (Token##animateFrame: mergeObject(this.document, #animationData)).
  // That matters because everything positional reads the DOCUMENT, not the mesh:
  // Token#center, initializeSources() via document.getCenterPoint(), camera
  // follow, and third-party modules. Moving only the mesh left the document
  // parked at the origin for the whole animation, so vision, light and any
  // camera stayed at the start point and snapped across only at commit — the
  // token and the viewer's perspective visibly desynced.
  //
  // Only the prepared document is touched; _source is untouched, so nothing is
  // persisted or broadcast, and the commit still diffs against the true origin.
  const doc = token.document;
  if (doc) { doc.x = x; doc.y = y; }
}

function syncPosAndPerception(token) {
  syncPos(token);
  token.initializeSources?.();
  canvas.perception?.update({ refreshVision: true });
}

// Recompute whether the mesh should be visible to THIS client at the token's
// current animated position. Mirrors Foundry's Token#isVisible, which core
// normally re-evaluates every frame via the refreshVisibility render flag. We
// bypass that pipeline by moving the mesh directly, so without this a token
// dragged behind a wall / out of sight by the GM would keep showing its motion
// to players until the final commit. GM and owned/controlled tokens are skipped.
//
// v14 changed the test: isVisible now uses document.getVisibilityTestPoints()
// with tolerance 0 instead of a single center point with a computed tolerance.
// Those points are "dense" (5 on a square grid, up to 9 gridless), so the test
// costs several times what it did in v13 — hence the throttle in the caller.
function updateMeshVisibility(token) {
  if (game.user?.isGM) return;
  const mesh = token.mesh;
  if (!mesh) return;
  if (token.controlled || token.isPreview) return;
  if (token.document?.hidden) { mesh.visible = false; return; }
  if (!canvas.visibility?.tokenVision) return;
  if (token.vision?.active) return;
  const doc = token.document;
  const x = mesh.position.x - (token.w ?? 0) / 2;
  const y = mesh.position.y - (token.h ?? 0) / 2;
  let visible;
  if (typeof doc.getVisibilityTestPoints === "function") {
    visible = canvas.visibility.testVisibility(
      doc.getVisibilityTestPoints({ x, y }), { tolerance: 0, object: token });
  } else {
    const { width, height } = doc.getSize();
    visible = canvas.visibility.testVisibility(
      { x: mesh.position.x, y: mesh.position.y },
      { tolerance: Math.min(width, height) / 4, object: token });
  }
  mesh.visible = visible && token.renderable;
}

// How many frames between fog-of-war visibility re-tests during an animation.
// v14's visibility test evaluates a dense point set (5 on a square grid, up to
// 9 gridless) against every active vision source, so running it on all 60 frames
// is needlessly expensive. Every 4th frame is ~15Hz — visually indistinguishable
// for a token fading in/out at a wall, at a quarter of the cost.
const VIS_TEST_EVERY = 4;

// How many frames between light/vision source updates during an animation.
// initializeSources() rebuilds the source's line-of-sight polygon whenever the
// position actually changed (BaseEffectSource#initialize -> _couldShapesChange
// -> _createShapes), which is the single most expensive thing we do per frame.
// Core runs it every frame; at 3 we run it at ~20Hz for a third of the cost.
// The token mesh still moves at full framerate — only the lit area steps, and
// a soft light gradient hides that far better than a hard edge would. Raise
// for more savings, lower (2, or 1 to match core exactly) for tighter light.
const SOURCE_EVERY = 3;

// Per-frame upkeep during our custom animation, mirroring what core Foundry
// does in Token#_onAnimationUpdate (which we bypass by moving the mesh directly).
// Both jobs are throttled, and both always run on the first frame so nothing is
// visibly stale at the start. The exact final state is settled either way by
// syncPosAndPerception() once the animation releases the mesh.
function refreshDuringAnimation(token) {
  const n = token._smTick = (token._smTick ?? 0) + 1;
  const first = n === 1;

  // Sources are only touched for tokens that actually have sight or emit light,
  // and only when Vision Animation is enabled — exactly Foundry's own guard, so
  // we never pay this for tokens that need neither, nor for a user who opted out.
  if ((first || (n % SOURCE_EVERY === 0))
      && game.settings.get("core", "visionAnimation")
      && (token.hasSight || token._isLightSource?.())) {
    token.initializeSources?.();
  }

  if (first || (n % VIS_TEST_EVERY === 0)) updateMeshVisibility(token);
}

function getMoveMode(token) {
  return (
    // v14 exposes the in-progress drag action on the layer; v13 had it on the
    // token's dragActionHandler. Fall back to the document's action either way.
    token.layer?._dragMovementAction
    ?? token.dragActionHandler?.currentAction
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
// Particle system (for swim / teleport / climb effects)
// ═══════════════════════════════════════════════════════════════════════════


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
      if (p.shape === 'trail' && p.ang0 !== undefined) {
        const lt  = clamp(p.age / p.life, 0, 1);
        const ea  = lt < 0.5 ? 2*lt*lt : -1+(4-2*lt)*lt;
        const ang = p.ang0 + (p.ang1 - p.ang0) * ea
                  + Math.sin(lt * (p.oscF ?? 5) + (p.oscPh ?? 0)) * (p.oscA ?? 0.35);
        const spd = (p.spd ?? 80) * (1 - lt * 0.5);
        p.vx = Math.cos(ang) * spd;
        p.vy = Math.sin(ang) * spd;
      }
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      const df = Math.pow(p.drag, dt * 60);
      p.vx *= df; p.vy *= df;
      if (p.rotV) p.rot = (p.rot ?? 0) + p.rotV;
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
        gfx.lineStyle(0.7, p.color + 0x303010, a * 0.4);
        gfx.drawPolygon(pts);
        gfx.lineStyle(0);
      } else if (shape === 'windstreak' && p.p0) {
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

function spawnSwimBubble(layer, x, y, dirX, dirY, tr) {
  if (Math.random() > 0.55) return;
  const r    = tr ?? 30;
  const bAng = Math.atan2(-dirY, -dirX);
  const n    = 1 + (Math.random() > 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const ang  = bAng + (Math.random() - 0.5) * 2.0;
    const spd  = (8 + Math.random() * 18) / 60;
    const sz   = 3 + Math.random() * 5;
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
  burrow: { kind: "cont",   mult: 2.0, ease: eio },
  jump:   { kind: "walk",   mult: 1.0 },
  teleport: { kind: "teleport", mult: 0.8 },
  blink:    { kind: "teleport", mult: 0.8 },
  tp:       { kind: "teleport", mult: 0.8 },
};

// Pick the animation profile for a movement action. Actions we don't map
// explicitly still have meaning in core's CONFIG.Token.movement.actions, so
// derive their behaviour from there rather than always walking:
//   - speedMultiplier Infinity  => instant (core's "displace": paste, undo, and
//     the waypoint our own commit uses). Animating it would be plain wrong.
//   - teleport: true            => our teleport profile.
// Anything else (core "jump", or actions added by a system/module) walks.
// Returning null means "do not animate at all".
function profileFor(mode) {
  // Our explicit mapping wins. This matters for "blink", the selectable
  // teleport action: it carries speedMultiplier: Infinity exactly like the
  // internal "displace", so keying on that field alone silently dropped its
  // animation entirely instead of playing the teleport effect.
  const p = PROFILES[mode];
  if (p) return p;
  const cfg = CONFIG.Token?.movement?.actions?.[mode];
  if (!cfg) return PROFILES.walk;
  // measure:false marks repositioning rather than in-world movement — core's
  // "displace" (paste, undo, and the commit we send when tracking is off).
  // Those must not animate. Everything else does, as a teleport or a walk.
  if (cfg.measure === false) return null;
  return cfg.teleport ? PROFILES.teleport : PROFILES.walk;
}

async function animate(token, waypoints, mode) {
  if (!waypoints || waypoints.length < 2) return;
  const totalMs = animMs();
  if (totalMs <= 0) return;

  const prof = profileFor(mode);
  if (!prof) return;
  const dur  = totalMs * prof.mult;
  const gs   = canvas.grid.size ?? 100;
  // Capture the TRUE base scale, never the live mesh scale mid-bounce. The walk
  // bounce and fly/teleport profiles multiply this base every frame, so reading
  // an already-inflated mesh.scale as the "base" would freeze that inflation in
  // place (finally restores it, every move re-multiplies). The live mesh.scale
  // is unreliable: a prior animation may have been interrupted before finally
  // ran (e.g. the page was reloaded mid-move), leaving it bouncy. So when no
  // animation owns the mesh, first ask Foundry to reset the mesh size from the
  // document (the source of truth) — this self-heals any leftover inflation —
  // then capture. While an animation is already running, reuse its stored base.
  if (!(token._smActive && token._smBaseScale)) {
    if (meshTextureReady(token)) { try { token._refreshSize?.(); } catch (_) {} }
    let cx = token.mesh?.scale?.x ?? 1;
    let cy = token.mesh?.scale?.y ?? 1;
    // Hard backstop: never accept a base scale larger than the document-derived
    // scale (plus a bounce margin). Even if some unforeseen path left mesh.scale
    // inflated, the captured base is pinned to the true size — so a token can
    // physically never grow past ~1.5x its correct size, let alone become giant.
    const ds = documentScale(token);
    if (ds) {
      const LIM = 1.5;
      if (Math.abs(cx) > ds.x * LIM) cx = Math.sign(cx || 1) * ds.x;
      if (Math.abs(cy) > ds.y * LIM) cy = Math.sign(cy || 1) * ds.y;
    }
    token._smBaseScale = { x: cx, y: cy };
  }
  const bsx  = token._smBaseScale.x;
  const bsy  = token._smBaseScale.y;
  const tr   = Math.min(token.w ?? 50, token.h ?? 50) / 2;

  const baseRot = token.mesh?.rotation ?? 0;
  token._smActive = true;
  try {
    if (prof.kind === "walk") {
      const steps   = waypoints.length - 1;
      const totalFt = steps * (canvas.grid.distance ?? 5);
      token._smRunFt = totalFt;
      await animWalk(token, waypoints, totalFt > 30 ? 1300 : 1000, bsx, bsy, baseRot);
    }
    else if (prof.kind === "step")     await animStep(token, waypoints, dur, prof);
    else if (prof.kind === "teleport") await animTeleport(token, waypoints, dur, bsx, bsy);
    else                               await animCont(token, waypoints, dur, prof, gs, bsx, bsy);
  } finally {
    delete token._smActive;
    delete token._smBaseScale;
    delete token._smRunFt;
    delete token._smTick;
    if (token.mesh) { token.mesh.alpha = 1; token.mesh.rotation = baseRot; token.mesh.scale.set(bsx, bsy); }
    // Re-derive the final size from the document so any drift can't persist —
    // but only once the texture is loaded, or resize would compute a giant scale.
    if (meshTextureReady(token)) { try { token._refreshSize?.(); } catch (_) {} }
    syncPosAndPerception(token);
  }
}

// ─── Token Effects (flight / run / burrow) ───────────────────────────────────
const TAU     = Math.PI * 2;
const lerp    = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - t, 2.5);

const CFG = {
  BRAKE_MIN_FEET: 30,
  LAND_MIN_FEET:  30,
  RUN_MIN_FEET:   30,

  flight: {
    tornadoSpin:      0.6,        // рад/сек (75% повільніше від попереднього 2.5)
    tornadoPhaseStep: 0.42,       // рад на кожну нову частинку → безперервна спіраль
    tornadoInnerR:    12,
    tornadoOuterR:    52,
    tornadoEmitRate:  8,
    tornadoLifeMs:    2400,
    tornadoSize1:     42,
    tornadoSize2:     16,
    tornadoAlpha:     0.20,
    tornadoTint:      0xb8d8f0,

    shockMaxR:        90,
    shockParticles:   80,
    shockLifeMs:      990,
    shockPSize:       15,
    shockSizeGrow:    2.5,
    shockAlpha:       0.09,

    flapMs:           340,
    puffLifeMs:       1400,
    wingPSize:        65,
    wingGrow:         4.5,
    wingAlpha:        0.18,
    wingOffsetPx:     22,
    wingBackPx:       10,
    puffOutSpeed:     1.8,
    puffDrag:         0.97,

    brakeFlaps:       3,
    brakeIntervalMs:  130,
  },

  run: {
    dustRate:    200,
    dustLife:    900,
    dustSize:    30,
    dustGrow:    1.0,
    dustAlpha:   0.38,

    pebRate:     80,
    pebLife:     800,
    pebCount:    4,
    pebSize:     6,
    pebSpeed:    22,
    pebAlpha:    0.95,
  },

  burrow: {
    rate:        80,
    count:       6,
    clodSize:    13,
    speed:       1,
    restLife:    2500,
    tokenAlpha:  0.35,
  },

  moveThreshold: 0.5,
  smoothFactor:  0.2,

  maxParticlesGlobal: 3000,
  zIndex:             450,
};

// ── Texture baking via Canvas 2D (bypasses PIXI.Graphics render issues in Foundry v13) ──

function _mkRand(seed) {
  let s = seed | 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// PIXI v8 uses .circle()/.fill(); v7 uses .drawCircle()/.beginFill()
const _PIXI8 = !!PIXI.Graphics?.prototype?.circle;

function _gCirc(g, x, y, r, col, a) {
  if (_PIXI8) { g.circle(x, y, r);              g.fill({ color: col, alpha: a }); }
  else        { g.beginFill(col, a); g.drawCircle(x, y, r); g.endFill(); }
}
function _gEll(g, x, y, rx, ry, col, a) {
  if (_PIXI8) { g.ellipse(x, y, rx, ry);           g.fill({ color: col, alpha: a }); }
  else        { g.beginFill(col, a); g.drawEllipse(x, y, rx, ry); g.endFill(); }
}
function _gQuadPoly(g, pts, fillCol, fillA, strokeCol, strokeW) {
  if (_PIXI8) {
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      g.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    }
    g.closePath();
    g.fill({ color: fillCol, alpha: fillA });
    if (strokeW > 0) g.stroke({ color: strokeCol, width: strokeW, alpha: 1 });
  } else {
    if (strokeW > 0) g.lineStyle(strokeW, strokeCol, 1);
    g.beginFill(fillCol, fillA);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      g.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    }
    g.closePath();
    g.endFill();
    if (strokeW > 0) g.lineStyle(0);
  }
}

function _softBlob(g, bx, by, br, peakAlpha, col, layers) {
  const a = 1 - Math.pow(1 - Math.min(peakAlpha, 0.999), 1 / layers);
  for (let j = layers; j >= 1; j--) {
    _gCirc(g, bx, by, br * j / layers, col, a);
  }
}

function _hexRGB(hex) {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function _c2dSoftBlob(ctx, bx, by, br, peakAlpha, r, g, b, layers) {
  const a = 1 - Math.pow(1 - Math.min(peakAlpha, 0.999), 1 / layers);
  const as = a.toFixed(4);
  for (let j = layers; j >= 1; j--) {
    ctx.beginPath();
    ctx.arc(bx, by, br * j / layers, 0, TAU);
    ctx.fillStyle = `rgba(${r},${g},${b},${as})`;
    ctx.fill();
  }
}

function _c2dQuadPoly(ctx, pts, fillCSS, strokeCSS, lineW) {
  ctx.beginPath();
  const mx = (pts[pts.length-1].x + pts[0].x) / 2;
  const my = (pts[pts.length-1].y + pts[0].y) / 2;
  ctx.moveTo(mx, my);
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i+1) % pts.length];
    ctx.quadraticCurveTo(p0.x, p0.y, (p0.x+p1.x)/2, (p0.y+p1.y)/2);
  }
  ctx.closePath();
  ctx.fillStyle = fillCSS;
  ctx.fill();
  if (lineW > 0) { ctx.lineWidth = lineW; ctx.strokeStyle = strokeCSS; ctx.stroke(); }
}

function bakeBlobTexture(size = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  _c2dSoftBlob(ctx, size / 2, size / 2, size / 2, 0.90, 255, 255, 255, 20);
  return PIXI.Texture.from(cv);
}

function bakePuffTexture(seed, size = 128) {
  const rand = _mkRand(seed);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const c = size / 2, R = size * 0.38;
  const N = 10 + Math.floor(rand() * 5);
  for (let i = 0; i < N; i++) {
    const ang = rand() * TAU, d = rand() * R * 0.7;
    const bx = c + Math.cos(ang) * d, by = c + Math.sin(ang) * d * 0.85;
    const br = R * (0.35 + rand() * 0.3), ba = (0.4 + rand() * 0.4) * 0.5;
    _c2dSoftBlob(ctx, bx, by, br, ba, 255, 255, 255, 20);
  }
  return PIXI.Texture.from(cv);
}

function bakeDustTexture(seed, size = 96) {
  const rand = _mkRand(seed);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const c = size / 2, R = size * 0.40;
  const PALETTE = [0xB89060, 0xA07848, 0xC8A870, 0x9A6E3C, 0xD0B880, 0xAA8850, 0xBE9E68];
  const N = 8 + Math.floor(rand() * 4);
  for (let i = 0; i < N; i++) {
    const ang = rand() * TAU, d = rand() * R * 0.7;
    const bx = c + Math.cos(ang) * d, by = c + Math.sin(ang) * d;
    const br = R * (0.35 + rand() * 0.3), ba = (0.35 + rand() * 0.35) * 0.7;
    const [r,g,b] = _hexRGB(PALETTE[Math.floor(rand() * PALETTE.length)]);
    _c2dSoftBlob(ctx, bx, by, br, ba, r, g, b, 20);
  }
  return PIXI.Texture.from(cv);
}

function bakePebbleTexture(seed, size = 16) {
  const rand = _mkRand(seed);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const c = size / 2, nPts = 6, baseR = c * 0.55;
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const a = (i / nPts) * TAU, r = baseR * (0.7 + rand() * 0.5);
    pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });
  }
  const variant = Math.floor(rand() * 3);
  const fills   = ['#7a5a3c', '#6e6258', '#5a4838'];
  const strokes = ['#3a2818', '#2e2820', '#2a1f10'];

  ctx.beginPath();
  ctx.ellipse(c + 0.8, c + 1.2, c * 0.55, c * 0.40, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  _c2dQuadPoly(ctx, pts, fills[variant], strokes[variant], 0.8);

  ctx.beginPath();
  ctx.ellipse(c - 1.5, c - 1.5, c * 0.2, c * 0.13, 0, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();

  return PIXI.Texture.from(cv);
}

function bakeClodTexture(seed, size = 24) {
  const rand = _mkRand(seed);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const c = size / 2, nPts = 7 + Math.floor(rand() * 3), baseR = c * 0.65;
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const a = (i / nPts) * TAU, r = baseR * (0.65 + rand() * 0.5);
    pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });
  }
  const variant = Math.floor(rand() * 4);
  let fillCSS, strokeCSS, hiRGB;
  if (variant === 0)      { fillCSS = '#5a3a1a'; strokeCSS = '#2a180a'; hiRGB = [138,90,48]; }
  else if (variant === 1) { fillCSS = '#6e4825'; strokeCSS = '#2e1c0a'; hiRGB = [154,106,58]; }
  else if (variant === 2) { fillCSS = '#4a3018'; strokeCSS = '#1a0e05'; hiRGB = [122,79,40]; }
  else                    { fillCSS = '#785030'; strokeCSS = '#3a2010'; hiRGB = [168,122,74]; }

  ctx.beginPath();
  ctx.ellipse(c + 1.2, c + 1.6, c * 0.65, c * 0.45, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  _c2dQuadPoly(ctx, pts, fillCSS, strokeCSS, 1.2);

  ctx.beginPath();
  ctx.ellipse(c - baseR*0.25, c - baseR*0.3, baseR*0.35, baseR*0.22, 0, 0, TAU);
  ctx.fillStyle = `rgba(${hiRGB[0]},${hiRGB[1]},${hiRGB[2]},0.45)`;
  ctx.fill();

  for (let i = 0; i < 3; i++) {
    const a = rand() * TAU, d = rand() * baseR * 0.5;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a)*d, c + Math.sin(a)*d, 0.8 + rand() * 0.8, 0, TAU);
    ctx.fillStyle = strokeCSS;
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  return PIXI.Texture.from(cv);
}

function _mkSprite(tex) {
  return new PIXI.Sprite(tex);
}

const Scale = {
  shockwave:  s => Math.pow(s, 0.8),
  tornado:    s => 0.7 + (s - 1) * 0.5,
  puff:       s => 0.85 + (s - 1) * 0.35,
  wingOffset: s => 1 + (s - 1) * 0.7,
};

class ParticlePool {
  constructor(container, defaultTexture, capacity = 500) {
    this.container = container;
    this.defaultTexture = defaultTexture;
    this.capacity = capacity;
    this.idle = [];
    this.active = [];
  }

  borrow(texture) {
    let spr = this.idle.pop();
    if (!spr) {
      spr = _mkSprite(texture || this.defaultTexture);
      spr.anchor.set(0.5);
      this.container.addChild(spr);
    } else {
      if (texture) spr.texture = texture;
      spr.visible = true;
    }
    return spr;
  }

  release(spr) {
    spr.visible = false;
    if (this.idle.length < this.capacity) this.idle.push(spr);
    else { spr.parent?.removeChild(spr); spr.destroy(); }
  }

  destroy() {
    for (const { spr } of this.active) spr.destroy();
    for (const spr of this.idle) spr.destroy();
    this.active.length = 0;
    this.idle.length = 0;
  }
}

class FlightSystem {
  constructor(container, blobTex, puffTexs) {
    this.container = container;
    this.blobTex = blobTex;
    this.puffTexs = puffTexs;
    this.tornadoParticles = [];
    this.shockParticles   = [];
    this.shockwaves       = [];
    this.puffs            = [];
    this.brakeQueue       = [];
  }

  emitTornado(tokenId, cx, cy, streamPhase, scale) {
    const spr = _mkSprite(this.blobTex);
    spr.anchor.set(0.5);
    spr.alpha     = 0;
    spr.tint      = CFG.flight.tornadoTint;
    this.container.addChild(spr);

    this.tornadoParticles.push({
      tokenId, spr,
      cx, cy,
      angle: streamPhase + (Math.random() - 0.5) * 0.3,
      age: 0,
      life: CFG.flight.tornadoLifeMs * (0.85 + Math.random() * 0.3),
      sizeMul: (0.7 + Math.random() * 0.5) * scale,
      alphaMul: 0.6 + Math.random() * 0.4,
      scale,
    });
  }

  clearTornadoFor(tokenId) {
    for (let i = this.tornadoParticles.length - 1; i >= 0; i--) {
      if (this.tornadoParticles[i].tokenId === tokenId) {
        const p = this.tornadoParticles[i];
        p.spr.parent?.removeChild(p.spr);
        p.spr.destroy();
        this.tornadoParticles.splice(i, 1);
      }
    }
  }

  spawnShockwave(cx, cy, scale, tokenR = 0) {
    const N = Math.round(CFG.flight.shockParticles * Math.min(scale, 2.5));
    const particles = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + (Math.random() - 0.5) * 0.15;
      if (Math.random() < 0.2) continue;
      const spr = _mkSprite(this.blobTex);
      spr.anchor.set(0.5);
      spr.tint      = 0xc8e0f8;
      this.container.addChild(spr);
      particles.push({
        spr,
        baseAngle: a,
        radOff:   (Math.random() - 0.5) * 0.25,
        driftMul: 0.85 + Math.random() * 0.3,
        size:     0.85 + Math.random() * 0.7,
        alphaMul: 0.6 + Math.random() * 0.4,
      });
    }
    this.shockwaves.push({
      cx, cy,
      age: 0,
      life: CFG.flight.shockLifeMs * Math.pow(scale, 0.3),
      minR: tokenR,
      maxR: CFG.flight.shockMaxR * scale,
      scale,
      particles,
    });
  }

  emitWingPair(x, y, dx, dy, sizeScale) {
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len;
    const perpX = -fy, perpY = fx;
    const offsetMul = Scale.wingOffset(sizeScale);
    const puffMul = Scale.puff(sizeScale);

    for (const side of [-1, 1]) {
      const sx = x - fx * CFG.flight.wingBackPx * offsetMul + perpX * CFG.flight.wingOffsetPx * offsetMul * side;
      const sy = y - fy * CFG.flight.wingBackPx * offsetMul + perpY * CFG.flight.wingOffsetPx * offsetMul * side;
      const outSpeed = CFG.flight.puffOutSpeed + Math.random() * 0.6;
      const vx = perpX * side * outSpeed - fx * 1.2 + (Math.random() - 0.5) * 0.3;
      const vy = perpY * side * outSpeed - fy * 1.2 + (Math.random() - 0.5) * 0.3;

      const tex = this.puffTexs[Math.floor(Math.random() * this.puffTexs.length)];
      const spr = _mkSprite(tex);
      spr.anchor.set(0.5);
      spr.tint  = 0xb8cce0;
      spr.x = sx + (Math.random() - 0.5) * 3;
      spr.y = sy + (Math.random() - 0.5) * 3;
      spr.rotation = (Math.random() - 0.5) * 0.4;
      spr.alpha = 0;
      this.container.addChild(spr);

      this.puffs.push({
        spr, vx, vy,
        age: 0,
        life: CFG.flight.puffLifeMs * (0.9 + Math.random() * 0.3),
        maxR: CFG.flight.wingPSize * (0.55 + Math.random() * 0.35) * puffMul,
        rotV: (Math.random() - 0.5) * 0.001,
      });
    }
  }

  triggerBrake(x, y, dx, dy, sizeScale) {
    for (let i = 0; i < CFG.flight.brakeFlaps; i++) {
      this.brakeQueue.push({
        triggerAt: performance.now() + i * CFG.flight.brakeIntervalMs,
        x, y,
        dx: -dx, dy: -dy,
        sizeScale,
      });
    }
  }

  update(dtMs, nowMs) {
    const spin = CFG.flight.tornadoSpin * 0.001;
    for (let i = this.tornadoParticles.length - 1; i >= 0; i--) {
      const p = this.tornadoParticles[i];
      p.age += dtMs;
      if (p.age >= p.life) {
        p.spr.parent?.removeChild(p.spr);
        p.spr.destroy();
        this.tornadoParticles.splice(i, 1);
        continue;
      }
      p.angle += spin * dtMs;
      const t = p.age / p.life;
      const r = lerp(CFG.flight.tornadoInnerR * p.scale, CFG.flight.tornadoOuterR * p.scale, easeOut(t));
      p.spr.x = p.cx + Math.cos(p.angle) * r;
      p.spr.y = p.cy + Math.sin(p.angle) * r;
      const size = lerp(CFG.flight.tornadoSize1, CFG.flight.tornadoSize2, t) * p.sizeMul;
      p.spr.width = p.spr.height = size;
      const fadeIn  = Math.min(t / 0.15, 1);
      const fadeOut = 1 - Math.pow(t, 1.8);
      p.spr.alpha = fadeIn * fadeOut * p.alphaMul * CFG.flight.tornadoAlpha;
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += dtMs;
      if (sw.age >= sw.life) {
        for (const p of sw.particles) { p.spr.parent?.removeChild(p.spr); p.spr.destroy(); }
        this.shockwaves.splice(i, 1);
        continue;
      }
      const t = sw.age / sw.life;
      const R = lerp(sw.minR, sw.maxR, 1 - Math.pow(1 - t, 2.2));
      const fadeIn  = Math.min(t / 0.10, 1);
      const fadeOut = 1 - Math.pow(t, 1.4);
      const baseAlpha = fadeIn * fadeOut * CFG.flight.shockAlpha;
      const sizeGrow = 1 + t * CFG.flight.shockSizeGrow;
      for (const p of sw.particles) {
        const r = R * (1 + p.radOff * p.driftMul) + t * 12 * p.driftMul;
        p.spr.x = sw.cx + Math.cos(p.baseAngle) * r;
        p.spr.y = sw.cy + Math.sin(p.baseAngle) * r;
        const drawSize = CFG.flight.shockPSize * p.size * sizeGrow * Math.sqrt(sw.scale);
        p.spr.width = p.spr.height = drawSize;
        p.spr.alpha = baseAlpha * p.alphaMul;
      }
    }

    for (let i = this.brakeQueue.length - 1; i >= 0; i--) {
      const b = this.brakeQueue[i];
      if (nowMs >= b.triggerAt) {
        this.emitWingPair(b.x, b.y, b.dx, b.dy, b.sizeScale);
        this.brakeQueue.splice(i, 1);
      }
    }

    const drag = Math.pow(CFG.flight.puffDrag, dtMs / 16);
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dtMs;
      if (p.age >= p.life) {
        p.spr.parent?.removeChild(p.spr);
        p.spr.destroy();
        this.puffs.splice(i, 1);
        continue;
      }
      const t = p.age / p.life;
      const size = lerp(p.maxR * 0.5, p.maxR * CFG.flight.wingGrow, easeOut(Math.min(t * 1.6, 1)));
      const alpha = t < 0.12 ? lerp(0, 1, t / 0.12) : lerp(1, 0, (t - 0.12) / 0.88);
      p.spr.x += p.vx * (dtMs / 16);
      p.spr.y += p.vy * (dtMs / 16);
      p.vx *= drag;
      p.vy *= drag;
      p.spr.rotation += p.rotV * dtMs;
      p.spr.width  = size * 1.15;
      p.spr.height = size * 0.9;
      p.spr.alpha  = alpha * CFG.flight.wingAlpha;
    }
  }

  destroy() {
    for (const p of this.tornadoParticles) p.spr.destroy();
    for (const sw of this.shockwaves) for (const p of sw.particles) p.spr.destroy();
    for (const p of this.puffs) p.spr.destroy();
    this.tornadoParticles.length = 0;
    this.shockwaves.length = 0;
    this.puffs.length = 0;
    this.brakeQueue.length = 0;
  }
}

class RunSystem {
  constructor(container, dustTexs, pebbleTexs) {
    this.container = container;
    this.dustTexs = dustTexs;
    this.pebbleTexs = pebbleTexs;
    this.dust = [];
    this.pebbles = [];
  }

  emitDust(x, y, dx, dy, halfR = 30) {
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len;
    const perpX = -fy, perpY = fx;
    const tex = this.dustTexs[Math.floor(Math.random() * this.dustTexs.length)];
    const spr = _mkSprite(tex);
    spr.anchor.set(0.5);
    this.container.addChild(spr);
    const backOff  = halfR + 4 + Math.random() * 10;
    const sideOff  = (Math.random() - 0.5) * halfR * 0.9;
    spr.x = x - fx * backOff + perpX * sideOff;
    spr.y = y - fy * backOff + perpY * sideOff;
    spr.rotation = Math.random() * TAU;

    const backSpd = 1.8 + Math.random() * 1.4;
    const sideSpd = (Math.random() - 0.5) * 2.2;
    this.dust.push({
      spr,
      vx: -fx * backSpd + perpX * sideSpd,
      vy: -fy * backSpd + perpY * sideSpd,
      age: 0,
      life: CFG.run.dustLife * (0.85 + Math.random() * 0.3),
      maxR: CFG.run.dustSize * (0.7 + Math.random() * 0.6),
      rotV: (Math.random() - 0.5) * 0.003,
      alphaMul: 0.7 + Math.random() * 0.3,
    });
  }

  emitPebbles(x, y, dx, dy, halfR = 30) {
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len;
    const perpX = -fy, perpY = fx;
    for (let i = 0; i < CFG.run.pebCount; i++) {
      const back = 0.7 + Math.random() * 0.6;
      const sideAmt = (Math.random() - 0.5) * 1.0;
      const speed = CFG.run.pebSpeed * 0.12 * (0.8 + Math.random() * 0.5);
      const vx = (-fx * back + perpX * sideAmt) * speed;
      const vy = (-fy * back + perpY * sideAmt) * speed;
      const tex = this.pebbleTexs[Math.floor(Math.random() * this.pebbleTexs.length)];
      const spr = _mkSprite(tex);
      spr.anchor.set(0.5);
      const sideOff = (Math.random() - 0.5) * halfR * 0.7;
      spr.x = x - fx * (halfR + 2 + Math.random() * 6) + perpX * sideOff;
      spr.y = y - fy * (halfR + 2 + Math.random() * 6) + perpY * sideOff;
      spr.rotation = Math.random() * TAU;
      const sc = 0.7 + Math.random() * 0.7;
      spr.scale.set(CFG.run.pebSize * 2 * sc / 16);
      this.container.addChild(spr);

      this.pebbles.push({
        spr, vx, vy,
        age: 0,
        life: CFG.run.pebLife * (0.85 + Math.random() * 0.3),
        rotV: (Math.random() - 0.5) * 0.02,
      });
    }
  }

  update(dtMs) {
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const p = this.dust[i];
      p.age += dtMs;
      if (p.age >= p.life) { p.spr.parent?.removeChild(p.spr); p.spr.destroy(); this.dust.splice(i, 1); continue; }
      p.spr.x += p.vx * (dtMs / 16);
      p.spr.y += p.vy * (dtMs / 16);
      p.vx *= Math.pow(0.96, dtMs / 16);
      p.vy *= Math.pow(0.96, dtMs / 16);
      p.spr.rotation += p.rotV * dtMs;
      const t = p.age / p.life;
      const size = lerp(p.maxR * 0.4, p.maxR * CFG.run.dustGrow, easeOut(Math.min(t * 1.4, 1)));
      const fadeIn = Math.min(t / 0.10, 1);
      const fadeOut = 1 - Math.pow(t, 1.5);
      p.spr.width = p.spr.height = size;
      p.spr.alpha = fadeIn * fadeOut * p.alphaMul * CFG.run.dustAlpha;
    }

    for (let i = this.pebbles.length - 1; i >= 0; i--) {
      const p = this.pebbles[i];
      p.age += dtMs;
      if (p.age >= p.life) { p.spr.parent?.removeChild(p.spr); p.spr.destroy(); this.pebbles.splice(i, 1); continue; }
      p.spr.x += p.vx * (dtMs / 16);
      p.spr.y += p.vy * (dtMs / 16);
      const drag = Math.pow(0.88, dtMs / 16);
      p.vx *= drag;
      p.vy *= drag;
      p.spr.rotation += p.rotV * dtMs;
      const t = p.age / p.life;
      p.spr.alpha = (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4) * CFG.run.pebAlpha;
    }
  }

  destroy() {
    for (const p of this.dust) p.spr.destroy();
    for (const p of this.pebbles) p.spr.destroy();
    this.dust.length = 0;
    this.pebbles.length = 0;
  }
}

class BurrowSystem {
  constructor(container, clodTexs) {
    this.container = container;
    this.clodTexs = clodTexs;
    this.clods = [];
  }

  emit(x, y, dx, dy, gridSize) {
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len;
    const halfPx = (gridSize * (canvas.dimensions?.size ?? 64)) / 2;

    for (let i = 0; i < CFG.burrow.count; i++) {
      const sx = x + (Math.random() - 0.5) * halfPx * 2;
      const sy = y + (Math.random() - 0.5) * halfPx * 2;
      const a = Math.random() * TAU;
      const speed = CFG.burrow.speed * 0.06 * (0.5 + Math.random() * 0.5);
      const vx = Math.cos(a) * speed - fx * speed * 0.2;
      const vy = Math.sin(a) * speed - fy * speed * 0.2;
      const sizeMul = (0.7 + Math.random() * 0.6) * 0.85;
      const tex = this.clodTexs[Math.floor(Math.random() * this.clodTexs.length)];
      const spr = _mkSprite(tex);
      spr.anchor.set(0.5);
      spr.x = sx; spr.y = sy;
      spr.rotation = Math.random() * TAU;
      spr.scale.set(CFG.burrow.clodSize * 2 * sizeMul / 24);
      this.container.addChild(spr);

      this.clods.push({
        spr, vx, vy,
        state: 'flying',
        age: 0,
        bounceCount: 1 + Math.floor(Math.random() * 2),
        rotV: (Math.random() - 0.5) * 0.012,
        sizeMul,
        restingAge: 0,
        restLife: CFG.burrow.restLife * (0.7 + Math.random() * 0.5),
      });
    }
  }

  update(dtMs) {
    for (let i = this.clods.length - 1; i >= 0; i--) {
      const c = this.clods[i];
      if (c.state === 'flying') {
        c.age += dtMs;
        c.spr.x += c.vx * (dtMs / 16);
        c.spr.y += c.vy * (dtMs / 16);
        const drag = Math.pow(0.93, dtMs / 16);
        c.vx *= drag;
        c.vy *= drag;
        c.spr.rotation += c.rotV * dtMs;
        const sp = Math.hypot(c.vx, c.vy);
        if (sp < 0.1 && c.age > 80) {
          if (c.bounceCount > 0) {
            const a = Math.random() * TAU;
            const bs = 0.4 + Math.random() * 0.3;
            c.vx = Math.cos(a) * bs;
            c.vy = Math.sin(a) * bs;
            c.rotV *= 0.6;
            c.bounceCount--;
          } else {
            c.state = 'resting';
            c.vx = 0; c.vy = 0; c.rotV = 0;
          }
        }
      } else {
        c.restingAge += dtMs;
        if (c.restingAge >= c.restLife) {
          c.spr.parent?.removeChild(c.spr);
          c.spr.destroy();
          this.clods.splice(i, 1);
          continue;
        }
        const t = c.restingAge / c.restLife;
        c.spr.alpha = (t < 0.7 ? 0.55 : 0.55 * (1 - (t - 0.7) / 0.3));
      }
    }
  }

  destroy() {
    for (const c of this.clods) c.spr.destroy();
    this.clods.length = 0;
  }
}

class TokenEffectState {
  constructor(token) {
    this.token = token;
    this.id = token.id;
    this.prevX = 0; this.prevY = 0;
    this.smoothSpeed = 0;
    this.flapPhase = 0;
    this.wasPeak = false;
    this.lastRingTs = 0;
    this.tornadoCenterActive = false;
    this.tornadoCenterX = 0; this.tornadoCenterY = 0;
    this.tornadoAccum = 0;
    this.tornadoPhase = 0;
    this.wasFlying = false;
    this.wasMoving = false;
    this.wasGroundMoving = false;
    this.wasBurrowing = false;
    this.lastMoveDx = 0; this.lastMoveDy = 0;
    this.distanceMovedFt = 0;
    this.lastElevationFt = 0;
    this.peakElevationFt = 0;
    this.lastDustTs = 0;
    this.lastPebTs  = 0;
    this.lastBurrowTs = 0;
  }
}

class TokenEffects {
  static _instance = null;
  static get instance() {
    if (!this._instance) this._instance = new TokenEffects();
    return this._instance;
  }

  constructor() {
    this.containers = null;
    this.systems = null;
    this.states = new Map();
    this._tickBound = null;
  }

  init() {
    if (this.containers) return;
    try {
      const flightContainer = new PIXI.Container();
      const runContainer    = new PIXI.Container();
      const burrowContainer = new PIXI.Container();
      for (const c of [flightContainer, runContainer, burrowContainer]) {
        c.eventMode           = 'none';
        c.interactive         = false;
        c.interactiveChildren = false;
      }
      flightContainer.zIndex = CFG.zIndex + 2;
      runContainer.zIndex    = CFG.zIndex + 1;
      burrowContainer.zIndex = CFG.zIndex;

      // Darken particles to match scene darkness without reducing alpha
      // (alpha-based dimming makes already-faint particles invisible).
      const CMF = PIXI.filters?.ColorMatrixFilter ?? PIXI.ColorMatrixFilter;
      this._darkFilters = CMF ? [new CMF(), new CMF(), new CMF()] : null;
      if (this._darkFilters) {
        flightContainer.filters = [this._darkFilters[0]];
        runContainer.filters    = [this._darkFilters[1]];
        burrowContainer.filters = [this._darkFilters[2]];
      }

      const effectParent = canvas.stage;
      effectParent.addChild(burrowContainer, runContainer, flightContainer);

      const blobTex    = bakeBlobTexture(64);
      const puffTexs   = [7, 20, 33, 46, 59, 72].map(s => bakePuffTexture(s, 128));
      const dustTexs   = [3, 17, 31, 47, 59, 73].map(s => bakeDustTexture(s, 96));
      const pebbleTexs = [11, 23, 37, 53, 67, 83, 97, 109].map(s => bakePebbleTexture(s, 16));
      const clodTexs   = [3, 17, 31, 47, 59, 73, 89, 101, 113, 127].map(s => bakeClodTexture(s, 24));

      this.containers = { flight: flightContainer, run: runContainer, burrow: burrowContainer };
      this.textures = { blob: blobTex, puffs: puffTexs, dust: dustTexs, pebbles: pebbleTexs, clods: clodTexs };
      this.systems = {
        flight: new FlightSystem(flightContainer, blobTex, puffTexs),
        run:    new RunSystem(runContainer, dustTexs, pebbleTexs),
        burrow: new BurrowSystem(burrowContainer, clodTexs),
      };

      this._tickBound = this._onTick.bind(this);
      canvas.app.ticker.add(this._tickBound);
    } catch (err) {
      console.error('[smooth-move] init() FAILED:', err);
    }
  }

  destroy() {
    if (!this.containers) return;
    canvas.app.ticker.remove(this._tickBound);
    this.systems.flight.destroy();
    this.systems.run.destroy();
    this.systems.burrow.destroy();
    for (const c of Object.values(this.containers)) c.destroy({ children: true });
    for (const t of [this.textures.blob, ...this.textures.puffs, ...this.textures.dust, ...this.textures.pebbles, ...this.textures.clods]) {
      t.destroy(true);
    }
    for (const f of this._darkFilters ?? []) try { f.destroy(); } catch (_) {}
    this._darkFilters = null;
    this.containers = null;
    this.systems = null;
    this.states.clear();
  }

  _dropToken(id) {
    this.systems?.flight?.clearTornadoFor(id);
    this.states.delete(id);
  }

  _onTick(ticker) {
    if (!this.systems) return;
    const dt = ticker.deltaMS ?? 16;
    const now = performance.now();

    if (this._darkFilters) {
      // v14: Scene#darkness is gone; the live level is canvas.darknessLevel
      // (= canvas.environment.darknessLevel), which is what core reads too.
      const darkness = canvas.darknessLevel ?? canvas.scene?.darkness ?? 0;
      if (darkness !== this._lastDarkness) {
        this._lastDarkness = darkness;
        const containers = Object.values(this.containers);
        if (darkness <= 0) {
          // No darkness — remove filters entirely (saves 3 render passes per frame)
          for (const c of containers) c.filters = null;
        } else {
          const brightness = Math.max(0.1, 1 - darkness);
          let i = 0;
          for (const c of containers) {
            if (!c.filters?.length) c.filters = [this._darkFilters[i]];
            const f = this._darkFilters[i++];
            if (typeof f.brightness === 'function') f.brightness(brightness, false);
            else { f.matrix = [brightness,0,0,0,0, 0,brightness,0,0,0, 0,0,brightness,0,0, 0,0,0,1,0]; }
          }
        }
      }
    }

    const ftPerPx = (canvas.scene?.grid?.distance ?? 5) / (canvas.dimensions?.size ?? 64);

    const tokens = canvas.tokens?.placeables ?? [];
    for (const token of tokens) {
      this._updateToken(token, dt, now, ftPerPx);
    }

    this.systems.flight.update(dt, now);
    this.systems.run.update(dt);
    this.systems.burrow.update(dt);
  }

  _updateToken(token, dt, now, ftPerPx) {
    const mesh = token.mesh;
    if (!mesh) return;
    const mx = mesh.x;
    const my = mesh.y;

    const elevationFt = token.document?.elevation ?? 0;
    const gridSize    = Math.max(token.document?.width ?? 1, token.document?.height ?? 1);
    const gridPx      = canvas.dimensions?.size ?? 100;
    const tScale      = (gridSize * gridPx) / 100;   // 1.0 = 100px reference token

    let st = this.states.get(token.id);
    if (!st) {
      st = new TokenEffectState(token);
      st.prevX = mx; st.prevY = my;
      st.lastElevationFt = elevationFt;
      this.states.set(token.id, st);
      return;
    }

    const ddx = mx - st.prevX;
    const ddy = my - st.prevY;
    const inst = Math.hypot(ddx, ddy);
    st.smoothSpeed = lerp(st.smoothSpeed, inst, CFG.smoothFactor);
    st.prevX = mx; st.prevY = my;
    if (inst > 0.5) { st.lastMoveDx = ddx; st.lastMoveDy = ddy; }

    const isMoving = st.smoothSpeed > CFG.moveThreshold;
    const isFlying = elevationFt > 0;
    // This runs for every token on every frame, and getMoveMode allocates (it
    // lowercases). It only matters while burrowing or while undoing the burrow
    // alpha, so don't pay for it on idle tokens.
    const isBurrowing = (isMoving || st.wasBurrowing) && getMoveMode(token) === 'burrow';

    if (isMoving) st.distanceMovedFt += inst * ftPerPx;
    if (isFlying && elevationFt > st.peakElevationFt) st.peakElevationFt = elevationFt;

    if (isFlying) {
      if (!isMoving) {
        if (!st.tornadoCenterActive) {
          st.tornadoCenterX = mx;
          st.tornadoCenterY = my;
          st.tornadoCenterActive = true;
        }
        st.tornadoAccum += dt / 1000 * CFG.flight.tornadoEmitRate;
        while (st.tornadoAccum >= 1) {
          this.systems.flight.emitTornado(token.id, st.tornadoCenterX, st.tornadoCenterY, st.tornadoPhase, tScale);
          st.tornadoPhase += CFG.flight.tornadoPhaseStep;
          st.tornadoAccum -= 1;
        }
      } else {
        if (st.tornadoCenterActive) {
          this.systems.flight.clearTornadoFor(token.id);
          st.tornadoCenterActive = false;
        }
        st.flapPhase += dt / CFG.flight.flapMs;
        const peak = Math.sin(st.flapPhase * TAU) > 0.85;
        if (peak && !st.wasPeak) {
          this.systems.flight.emitWingPair(mx, my, ddx, ddy, tScale);
        }
        st.wasPeak = peak;
      }

      if (st.wasMoving && !isMoving) {
        if (st.distanceMovedFt >= CFG.BRAKE_MIN_FEET) {
          this.systems.flight.triggerBrake(mx, my, st.lastMoveDx, st.lastMoveDy, tScale);
        }
        st.distanceMovedFt = 0;
      }
    } else {
      st.tornadoCenterActive = false;
      st.wasPeak = false;
    }

    if (st.wasFlying && !isFlying) {
      if (st.peakElevationFt >= CFG.LAND_MIN_FEET) {
        this.systems.flight.spawnShockwave(mx, my, tScale, gridSize * gridPx / 2);
      }
      this.systems.flight.clearTornadoFor(token.id);
      st.tornadoCenterActive = false;
      st.peakElevationFt = 0;
    }
    if (!st.wasFlying && isFlying) {
      st.peakElevationFt = elevationFt;
    }

    if (!isFlying && isMoving && !isBurrowing && (token._smRunFt ?? 0) > CFG.RUN_MIN_FEET) {
      if (now - st.lastPebTs > CFG.run.pebRate) {
        this.systems.run.emitPebbles(mx, my, st.lastMoveDx, st.lastMoveDy, gridSize * gridPx / 2);
        st.lastPebTs = now;
      }
    }

    if (isBurrowing && isMoving) {
      if (now - st.lastBurrowTs > CFG.burrow.rate) {
        this.systems.burrow.emit(mx, my, ddx, ddy, tScale);
        st.lastBurrowTs = now;
      }
      if (token.mesh) token.mesh.alpha = CFG.burrow.tokenAlpha;
    } else {
      if (st.wasBurrowing && token.mesh) token.mesh.alpha = 1.0;
    }

    st.wasMoving = isMoving;
    st.wasFlying = isFlying;
    st.wasGroundMoving = isMoving && !isFlying;
    st.wasBurrowing = isBurrowing;
  }
}

async function animWalk(token, wpts, totalMs, bsx, bsy, baseRot = 0) {
  const steps  = wpts.length - 1;
  const stepMs = totalMs / Math.max(steps, 1);
  let svx = 0, rot = 0;

  for (let i = 0; i < steps; i++) {
    const fx = wpts[i].x,   fy = wpts[i].y;
    const dx = wpts[i+1].x - fx, dy = wpts[i+1].y - fy;

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
          token.mesh.rotation = baseRot + rot;
          syncPos(token);
          refreshDuringAnimation(token);
        }
        if (k >= 1) {
          canvas.app.ticker.remove(tick);
          res();
        }
      };
      canvas.app.ticker.add(tick);
    });
  }
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
        if (!burstDone && prof.burstEffect) {
          burstDone = true;
          prof.burstEffect(layer, pos.x, pos.y, tr);
        }
        spawnTimer += dt;
        if (spawnTimer >= spawnInterval) {
          spawnTimer -= spawnInterval;
          prof.effect(layer, pos.x, pos.y, dirX, dirY, tr);
        }
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
        refreshDuringAnimation(token);
      }
      if (t >= 1) {
        canvas.app.ticker.remove(tick);
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
          refreshDuringAnimation(token);
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

  // The token is now at the destination. Re-test fog before it fades back in,
  // otherwise a token blinking somewhere the viewer cannot see would visibly
  // materialise there and only be hidden once the animation released the mesh.
  if(token.mesh){token.mesh.alpha=0;token.mesh.position.set(dest.x,dest.y);syncPos(token);refreshDuringAnimation(token);} gfx.clear();

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

  if(token.mesh){token.mesh.alpha=0;} gfx.clear(); trail.clear();

  await new Promise(res => {
    const t0=performance.now();
    const tick=()=>{
      const k=clamp((performance.now()-t0)/inMs,0,1), eK=eio4(k);
      gfx.clear(); drawParts(dest.x,dest.y,eK*gs*0.65*(1-k),k);
      gfx.lineStyle(2.5,CORE,k*0.85); gfx.drawCircle(dest.x,dest.y,eK*gs*0.45); gfx.lineStyle(0);
      if(token.mesh){token.mesh.alpha=k;token.mesh.scale.set(bsx*(0.88+k*0.12),bsy*(0.88+k*0.12));syncPos(token);}
      if(k>=1){canvas.app.ticker.remove(tick);res();}
    };
    canvas.app.ticker.add(tick);
  });

  try { fx.destroy({ children: true }); } catch(_) {}
}
