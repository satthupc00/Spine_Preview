// ---------------------------------------------------------------------------
// Rendering layer: PIXI (WebGL) + pixi-spine.
//
// Everything Spine-specific — bone transform inherit modes, timeline semantics, additive/
// multiply/screen blend, clipping attachments, weighted meshes, IK, deform — is handled by the
// official Spine runtime that pixi-spine bundles (it auto-detects the 3.7 skeleton version from
// the json). This file only owns the *stage*: viewport, zoom/pan, per-instance placement,
// hit-testing, selection overlay, and PNG extraction.
//
// Scene graph:
//   app.stage
//     └── content        <- zoom + pan live here (scale + position)
//     │     └── Spine    <- one per preview instance, positioned in world units
//     └── overlay        <- selection boxes, drawn in SCREEN space so the 1px stroke
//                           stays 1px at any zoom level
// ---------------------------------------------------------------------------
const PIXI = require('pixi.js');
const { Spine } = require('pixi-spine');

// NOTE ON Y AXIS: pixi-spine already converts the skeleton's y-up space into PIXI's y-down
// display space itself, so the container must NOT be flipped again — doing that rendered every
// skeleton upside down. Consequence: `content` is a plain y-down container, world coordinates
// used for instance positions / hit-testing / marquee are y-DOWN, and a bone's display-space y
// is the negation of its skeleton-space worldY (see rootWorldPos).

