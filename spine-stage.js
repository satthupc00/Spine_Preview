// ---------------------------------------------------------------------------
// Rendering layer: PIXI (WebGL) + pixi-spine.
//
// Everything Spine-specific — bone transform inherit modes, timeline semantics, additive/
// multiply/screen blend, clipping attachments, weighted meshes, IK, deform — is handled by the
// official Spine runtimes: pixi-spine for 3.7 … 4.1 json (it auto-detects the version), and
// @esotericsoftware/spine-pixi-v7 (spine42.js) for 4.2 json, which adds physics. Which one a file
// gets is decided from "skeleton.spine" in the json; a 4.2 instance carries `_rt42 = true` and the
// same `spineData` / `skeleton` / `state` / `update(dt)` surface the rest of the app uses.
// This file only owns the *stage*: viewport, zoom/pan, per-instance placement, hit-testing,
// selection overlay, bone overlay and PNG extraction.
//
// Scene graph:
//   app.stage
//     └── content        <- zoom + pan live here (scale + position)
//     │     └── Spine    <- one per preview instance, positioned in world units
//     └── overlay        <- selection boxes, drawn in SCREEN space so the 1px stroke
//                           stays 1px at any zoom level
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const PIXI = require('pixi.js');
const { Spine } = require('pixi-spine');
const S42 = require('./spine42.js');

// NOTE ON Y AXIS: both runtimes already convert the skeleton's y-up space into PIXI's y-down
// display space themselves (yDown), so the container must NOT be flipped again — doing that
// rendered every skeleton upside down. Consequence: `content` is a plain y-down container, world
// coordinates used for instance positions / hit-testing / marquee are y-DOWN, and a bone's
// worldX / worldY are already in the Spine display object's local (y-down) space.

// "4.2.37" -> true when the json needs the 4.2 runtime (4.2 and newer).
function needsRuntime42(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  return !!m && (Number(m[1]) > 4 || (Number(m[1]) === 4 && Number(m[2]) >= 2));
}

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

    let json = null;
    try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (e) { /* pixi-spine reports it below */ }
    const version = json && json.skeleton && json.skeleton.spine;
    if (needsRuntime42(version)) {
      const data42 = await SpineStage._loadSkeletonData42(json, atlasPath);
      SpineStage._cache.set(jsonPath, data42);
      return data42;
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

  // Spine 4.2: parse the atlas + json with the official runtime; page images go through
  // PIXI.Assets (same spine-asset:// protocol), without createImageBitmap so premultiplied pages
  // keep their alpha mode.
  static async _loadSkeletonData42(json, atlasPath) {
    const atlas = new S42.TextureAtlas(fs.readFileSync(atlasPath, 'utf-8'));
    const dir = path.dirname(atlasPath);
    PIXI.Assets.setPreferences({ preferCreateImageBitmap: false });
    try {
      for (const page of atlas.pages) {
        const src = toAssetUrl(path.join(dir, page.name));
        if (PIXI.Assets.cache.has(src)) await PIXI.Assets.unload(src); // re-read an image edited since
        const texture = await PIXI.Assets.load({ src, data: { alphaMode: page.pma ? PIXI.ALPHA_MODES.PMA : PIXI.ALPHA_MODES.UNPACK } });
        if (!texture || !texture.baseTexture) throw new Error('Không tải được ảnh ' + page.name);
        page.setTexture(S42.SpineTexture.from(texture.baseTexture));
      }
    } finally {
      PIXI.Assets.setPreferences({ preferCreateImageBitmap: true });
    }
    const data = new S42.SkeletonJson(new S42.AtlasAttachmentLoader(atlas)).readSkeletonData(json);
    data._rt42 = true;
    return data;
  }

  // Spine editor version the skeleton was exported from, e.g. "3.7.94" / "4.2.37".
  static dataVersion(spineData) {
    return (spineData && spineData.version) || '';
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
    let spine;
    if (spineData._rt42) {
      spine = new S42.Spine({ skeletonData: spineData, autoUpdate: false });
      spine.spineData = spineData; // same name pixi-spine uses
      spine._rt42 = true;
    } else {
      spine = new Spine(spineData);
    }
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
    // bone world coords are in the Spine display object's local space (already y-down); the
    // display object applies its own position + scale on top of that.
    return {
      x: spine.position.x + root.worldX * spine.scale.x,
      y: spine.position.y + root.worldY * spine.scale.y
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

  // Bone overlay (Properties > Bone): every bone as a Spine-style kite from its joint to its
  // tip, zero-length bones as a small ring. Drawn in screen space so it stays crisp at any zoom.
  drawBones(spine) {
    const g = this.overlayGfx;
    const sx = spine.scale.x * this.zoom, sy = spine.scale.y * this.zoom;
    const { width, height } = this._viewportSize();
    const ox = spine.position.x * this.zoom + width / 2 + this.panX;
    const oy = spine.position.y * this.zoom + height / 2 + this.panY;
    const FILL = 0xd9d9d9, EDGE = 0x1b1d21;
    for (const bone of spine.skeleton.bones) {
      if (bone.active === false) continue; // 4.x: bone of a skin that is not applied
      // world x axis of the bone: pixi-spine keeps it in bone.matrix (a, b), spine-core in (a, c)
      const ax = spine._rt42 ? bone.a : bone.matrix.a;
      const ay = spine._rt42 ? bone.c : bone.matrix.b;
      const x0 = ox + bone.worldX * sx, y0 = oy + bone.worldY * sy;
      const len = bone.data.length || 0;
      const dx = ax * len * sx, dy = ay * len * sy;
      const px = Math.hypot(dx, dy);
      if (px >= 4) {
        const ux = dx / px, uy = dy / px;
        const w = Math.max(1.5, Math.min(5, px * 0.09)); // half width of the kite
        const k = Math.min(px * 0.18, 12);               // where it is widest
        const mx = x0 + ux * k, my = y0 + uy * k;
        g.lineStyle({ width: 1, color: EDGE, alpha: 0.9, alignment: 0.5 });
        g.beginFill(FILL, 0.55);
        g.drawPolygon([x0, y0, mx - uy * w, my + ux * w, x0 + dx, y0 + dy, mx + uy * w, my - ux * w]);
        g.endFill();
      }
      g.lineStyle({ width: 1, color: EDGE, alpha: 0.9, alignment: 0.5 });
      g.beginFill(FILL, 0.9);
      g.drawCircle(x0, y0, px >= 4 ? 2 : 3);
      g.endFill();
    }
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
      // Root bone dead centre of the export canvas.
      spine.position.set(exportW / 2 - rx * s, exportH / 2 - ry * spine.scale.y);

      this.app.renderer.render(holder, { renderTexture, clear: true });
      return SpineStage._lightAwarePng(this.app.renderer, renderTexture, exportW, exportH);
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

  // Additive / screen slots only add colour and never write alpha (see _fixLightBlendAlpha), so
  // over the transparent export background their glow ends up as colour with alpha 0 — and a
  // normal un-premultiply throws it away (sparkles vanished from exported PNGs). Read the raw
  // premultiplied pixels instead and give every pixel alpha = max(alpha, r, g, b): normal pixels
  // are unchanged (premultiplied colour never exceeds alpha), and added light keeps exactly its
  // brightness as coverage, so the PNG over black looks like Spine's additive result.
  static _lightAwarePng(renderer, renderTexture, w, h) {
    const { pixels } = renderer.extract._rawPixels(renderTexture);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const out = img.data;
    const n = Math.min(out.length, pixels.length);
    for (let i = 0; i < n; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const a = Math.max(pixels[i + 3], r, g, b);
      if (a === 0) continue;
      const k = 255 / a;
      out[i] = Math.min(255, Math.round(r * k));
      out[i + 1] = Math.min(255, Math.round(g * k));
      out[i + 2] = Math.min(255, Math.round(b * k));
      out[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
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

  // `physicsDt` (4.2 only): seconds of playback this seek stands for. The Sequencer poses its
  // layers by time every frame, so while it plays it passes the frame's dt and physics keeps
  // simulating; a plain seek (scrub, first / last frame) leaves it 0 and physics is reset.
  static seek(spine, time, physicsDt = 0) {
    const entry = spine.state.tracks[0];
    if (!entry || !entry.animation) return;
    entry.trackTime = Math.max(0, Math.min(time, entry.animation.duration));
    SpineStage._applyPose(spine, physicsDt);
  }

  // Push the AnimationState's current times into the skeleton and the display object.
  // 4.2 physics is a simulation over time: with physicsDt > 0 it advances by that much, otherwise
  // the simulated bones are put back on the animated pose so nothing is left swinging from where
  // the playhead used to be.
  static _applyPose(spine, physicsDt = 0) {
    if (!spine._rt42) { spine.update(0); return; }
    spine.update(0);
    if (physicsDt > 0) {
      spine.skeleton.update(physicsDt);
      spine.skeleton.updateWorldTransform(S42.Physics.update);
    } else {
      spine.skeleton.updateWorldTransform(S42.Physics.reset);
    }
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
  static playBlend(spine, animNameA, timeA, animNameB, timeB, alpha, physicsDt = 0) {
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
    SpineStage._applyPose(spine, physicsDt);
  }
}

module.exports = { SpineStage, toAssetUrl, PIXI };