function toAssetUrl(absolutePath) {
  const normalized = String(absolutePath).replace(/\\/g, '/');
  const trimmed = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const encoded = trimmed.split('/').map((seg, i) => {
    // keep a Windows drive letter ("C:") readable instead of percent-encoding the colon
    if (i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  }).join('/');
  return `spine-asset://asset/${encoded}`;
}

class SpineStage {
  constructor(containerEl) {
    this.containerEl = containerEl;
    const { width, height } = this._viewportSize();

    this.app = new PIXI.Application({
      width, height,
      antialias: true,

      // The WebGL surface is ALWAYS cleared to fully transparent; the visible background (solid
      // colour or checkerboard) is painted by CSS on the wrapper underneath. Driving it from CSS
      // instead of renderer.background means the Transparent toggle can't be defeated by how the
      // WebGL context negotiated its alpha channel — which is why toggling it did nothing before.
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      autoStart: false // we drive rendering from renderer.js's own rAF loop
    });

    this._fixLightBlendAlpha();

    const view = this.app.view;
    view.style.width = '100%';
    view.style.height = '100%';
    view.style.display = 'block';
    view.style.position = 'absolute';
    view.style.inset = '0';
    view.style.zIndex = '0'; // #marquee-box and #preview-empty-hint sit above this
    containerEl.insertBefore(view, containerEl.firstChild);

    this.content = new PIXI.Container();
    this.overlay = new PIXI.Container();
    this.overlayGfx = new PIXI.Graphics();
    this.overlay.addChild(this.overlayGfx);
    this.app.stage.addChild(this.content);
    this.app.stage.addChild(this.overlay);
    this._labelPool = []; // PIXI.Text objects reused across frames
    this._labelsUsed = 0;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  _viewportSize() {
    const el = this.containerEl;
    return {
      width: Math.max(1, Math.round(el.clientWidth || 1)),
      height: Math.max(1, Math.round(el.clientHeight || 1))
    };
  }

  syncViewportSize() {
    const { width, height } = this._viewportSize();
    const r = this.app.renderer;
    if (r.screen.width !== width || r.screen.height !== height) r.resize(width, height);
  }

  // ---- asset loading ------------------------------------------------------
  // Returns SkeletonData, cached per json path so dropping the same skeleton five times shares
  // one texture and one parsed skeleton.
  async loadSkeletonData(jsonPath, atlasPath) {
    SpineStage._cache = SpineStage._cache || new Map();
    const cached = SpineStage._cache.get(jsonPath);
    if (cached) return cached;

    if (!SpineStage._prefsApplied) {
      SpineStage._prefsApplied = true;
      PIXI.Assets.setPreferences({ preferWorkers: false, crossOrigin: 'anonymous' });
    }

    const resource = await PIXI.Assets.load({
      src: toAssetUrl(jsonPath),
      data: { spineAtlasFile: toAssetUrl(atlasPath) }
    });
    if (!resource || !resource.spineData) throw new Error('Không tạo được spineData từ json/atlas');

    // Defensive wait: on some runs (more often with a large atlas page like a big FX/UI sheet),
    // PIXI.Assets.load() above has been observed to resolve before every atlas page's texture has
    // actually finished uploading. At that point the skeleton METADATA is already fully valid —
    // which is why the Json List entry, Anim List and Skin dropdown all populate normally — but
    // the GPU texture behind it isn't ready yet, so nothing ever paints on the canvas and nothing
    // throws to explain why. Waiting here for every page to report ready (or time out) turns that
    // into either working art or a clear error instead of a silently blank preview.
    await SpineStage._waitForAtlasTextures(resource.spineAtlas);

    SpineStage._cache.set(jsonPath, resource.spineData);
    return resource.spineData;
  }

  static _waitForAtlasTextures(atlas, timeoutMs = 8000) {
    const pages = (atlas && atlas.pages) || [];
    const pending = pages.filter(p => p.baseTexture && !p.baseTexture.valid && !p.baseTexture.destroyed);
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(page => new Promise((resolve) => {
      const bt = page.baseTexture;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        bt.off('loaded', finish);
        bt.off('error', finish);
        clearTimeout(timer);
        resolve();
      };
      bt.on('loaded', finish);
      bt.on('error', finish);
      // Never block the load forever if something upstream never fires either event — worst
      // case we proceed with whatever state the texture is in, same as before this guard existed.
      const timer = setTimeout(finish, timeoutMs);
    })));
  }

  static forgetSkeletonData(jsonPath) {
    if (SpineStage._cache) SpineStage._cache.delete(jsonPath);
    try { PIXI.Assets.unload(toAssetUrl(jsonPath)); } catch (e) { /* not loaded — fine */ }
  }

  // ---- instances ----------------------------------------------------------
  createSpine(spineData) {
    const spine = new Spine(spineData);
    spine.autoUpdate = false; // renderer.js advances time so scrubbing and pause stay exact
    this.content.addChild(spine);
    return spine;
  }

  // The draw order of the preview is the child order of `content`; reorder it to match the
  // instance array after any layer change.
  applyLayerOrder(orderedSpines) {
    orderedSpines.forEach((spine, i) => {
      if (spine && spine.parent === this.content) this.content.setChildIndex(spine, i);
    });
  }

  removeSpine(spine) {
    if (!spine) return;
    spine.parent && spine.parent.removeChild(spine);
    spine.destroy({ children: true });
  }

  // ---- viewport -----------------------------------------------------------
  setView(zoom, panX, panY) {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
    const { width, height } = this._viewportSize();
    this.content.scale.set(zoom, zoom);
    this.content.position.set(width / 2 + panX, height / 2 + panY);
  }

  // Additive / screen slots must only ADD colour, never coverage. PIXI's default ADD writes
  // alpha too (ONE, ONE), so the black parts of a glow texture — which are meant to add nothing —
  // turned the transparent canvas opaque black and hid the background behind it. Keep the
  // destination alpha instead (ZERO, ONE); the colour maths stays exactly the same.
  _fixLightBlendAlpha() {
    const gl = this.app.renderer.gl;
    const modes = this.app.renderer.state.blendModes;
    const B = PIXI.BLEND_MODES;
    modes[B.ADD] = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE];
    modes[B.ADD_NPM] = [gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE];
    modes[B.SCREEN] = [gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE];
    modes[B.SCREEN_NPM] = [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE];
  }

  // A solid background is cleared INTO the WebGL surface, not just painted by CSS underneath,
  // so additive / screen / multiply slots blend against the real background colour exactly like
  // in Spine. `null` = transparent (the CSS checkerboard shows through). PNG export renders into
  // its own RenderTexture, which clears to transparent regardless of this.
  setBackground(color) {
    const bg = this.app.renderer.background;
    if (color == null) {
      bg.alpha = 0;
    } else {
      bg.color = color;
      bg.alpha = 1;
    }
  }

  // Screen pixel -> world unit (y-up), the inverse of setView's transform.
  screenToWorld(px, py) {
    const { width, height } = this._viewportSize();
    return {
      x: (px - width / 2 - this.panX) / this.zoom,
      y: (py - height / 2 - this.panY) / this.zoom
    };
  }

  worldToScreen(wx, wy) {
    const { width, height } = this._viewportSize();
    return {
      x: wx * this.zoom + width / 2 + this.panX,
      y: wy * this.zoom + height / 2 + this.panY
    };
  }

  // ---- geometry -----------------------------------------------------------
  // Bounding box of what the skeleton actually draws this frame, in world units.
  // getBounds() is in screen space, so convert both corners back.
  worldBoundsOf(spine) {
    const b = spine.getBounds();
    const a = this.screenToWorld(b.x, b.y);
    const c = this.screenToWorld(b.x + b.width, b.y + b.height);
    return {
      minX: Math.min(a.x, c.x), maxX: Math.max(a.x, c.x),
      minY: Math.min(a.y, c.y), maxY: Math.max(a.y, c.y)
    };
  }

  // World position of the skeleton's root bone (case-insensitive, as agreed).
  rootWorldPos(spine) {
    const bones = spine.skeleton.bones;
    let root = null;
    for (const b of bones) {
      const n = (b.data && b.data.name) || '';
      if (n.toLowerCase() === 'root') { root = b; break; }
    }
    if (!root) root = bones[0];
    if (!root) return { x: spine.position.x, y: spine.position.y };
    // bone world coords are in skeleton space; the Spine display object applies its own
    // position + scale on top of that.
    // bone.worldY is skeleton space (y-up); display space is y-down, hence the negation.
    return {
      x: spine.position.x + root.worldX * spine.scale.x,
      y: spine.position.y - root.worldY * spine.scale.y
    };
  }

  // ---- selection overlay --------------------------------------------------
  clearOverlay() {
    this.overlayGfx.clear();
    this._labelPool.forEach(t => { t.visible = false; });
    this._labelsUsed = 0;
  }

  _takeLabel() {
    let label = this._labelPool[this._labelsUsed];
    if (!label) {
      label = new PIXI.Text('', new PIXI.TextStyle({ fontFamily: 'sans-serif', fontSize: 11 }));
      label.resolution = window.devicePixelRatio || 1;
      this._labelPool.push(label);
      this.overlay.addChild(label);
    }
    this._labelsUsed++;
    label.visible = true;
    return label;
  }

  drawSelectionBox(spine, exportW, exportH, strokeColor) {
    const root = this.rootWorldPos(spine);
    const centre = this.worldToScreen(root.x, root.y);
    const w = exportW * this.zoom * spine.scale.x;
    const h = exportH * this.zoom * spine.scale.x;
    const left = Math.round(centre.x - w / 2) + 0.5;
    const top = Math.round(centre.y - h / 2) + 0.5;

    this.overlayGfx.lineStyle({ width: 1, color: strokeColor, alignment: 0.5 });
    this.overlayGfx.drawRect(left, top, w, h);

    // "256x512" caption above the box, same as the old Canvas 2D renderer drew.
    const label = this._takeLabel();
    label.text = `${exportW}x${exportH}`;
    label.style.fill = strokeColor;
    label.position.set(left, top - label.height - 2);
  }

  // Sequencer selection box: unlike Preview's drawSelectionBox (fixed export W/H), a Sequencer
  // layer has no export size configured, so this traces the instance's own actual rendered
  // bounds instead.
  drawBoundsSelection(spine, strokeColor) {
    const b = this.worldBoundsOf(spine);
    const a = this.worldToScreen(b.minX, b.minY);
    const c = this.worldToScreen(b.maxX, b.maxY);
    const left = Math.round(Math.min(a.x, c.x)) + 0.5;
    const top = Math.round(Math.min(a.y, c.y)) + 0.5;
    const w = Math.abs(c.x - a.x);
    const h = Math.abs(c.y - a.y);
    this.overlayGfx.lineStyle({ width: 1, color: strokeColor, alignment: 0.5 });
    this.overlayGfx.drawRect(left, top, w, h);
  }

  render() {
    this.app.renderer.render(this.app.stage);
  }

  // ---- PNG export ---------------------------------------------------------
  // Renders ONE instance alone, at its own scale, on a transparent background, into an
  // exportW x exportH canvas centred on its root bone. Runs on a throwaway renderer pinned to
  // resolution 1 so the output is exactly the requested pixel size regardless of the display's
  // devicePixelRatio.
  extractInstancePng(spine, exportW, exportH) {
    // Render into an explicit resolution-1 RenderTexture on the EXISTING renderer. Two reasons
    // not to spin up a second PIXI.Renderer: it would need its own WebGL context (browsers cap
    // those), and the skeleton's textures are already uploaded to this one. Going through a
    // RenderTexture also pins the output to exactly exportW x exportH no matter what
    // devicePixelRatio the display reports — extract.canvas() would otherwise multiply by the
    // renderer's own resolution and hand back a 2x image on a retina screen.
    const renderTexture = PIXI.RenderTexture.create({ width: exportW, height: exportH, resolution: 1 });

    const prevParent = spine.parent;
    const prevIndex = prevParent ? prevParent.getChildIndex(spine) : -1;
    const prevPos = { x: spine.position.x, y: spine.position.y };
    const prevScaleY = spine.scale.y;
    const holder = new PIXI.Container();

    try {
      holder.addChild(spine);

      const s = spine.scale.x;
      const bones = spine.skeleton.bones;
      const root = bones.find(b => ((b.data && b.data.name) || '').toLowerCase() === 'root') || bones[0];
      const rx = root ? root.worldX : 0;
      const ry = root ? root.worldY : 0;
      // Root bone dead centre of the export canvas (display y is -worldY, as above).
      spine.position.set(exportW / 2 - rx * s, exportH / 2 + ry * spine.scale.y);

      this.app.renderer.render(holder, { renderTexture, clear: true });
      return this.app.renderer.extract.canvas(renderTexture).toDataURL('image/png');
    } finally {
      holder.removeChild(spine);
      holder.destroy({ children: false });
      spine.position.set(prevPos.x, prevPos.y);
      spine.scale.y = prevScaleY;
      if (prevParent) {
        prevParent.addChildAt(spine, Math.max(0, Math.min(prevIndex, prevParent.children.length)));
      }
      renderTexture.destroy(true);
    }
  }

  // ---- skin helpers ---------------------------------------------------------
  static skinNames(spine) {
    return spine.spineData.skins.map(s => s.name);
  }

  static currentSkin(spine) {
    const skin = spine.skeleton.skin;
    return skin ? skin.name : 'default';
  }

  // Switching skins swaps which attachments the slots point at; setSlotsToSetupPose() is required
  // afterwards or slots whose attachment doesn't exist in the new skin keep showing the old one.
  // update(0) then re-applies the current animation frame on top of the new attachments.
  static setSkin(spine, name) {
    spine.skeleton.setSkinByName(name);
    spine.skeleton.setSlotsToSetupPose();
    spine.update(0);
  }

  // ---- animation helpers (thin wrappers over AnimationState) --------------
  static animationNames(spine) {
    return spine.spineData.animations.map(a => a.name);
  }

  static animationDuration(spine, name) {
    const target = name || SpineStage.currentAnimation(spine);
    const anim = spine.spineData.animations.find(a => a.name === target);
    return anim ? anim.duration : 0;
  }

  static currentAnimation(spine) {
    const entry = spine.state.tracks[0];
    return entry && entry.animation ? entry.animation.name : null;
  }

  static play(spine, name) {
    spine.state.setAnimation(0, name, true); // animations always loop, per spec
    spine.update(0);
  }

  static currentTime(spine) {
    const entry = spine.state.tracks[0];
    if (!entry || !entry.animation) return 0;
    const dur = entry.animation.duration;
    return dur > 0 ? entry.trackTime % dur : entry.trackTime;
  }

  static seek(spine, time) {
    const entry = spine.state.tracks[0];
    if (!entry || !entry.animation) return;
    entry.trackTime = Math.max(0, Math.min(time, entry.animation.duration));
    spine.update(0);
  }

  static advance(spine, dt) {
    spine.update(dt);
  }

  // ---- Mixer crossfade -----------------------------------------------------
  // Drives AnimationState's own built-in single-track crossfade (TrackEntry.mixingFrom) instead
  // of posing the skeleton by hand: `current` = animB (the entry being mixed IN), with
  // `current.mixingFrom` = animA (the entry being mixed OUT). AnimationState already knows, per
  // bone property, whether that property belongs only to A, only to B, or both (`timelineMode`) and
  // falls each "unique" property back to the bind pose as the mix progresses — the naive
  // hand-rolled version (`Animation.apply()` called twice with no AnimationState involved) got this
  // wrong for every bone A sets that B doesn't touch (they kept A's leftover pose forever instead of
  // resting at bind pose), which is what made whole limbs look stuck through the overlap. Normally
  // `TrackEntry.mixTime` advances on its own forward-only timer via `state.update(dt)`; here it's
  // pointed at an arbitrary `alpha` directly instead, so arbitrary scrubbing works.
  // `alpha` is clamped strictly inside (0, 1): AnimationState auto-disposes `mixingFrom` the instant
  // `mixTime` reaches `mixDuration`, which — if hit while still scrubbing — would silently drop the
  // A side and start reading as pure B one frame early.
  // Crucially this calls the *real* `spine.update(0)` (not just `skeleton.updateWorldTransform()`),
  // which is what actually pushes the computed bone pose into the PIXI slot sprites
  // (`spine.slotContainers`) — skipping that step was the direct cause of the reported freeze: the
  // skeleton's internal pose was updating correctly every frame, but nothing pushed it to what PIXI
  // actually draws, so the last frame drawn before entering the overlap stayed on screen the whole
  // time.
  static playBlend(spine, animNameA, timeA, animNameB, timeB, alpha) {
    const state = spine.state;
    const EPS = 0.001;
    let cur = state.tracks[0];
    const needsSetup = !cur || !cur.mixingFrom
      || cur.mixingFrom.animation.name !== animNameA
      || cur.animation.name !== animNameB;
    if (needsSetup) {
      state.data.setMix(animNameA, animNameB, 1);
      state.setAnimation(0, animNameA, true);
      spine.update(0); // must apply once before chaining B, else setAnimation() has nothing to mix from
      cur = state.setAnimation(0, animNameB, true);
    }
    const a = Math.max(EPS, Math.min(1 - EPS, alpha));
    cur.alpha = 1;
    cur.trackTime = Math.max(0, timeB);
    cur.mixTime = a * cur.mixDuration;
    if (cur.mixingFrom) {
      cur.mixingFrom.alpha = 1;
      cur.mixingFrom.trackTime = Math.max(0, timeA);
    }
    spine.update(0);
  }
}

module.exports = { SpineStage, toAssetUrl, PIXI };
