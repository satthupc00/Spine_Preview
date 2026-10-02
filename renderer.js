const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { SpineStage } = require('./spine-stage.js');

// ---------------------------------------------------------------------------
// Library: validated json+atlas+png sets, keyed by full json path
// ---------------------------------------------------------------------------
const library = new Map();

function fileExists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// We no longer parse the atlas ourselves (pixi-spine does that) — we only need the page image
// filenames, to enforce the "exactly 1 atlas page" rule and to report a missing .png by name.
// In the libGDX format a page header is a non-indented line naming an image file; every region
// and property line is indented or contains a colon.
function listAtlasPages(text) {
  const pages = [];
  text.split(/\r\n|\r|\n/).forEach(line => {
    if (!line || line.startsWith(' ') || line.startsWith('\t')) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes(':')) return;
    if (/\.(png|jpg|jpeg|webp)$/i.test(trimmed)) pages.push(trimmed);
  });
  return pages;
}

// Expands a list of dropped paths (files and/or folders) into the .json files they contain.
// Folders are walked recursively (all sub-folders), files are kept only if they end in .json.
function collectJsonPaths(paths) {
  const result = [];
  function walk(p) {
    let stat;
    try { stat = fs.statSync(p); } catch (e) { return; }
    if (stat.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p); } catch (e) { return; }
      entries.forEach(name => walk(path.join(p, name)));
    } else if (stat.isFile() && p.toLowerCase().endsWith('.json')) {
      result.push(p);
    }
  }
  paths.forEach(walk);
  return result;
}

async function processJsonFile(jsonPath) {
  const key = jsonPath;
  if (library.has(key)) return library.get(key);

  const folder = path.dirname(jsonPath);
  const baseName = path.basename(jsonPath, '.json');
  const atlasPath = path.join(folder, baseName + '.atlas');

  const entry = { key, name: baseName, folder, jsonPath, atlasPath, valid: false, error: '', spineData: null };

  if (!fileExists(atlasPath)) {
    entry.error = `Thiếu file ${baseName}.atlas`;
    library.set(key, entry);
    return entry;
  }

  let atlasText;
  try {
    JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    entry.error = 'File json không hợp lệ';
    library.set(key, entry);
    return entry;
  }
  try {
    atlasText = fs.readFileSync(atlasPath, 'utf-8');
  } catch (e) {
    entry.error = 'File atlas không đọc được';
    library.set(key, entry);
    return entry;
  }

  const pages = listAtlasPages(atlasText);
  if (pages.length !== 1) {
    entry.error = `File ${baseName}.json có nhiều hơn 1 atlas`;
    library.set(key, entry);
    return entry;
  }
  if (!fileExists(path.join(folder, pages[0]))) {
    entry.error = `Thiếu file ảnh ${pages[0]}`;
    library.set(key, entry);
    return entry;
  }

  try {
    entry.spineData = await stage.loadSkeletonData(jsonPath, atlasPath);
  } catch (e) {
    entry.error = 'Không dựng được skeleton: ' + (e && e.message ? e.message : e);
    library.set(key, entry);
    return entry;
  }

  entry.valid = true;
  library.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Loading overlay — parsing a big .json/.atlas and decoding its .png can be heavy enough to
// freeze the UI for a moment (especially large-texture assets), which used to look like the app
// had silently done nothing. This gives visible feedback while that work runs.
// ---------------------------------------------------------------------------
const loadingOverlayEl = document.getElementById('loading-overlay');
const loadingTextEl = document.getElementById('loading-text');

// Double rAF: waits for the browser to actually paint (one rAF alone can still land before the
// paint that follows it), so the spinner is guaranteed on-screen before we run the synchronous
// parse/decode work that follows.
function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function processJsonPathsWithProgress(jsonPaths) {
  if (!jsonPaths.length) return [];
  loadingOverlayEl.hidden = false;
  const entries = [];
  try {
    for (let i = 0; i < jsonPaths.length; i++) {
      const p = jsonPaths[i];
      loadingTextEl.textContent = jsonPaths.length > 1
        ? `Đang tải ${i + 1}/${jsonPaths.length}: ${path.basename(p)}`
        : `Đang tải: ${path.basename(p)}`;
      await nextPaint();
      entries.push(await processJsonFile(p));
    }
  } finally {
    loadingOverlayEl.hidden = true;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const jsonListEl = document.getElementById('json-list');
const canvasWrap = document.getElementById('preview-canvas-wrap');
const emptyHint = document.getElementById('preview-empty-hint');
const marqueeBox = document.getElementById('marquee-box');
const animListEl = document.getElementById('anim-list');
const previewToolbarEl = document.querySelector('.preview-toolbar');
const zoomFlashEl = document.getElementById('zoom-flash');
const scrubBar = document.getElementById('scrub-bar');
const frameCounter = document.getElementById('frame-counter');

const bgColorEl = document.getElementById('bg-color');
const bgTransparentEl = document.getElementById('bg-transparent');
const skinSelectEl = document.getElementById('skin-select');
const scaleSliderEl = document.getElementById('scale-slider');
const scaleNumberEl = document.getElementById('scale-number');
const exportWEl = document.getElementById('export-w');
const exportHEl = document.getElementById('export-h');
const outputPathEl = document.getElementById('output-path');
const chooseOutputBtn = document.getElementById('choose-output-btn');
const exportBtn = document.getElementById('export-btn');
const exportStatusEl = document.getElementById('export-status');
const scrubBarWrapEl = document.getElementById('scrub-bar-wrap');
const deleteJsonBtn = document.getElementById('delete-json-btn');
const jsonListWrapEl = document.getElementById('json-list-wrap');
const jsonMarqueeBoxEl = document.getElementById('json-marquee-box');

// Tabs (Preview / Sequencer)
const tabBtnPreview = document.getElementById('tab-btn-preview');
const tabBtnSequencer = document.getElementById('tab-btn-sequencer');
const previewToolbarTabEl = document.getElementById('preview-toolbar-tab');
const sequencerToolbarTabEl = document.getElementById('sequencer-toolbar-tab');
const sequencerTimelineWrapEl = document.getElementById('sequencer-timeline-wrap');
const sequencerEmptyHintEl = document.getElementById('sequencer-empty-hint');

// Sequencer toolbar
const seqAnimListEl = document.getElementById('seq-anim-list');
const seqPlayBtn = document.getElementById('seq-play-btn');
const seqLoopBtn = document.getElementById('seq-loop-btn');
const seqLoopLocalBtn = document.getElementById('seq-loop-local-btn');

// Sequencer timeline DOM
const seqRulerScrollEl = document.getElementById('seq-ruler-scroll');
const seqRulerEl = document.getElementById('seq-ruler');
const seqRulerSpacerEl = document.getElementById('seq-ruler-spacer');
const seqVResizeEl = document.getElementById('seq-vresize');
const seqPlayheadRulerMarkerEl = document.getElementById('seq-playhead-ruler-marker');
const seqLoopRegionEl = document.getElementById('seq-loop-region');
const seqLoopStartMarkerEl = document.getElementById('seq-loop-start-marker');
const seqLoopEndMarkerEl = document.getElementById('seq-loop-end-marker');
const seqLayersListEl = document.getElementById('seq-layers-list');
const seqColResizerEl = document.getElementById('seq-col-resizer');
const seqBodyEl = document.getElementById('seq-body');
const seqTracksScrollEl = document.getElementById('seq-tracks-scroll');
const seqTracksListEl = document.getElementById('seq-tracks-list');

// Properties panel
const resetCenterBtn = document.getElementById('reset-center-btn');
const blendSectionEl = document.getElementById('blend-section');
const blendLabelEl = document.getElementById('blend-label');
const blendFramesLabelEl = document.getElementById('blend-frames-label');
const blendFramesEl = document.getElementById('blend-frames');
const blendUnitBtn = document.getElementById('blend-unit-btn');

// Preview scrub bar
const scrubPlayBtn = document.getElementById('scrub-play-btn');
const scrubUnitBtn = document.getElementById('scrub-unit-btn');

// Frame vs. seconds display — a toggle instead of showing both at once, kept per-panel since
// Preview's scrub counter and the Sequencer's blend overlap field are unrelated contexts.
let previewTimeUnit = 'frame'; // 'frame' | 'seconds'
let blendTimeUnit = 'frame';   // 'frame' | 'seconds'

let outputRoot = null;

// ---------------------------------------------------------------------------
// Stage (PIXI + pixi-spine)
// ---------------------------------------------------------------------------
const stage = new SpineStage(canvasWrap);

let instances = []; // { id, key, name, spine, x, y, scale, exportW, exportH, playing, bounds }
let nextInstanceId = 1;
let selection = [];

const view = { zoomPercent: 100, panX: 0, panY: 0 };

// Some skeletons (usually a specific mesh/IK/deform combo pixi-spine chokes on) can throw while
// being constructed or given their first animation. Before this guard, that exception happened
// to fall on renderer.js's own code path (not yet inside the rAF loop), so it was uncaught and
// silently swallowed by Electron — the json LOOKED like it loaded (it's in the Json List, the
// anim chips even populate from spineData directly) but nothing ever appeared on the canvas.
// Catching it here turns that into a visible red error entry instead of a mysteriously blank
// preview.
function markLibraryEntryRenderError(libEntry, e) {
  libEntry.valid = false;
  libEntry.error = 'Lỗi khi dựng hình: ' + (e && e.message ? e.message : e);
  console.error('[SpinePreview] Render error for', libEntry.name, e);
  renderJsonList();
}

function createInstance(libEntry, worldX, worldY) {
  let spine;
  try {
    spine = stage.createSpine(libEntry.spineData);
  } catch (e) {
    markLibraryEntryRenderError(libEntry, e);
    return null;
  }
  const inst = {
    id: nextInstanceId++,
    key: libEntry.key,
    name: libEntry.name,
    spine,
    x: worldX, y: worldY,
    scale: 1,
    exportW: 200, exportH: 200,
    playing: true
  };
  try {
    const names = SpineStage.animationNames(spine);
    if (names.length) SpineStage.play(spine, names[0]);
  } catch (e) {
    markLibraryEntryRenderError(libEntry, e);
  }
  applyInstanceTransform(inst);
  instances.push(inst);
  return inst;
}

function applyInstanceTransform(inst) {
  inst.spine.position.set(inst.x, inst.y);
  inst.spine.scale.set(inst.scale, inst.scale);
}

// Resets every symbol currently on the canvas back to world (0,0). Scoped to whichever tab is
// active: Preview's `instances` or the Sequencer's `seqLayers`.
resetCenterBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  if (activeTab === 'preview') {
    instances.forEach(inst => { inst.x = 0; inst.y = 0; applyInstanceTransform(inst); });
  } else {
    seqLayers.forEach(layer => {
      layer.x = 0; layer.y = 0;
      if (layer.spine) layer.spine.position.set(0, 0);
    });
  }
});

function destroyInstance(inst) {
  stage.removeSpine(inst.spine);
}

// ---------------------------------------------------------------------------
// Json List
// ---------------------------------------------------------------------------
let libSelection = [];
let draggingLibKeys = []; // one entry normally, or the whole Json List selection

function renderJsonList() {
  jsonListEl.innerHTML = '';
  libSelection = libSelection.filter(k => library.has(k));
  if (library.size === 0) {
    const hint = document.createElement('div');
    hint.className = 'drop-hint';
    hint.textContent = 'Kéo thả file .json hoặc cả folder vào đây';
    jsonListEl.appendChild(hint);
  } else {
    library.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'json-item' + (entry.valid ? '' : ' invalid') + (libSelection.includes(entry.key) ? ' selected' : '');
      item.textContent = entry.valid ? entry.name : `${entry.name} — ${entry.error}`;
      item.title = entry.jsonPath;
      item.dataset.key = entry.key;
      item.addEventListener('click', ev => {
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          if (libSelection.includes(entry.key)) libSelection = libSelection.filter(k => k !== entry.key);
          else libSelection.push(entry.key);
        } else {
          libSelection = [entry.key];
        }
        renderJsonList();
        jsonListEl.focus(); // cosmetic (shows keyboard focus is here); the capture-phase Delete
                             // handler above works regardless of where focus actually lands.
      });
      if (entry.valid) {
        item.draggable = true;
        item.addEventListener('dragstart', ev => {
          // Dragging a row that's part of the current selection drags the WHOLE selection;
          // dragging an unselected row drags just that one.
          const inSelection = libSelection.includes(entry.key);
          const keys = inSelection ? libSelection.slice() : [entry.key];
          draggingLibKeys = keys.filter(k => { const e = library.get(k); return e && e.valid; });
          ev.dataTransfer.effectAllowed = 'copy';
          try { ev.dataTransfer.setData('text/plain', draggingLibKeys.join('\n')); } catch (e) { /* ignore */ }
        });
        item.addEventListener('dragend', () => { draggingLibKeys = []; });
      }
      jsonListEl.appendChild(item);
    });
  }
  deleteJsonBtn.disabled = library.size === 0;
}

function deleteSelectedJson() {
  if (!libSelection.length) return;
  pushUndoSnapshot();
  libSelection.forEach(key => {
    instances = instances.filter(inst => {
      if (inst.key === key) {
        selection = selection.filter(id => id !== inst.id);
        destroyInstance(inst);
        return false;
      }
      return true;
    });
    // A Sequencer layer can never be empty/orphaned — if its json goes away, the layer goes too.
    seqLayers.slice().forEach(layer => { if (layer.key === key) seqDeleteLayer(layer.id); });
    library.delete(key);
    SpineStage.forgetSkeletonData(key);
  });
  libSelection = [];
  renderJsonList();
  updatePropertiesFromSelection();
}

// Xóa toàn bộ Json List — mọi instance trong Preview và mọi layer trong Sequencer đang tham
// chiếu tới các json này cũng bị xóa theo, không chỉ những cái đang được chọn trong list.
function deleteAllJson() {
  if (!library.size) return;
  pushUndoSnapshot();
  Array.from(library.keys()).forEach(key => {
    instances = instances.filter(inst => {
      if (inst.key === key) {
        selection = selection.filter(id => id !== inst.id);
        destroyInstance(inst);
        return false;
      }
      return true;
    });
    seqLayers.slice().forEach(layer => { if (layer.key === key) seqDeleteLayer(layer.id); });
    library.delete(key);
    SpineStage.forgetSkeletonData(key);
  });
  libSelection = [];
  renderJsonList();
  updatePropertiesFromSelection();
}

// Nút trên header luôn xóa TOÀN BỘ Json List; xóa riêng các mục đang chọn vẫn làm được bằng
// phím Delete/Backspace khi đang focus trong list (giữ lại deleteSelectedJson cho việc đó).
deleteJsonBtn.addEventListener('click', deleteAllJson);
jsonListEl.addEventListener('keydown', ev => {
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); deleteSelectedJson(); }
});

jsonListEl.addEventListener('dragover', ev => ev.preventDefault());
jsonListEl.addEventListener('drop', async ev => {
  ev.preventDefault();
  // Chấp nhận cả file .json lẫn cả folder (quét đệ quy mọi sub-folder bên trong) được kéo thả vào.
  const droppedPaths = Array.from(ev.dataTransfer.files || []).map(f => f.path).filter(Boolean);
  const jsonPaths = collectJsonPaths(droppedPaths);
  await processJsonPathsWithProgress(jsonPaths);
  renderJsonList();
});

// ---------------------------------------------------------------------------
// Json List: rê chuột chọn nhiều mục cùng lúc (marquee), giống kiểu chọn nhiều trong Preview.
// Chỉ bắt đầu marquee khi bấm chuột vào vùng trống của list (không phải lên 1 dòng json-item),
// để không đụng vào việc click/kéo-thả từng dòng đã có sẵn.
// ---------------------------------------------------------------------------
let jsonMarqueeActive = false;
let jsonMarqueeStart = null;

jsonListEl.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  if (ev.target.closest('.json-item')) return;
  jsonMarqueeActive = true;
  const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
  if (!additive) { libSelection = []; renderJsonList(); }
  const rect = jsonListWrapEl.getBoundingClientRect();
  jsonMarqueeStart = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  jsonMarqueeBoxEl.style.display = 'block';
  jsonMarqueeBoxEl.style.left = jsonMarqueeStart.x + 'px';
  jsonMarqueeBoxEl.style.top = jsonMarqueeStart.y + 'px';
  jsonMarqueeBoxEl.style.width = '0px';
  jsonMarqueeBoxEl.style.height = '0px';
});

window.addEventListener('mousemove', ev => {
  if (!jsonMarqueeActive) return;
  const rect = jsonListWrapEl.getBoundingClientRect();
  const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  jsonMarqueeBoxEl.style.left = Math.min(cur.x, jsonMarqueeStart.x) + 'px';
  jsonMarqueeBoxEl.style.top = Math.min(cur.y, jsonMarqueeStart.y) + 'px';
  jsonMarqueeBoxEl.style.width = Math.abs(cur.x - jsonMarqueeStart.x) + 'px';
  jsonMarqueeBoxEl.style.height = Math.abs(cur.y - jsonMarqueeStart.y) + 'px';
});

window.addEventListener('mouseup', ev => {
  if (!jsonMarqueeActive) return;
  jsonMarqueeActive = false;
  jsonMarqueeBoxEl.style.display = 'none';
  const rect = jsonListWrapEl.getBoundingClientRect();
  const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const x0 = Math.min(cur.x, jsonMarqueeStart.x), x1 = Math.max(cur.x, jsonMarqueeStart.x);
  const y0 = Math.min(cur.y, jsonMarqueeStart.y), y1 = Math.max(cur.y, jsonMarqueeStart.y);
  if (x1 - x0 > 3 || y1 - y0 > 3) {
    jsonListEl.querySelectorAll('.json-item').forEach(item => {
      const r = item.getBoundingClientRect();
      const ix0 = r.left - rect.left, iy0 = r.top - rect.top, ix1 = r.right - rect.left, iy1 = r.bottom - rect.top;
      const intersects = ix0 < x1 && ix1 > x0 && iy0 < y1 && iy1 > y0;
      if (intersects) {
        const key = item.dataset.key;
        if (key && !libSelection.includes(key)) libSelection.push(key);
      }
    });
    renderJsonList();
  }
});

// ---------------------------------------------------------------------------
// Preview: drop, select/drag, marquee, pan, zoom
// ---------------------------------------------------------------------------
function screenToWorld(clientX, clientY) {
  const rect = canvasWrap.getBoundingClientRect();
  return stage.screenToWorld(clientX - rect.left, clientY - rect.top);
}

canvasWrap.addEventListener('dragover', ev => {
  if (activeTab === 'preview') {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    return;
  }
  if (isTimelineTab() && draggingLibKeys.length) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }
});

// Instances dropped together are fanned out on a row so they don't land exactly on top of
// each other and become impossible to pick apart.
const MULTI_DROP_GAP = 220;

function dropEntriesAt(entries, clientX, clientY) {
  const valid = entries.filter(e => e && e.valid);
  if (!valid.length) return;
  pushUndoSnapshot();
  const world = screenToWorld(clientX, clientY);
  const startX = world.x - ((valid.length - 1) * MULTI_DROP_GAP) / 2;
  selection = [];
  valid.forEach((entry, i) => {
    const inst = createInstance(entry, startX + i * MULTI_DROP_GAP, world.y);
    if (inst) selection.push(inst.id);
  });
  updatePropertiesFromSelection();
}

canvasWrap.addEventListener('drop', async ev => {
  if (isTimelineTab()) {
    ev.preventDefault();
    const world = screenToWorld(ev.clientX, ev.clientY);
    // .json files (or folders — quét đệ quy) dragged in from Explorer/Finder onto the Sequencer
    // viewport — same folder-scan as the Preview tab, and all of them land together, fanned out
    // around the drop point.
    const droppedPaths = Array.from(ev.dataTransfer.files || []).map(f => f.path).filter(Boolean);
    const jsonPaths = collectJsonPaths(droppedPaths);
    if (jsonPaths.length) {
      const entries = await processJsonPathsWithProgress(jsonPaths);
      renderJsonList();
      seqAddLayersAt(entries.filter(e => e && e.valid).map(e => e.key), world.x, world.y);
      return;
    }
    if (!draggingLibKeys.length) return;
    const keys = draggingLibKeys.slice();
    draggingLibKeys = [];
    seqAddLayersAt(keys, world.x, world.y);
    return;
  }

  if (activeTab !== 'preview') return;
  ev.preventDefault();

  // (a) .json files (or folders — quét đệ quy) dragged in from Explorer/Finder — register them
  // in the Json List first, then drop them straight onto the stage.
  const droppedPaths = Array.from(ev.dataTransfer.files || []).map(f => f.path).filter(Boolean);
  const jsonPaths = collectJsonPaths(droppedPaths);
  if (jsonPaths.length) {
    const entries = await processJsonPathsWithProgress(jsonPaths);
    renderJsonList();
    dropEntriesAt(entries, ev.clientX, ev.clientY);
    return;
  }

  // (b) one or more rows dragged from the Json List
  if (!draggingLibKeys.length) return;
  const entries = draggingLibKeys.map(k => library.get(k));
  draggingLibKeys = [];
  dropEntriesAt(entries, ev.clientX, ev.clientY);
});

let draggingInstance = null;
let dragStart = null;
let panning = false;
let panStart = null;
let marqueeActive = false;
let marqueeStart = null;

canvasWrap.addEventListener('mousedown', ev => {
  if (ev.button === 1 || ev.button === 2) { // middle OR right button: pan (works in both tabs)
    ev.preventDefault();
    panning = true;
    panStart = { x: ev.clientX, y: ev.clientY, ox: view.panX, oy: view.panY };
    return;
  }
  if (ev.button !== 0) return;

  if (isTimelineTab()) { seqCanvasMouseDown(ev); return; }

  const world = screenToWorld(ev.clientX, ev.clientY);
  const hit = hitTestInstance(world.x, world.y);
  canvasWrap.focus();
  if (hit) {
    selectInstance(hit.id, ev.shiftKey);
    pushUndoSnapshot();
    draggingInstance = hit;
    dragStart = { x: ev.clientX, y: ev.clientY, ox: hit.x, oy: hit.y };
  } else {
    if (!ev.shiftKey) { selection = []; updatePropertiesFromSelection(); }
    marqueeActive = true;
    const rect = canvasWrap.getBoundingClientRect();
    marqueeStart = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    marqueeBox.style.display = 'block';
    marqueeBox.style.left = marqueeStart.x + 'px';
    marqueeBox.style.top = marqueeStart.y + 'px';
    marqueeBox.style.width = '0px';
    marqueeBox.style.height = '0px';
  }
});

window.addEventListener('mousemove', ev => {
  if (panning) {
    view.panX = panStart.ox + (ev.clientX - panStart.x);
    view.panY = panStart.oy + (ev.clientY - panStart.y);
    return;
  }
  if (draggingInstance) {
    const z = view.zoomPercent / 100;
    draggingInstance.x = dragStart.ox + (ev.clientX - dragStart.x) / z;
    draggingInstance.y = dragStart.oy + (ev.clientY - dragStart.y) / z;
    applyInstanceTransform(draggingInstance);
    return;
  }
  if (seqDraggingLayerInst) {
    const z = view.zoomPercent / 100;
    seqDraggingLayerInst.x = seqDragInstStart.ox + (ev.clientX - seqDragInstStart.x) / z;
    seqDraggingLayerInst.y = seqDragInstStart.oy + (ev.clientY - seqDragInstStart.y) / z;
    seqDraggingLayerInst.spine.position.set(seqDraggingLayerInst.x, seqDraggingLayerInst.y);
    return;
  }
  if (marqueeActive) {
    const rect = canvasWrap.getBoundingClientRect();
    const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    marqueeBox.style.left = Math.min(cur.x, marqueeStart.x) + 'px';
    marqueeBox.style.top = Math.min(cur.y, marqueeStart.y) + 'px';
    marqueeBox.style.width = Math.abs(cur.x - marqueeStart.x) + 'px';
    marqueeBox.style.height = Math.abs(cur.y - marqueeStart.y) + 'px';
  }
});

window.addEventListener('mouseup', ev => {
  if (marqueeActive) {
    const rect = canvasWrap.getBoundingClientRect();
    const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const x0 = Math.min(cur.x, marqueeStart.x), x1 = Math.max(cur.x, marqueeStart.x);
    const y0 = Math.min(cur.y, marqueeStart.y), y1 = Math.max(cur.y, marqueeStart.y);
    if (x1 - x0 > 3 || y1 - y0 > 3) {
      instances.forEach(inst => {
        const p = stage.worldToScreen(inst.x, inst.y);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && !selection.includes(inst.id)) {
          selection.push(inst.id);
        }
      });
      updatePropertiesFromSelection();
    }
    marqueeActive = false;
    marqueeBox.style.display = 'none';
  }
  panning = false;
  draggingInstance = null;
  seqDraggingLayerInst = null;
});

// Uses the real rendered bounds reported by PIXI, so the clickable area matches what you see.
function hitTestInstance(wx, wy) {
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    const b = inst.bounds;
    if (b && wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY) return inst;
  }
  return null;
}

canvasWrap.addEventListener('wheel', ev => {
  ev.preventDefault();
  const dir = ev.deltaY < 0 ? 1 : -1;
  const before = view.zoomPercent;
  const after = Math.min(300, Math.max(10, before + dir * 10));
  if (after === before) return;

  // Zoom toward the cursor: keep the world point under the mouse pinned to the same screen pixel.
  const rect = canvasWrap.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const cx = rect.width / 2, cy = rect.height / 2;
  const zb = before / 100, za = after / 100;
  const worldX = (mx - cx - view.panX) / zb;
  const worldY = (my - cy - view.panY) / zb;
  view.panX = mx - cx - worldX * za;
  view.panY = my - cy - worldY * za;

  view.zoomPercent = after;
  flashZoomIndicator();
}, { passive: false });

canvasWrap.addEventListener('contextmenu', ev => ev.preventDefault());

function deleteSelectedInstances() {
  if (!selection.length) return;
  pushUndoSnapshot();
  instances = instances.filter(inst => {
    if (selection.includes(inst.id)) { destroyInstance(inst); return false; }
    return true;
  });
  selection = [];
  updatePropertiesFromSelection();
}

canvasWrap.addEventListener('keydown', ev => {
  if (activeTab !== 'preview') return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelectedInstances(); return; }
  // '+' and '-' — accept the main row and the numpad, with or without Shift.
  if (ev.key === '+' || ev.key === '=' || ev.code === 'NumpadAdd') { ev.preventDefault(); moveSelectionLayer(+1); return; }
  if (ev.key === '-' || ev.key === '_' || ev.code === 'NumpadSubtract') { ev.preventDefault(); moveSelectionLayer(-1); return; }
  if (ev.key === 'Home') { ev.preventDefault(); rewindSelectionToStart(); }
});

// ---------------------------------------------------------------------------
// Layer order: `instances` is back-to-front, index 0 painted first. + / - move the whole
// selection one step toward the front / back. Moving a multi-selection keeps the selected
// instances' relative order intact, and stops as a block once the outermost one hits the end.
// ---------------------------------------------------------------------------
function moveSelectionLayer(delta) {
  if (!selection.length) return;
  pushUndoSnapshot();
  const idxs = instances
    .map((inst, i) => (selection.includes(inst.id) ? i : -1))
    .filter(i => i >= 0);
  if (!idxs.length) return;

  if (delta > 0) {
    if (idxs[idxs.length - 1] >= instances.length - 1) return; // already frontmost
    for (let k = idxs.length - 1; k >= 0; k--) {
      const i = idxs[k];
      [instances[i], instances[i + 1]] = [instances[i + 1], instances[i]];
    }
  } else {
    if (idxs[0] <= 0) return; // already backmost
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      [instances[i], instances[i - 1]] = [instances[i - 1], instances[i]];
    }
  }
  stage.applyLayerOrder(instances.map(i => i.spine));
}

// ---------------------------------------------------------------------------
// Home: rewind every selected instance to frame 1 and leave it paused there.
// ---------------------------------------------------------------------------
function rewindSelectionToStart() {
  const targets = getSelectedInstances();
  if (!targets.length) return;
  targets.forEach(inst => {
    SpineStage.seek(inst.spine, 0);
    inst.playing = false;
  });
  updateScrubUI();
}

function selectInstance(id, additive) {
  if (additive) {
    if (!selection.includes(id)) selection.push(id);
    else selection = selection.filter(sid => sid !== id);
  } else {
    selection = [id];
  }
  updatePropertiesFromSelection();
}

function getSelectedInstances() { return instances.filter(i => selection.includes(i.id)); }

// ---------------------------------------------------------------------------
// Animation list
// ---------------------------------------------------------------------------
function getFocusedInstance() {
  const sel = getSelectedInstances();
  if (sel.length === 1) return sel[0];
  if (sel.length === 0 && instances.length === 1) return instances[0];
  return null;
}

function renderAnimList() {
  animListEl.innerHTML = '';
  const inst = getFocusedInstance();
  if (inst) {
    const label = document.createElement('div');
    label.className = 'anim-owner';
    label.textContent = inst.name;
    label.title = inst.name;
    animListEl.appendChild(label);

    const current = SpineStage.currentAnimation(inst.spine);
    SpineStage.animationNames(inst.spine).forEach(name => {
      const chip = document.createElement('div');
      chip.className = 'anim-chip' + (current === name ? ' active' : '');
      chip.textContent = name;
      chip.addEventListener('click', () => {
        SpineStage.play(inst.spine, name);
        inst.playing = true;
        renderAnimList();
      });
      animListEl.appendChild(chip);
    });
  }
  updateToolbarHeight();
}

// The toolbar is absolutely positioned over the preview, so it sizes itself to however many rows
// the chips wrap onto and the canvas below never moves. Nothing left to compute here.
function updateToolbarHeight() {}

// ---------------------------------------------------------------------------
// Skin selector (Properties panel) — same "single focused instance" rule as the anim list,
// since skins are read from a skeleton's own spineData and don't make sense applied in bulk
// across differently-rigged instances.
// ---------------------------------------------------------------------------
function updateSkinSelect() {
  const inst = getFocusedInstance();
  skinSelectEl.innerHTML = '';

  if (!inst) {
    skinSelectEl.disabled = true;
    return;
  }

  const names = SpineStage.skinNames(inst.spine);
  if (!names.length) {
    skinSelectEl.disabled = true;
    return;
  }

  const current = SpineStage.currentSkin(inst.spine);
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    skinSelectEl.appendChild(opt);
  });
  // Only one skin available (the common case: a skeleton with just "default") — still show it,
  // but there's nothing to switch to, so disable the control.
  skinSelectEl.disabled = names.length < 2;
}

skinSelectEl.addEventListener('change', () => {
  const inst = getFocusedInstance();
  if (!inst) return;
  pushUndoSnapshot();
  SpineStage.setSkin(inst.spine, skinSelectEl.value);
});

// ---------------------------------------------------------------------------
// Properties panel
// ---------------------------------------------------------------------------
function updatePropertiesFromSelection() {
  const sel = getSelectedInstances();
  renderAnimList();
  updateSkinSelect();

  if (sel.length === 0) {
    scaleSliderEl.disabled = true;
    scaleNumberEl.disabled = true;
    scaleNumberEl.value = '';
    exportWEl.disabled = true;
    exportHEl.disabled = true;
    exportBtn.disabled = true;
    return;
  }

  scaleSliderEl.disabled = false;
  scaleNumberEl.disabled = false;
  const scales = sel.map(i => Math.round(i.scale * 100));
  if (scales.every(s => s === scales[0])) {
    scaleSliderEl.value = scales[0];
    scaleNumberEl.value = scales[0];
  } else {
    scaleNumberEl.value = '';
  }

  exportWEl.disabled = false;
  exportHEl.disabled = false;
  const ws = sel.map(i => i.exportW);
  const hs = sel.map(i => i.exportH);
  exportWEl.value = ws.every(w => w === ws[0]) ? ws[0] : '';
  exportHEl.value = hs.every(h => h === hs[0]) ? hs[0] : '';
  exportBtn.disabled = !outputRoot;
}

function applyScale(v) {
  const val = Math.max(10, Math.min(400, v)) / 100;
  getSelectedInstances().forEach(i => { i.scale = val; applyInstanceTransform(i); });
  scaleSliderEl.value = Math.round(val * 100);
  scaleNumberEl.value = Math.round(val * 100);
}

scaleSliderEl.addEventListener('mousedown', () => pushUndoSnapshot());
scaleSliderEl.addEventListener('input', () => applyScale(parseInt(scaleSliderEl.value, 10)));

function commitScaleNumber() {
  const v = parseInt(scaleNumberEl.value, 10);
  if (Number.isNaN(v)) { updatePropertiesFromSelection(); return; }
  pushUndoSnapshot();
  applyScale(v);
}
scaleNumberEl.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { commitScaleNumber(); scaleNumberEl.blur(); }
});
scaleNumberEl.addEventListener('blur', commitScaleNumber);

exportWEl.addEventListener('input', () => {
  const v = parseInt(exportWEl.value, 10) || 1;
  getSelectedInstances().forEach(i => { i.exportW = v; });
});
exportHEl.addEventListener('input', () => {
  const v = parseInt(exportHEl.value, 10) || 1;
  getSelectedInstances().forEach(i => { i.exportH = v; });
});

chooseOutputBtn.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('choose-output-folder');
  if (dir) {
    outputRoot = dir;
    outputPathEl.value = dir;
    updatePropertiesFromSelection();
  }
});

exportBtn.addEventListener('click', async () => {
  const sel = getSelectedInstances();
  if (!sel.length || !outputRoot) return;
  exportStatusEl.textContent = 'Đang xuất...';
  let ok = 0, fail = 0;
  for (const inst of sel) {
    try {
      const dataUrl = stage.extractInstancePng(inst.spine, inst.exportW, inst.exportH);
      const subFolder = path.basename(library.get(inst.key).folder);
      const res = await ipcRenderer.invoke('export-png', { outputRoot, subFolder, fileName: inst.name, dataUrl });
      if (res.ok) ok++; else fail++;
    } catch (e) {
      fail++;
    }
  }
  exportStatusEl.textContent = `Xuất xong: ${ok} thành công${fail ? ', ' + fail + ' lỗi' : ''}`;
});

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------
function applyBackground() {
  const transparent = bgTransparentEl.checked;
  canvasWrap.classList.toggle('checkerboard', transparent);
  // Solid colour is a plain CSS background behind the transparent WebGL canvas; the checkerboard
  // class supplies its own background-image, so clear the inline colour in that mode.
  canvasWrap.style.backgroundColor = transparent ? '' : bgColorEl.value;
}
bgColorEl.addEventListener('input', applyBackground);
bgTransparentEl.addEventListener('change', applyBackground);
applyBackground();

function contrastStrokeColor() {
  let r, g, b;
  if (bgTransparentEl.checked) {
    r = g = b = 0x33; // the checkerboard averages out dark
  } else {
    const hex = bgColorEl.value;
    r = parseInt(hex.substr(1, 2), 16);
    g = parseInt(hex.substr(3, 2), 16);
    b = parseInt(hex.substr(5, 2), 16);
  }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? 0x000000 : 0xffffff;
}

// ---------------------------------------------------------------------------
// Sequencer: assemble clips (json + anim) on layers along a shared timeline and play them back
// together. Runs on the SAME PIXI stage/canvas as Preview (so the app doesn't need a second
// WebGL context), but every Spine instance here is its own — created and owned by a layer,
// never one of Preview's `instances`. Only one tab's instances are ever parented under
// `stage.content` at a time; switching tabs detaches one set and attaches the other.
//
// Dropping a json (from Json List, or straight from Explorer/Finder) anywhere in the Sequencer —
// the timeline's "+ add layer" zone or the canvas viewport — creates a layer AND immediately
// adds a clip for its first animation. The selected layer's full anim list shows in the toolbar
// (same slot as Preview's chips); drag one of those chips onto a layer that shares that json to
// add more clips, or click a chip while a clip is selected to swap that clip to a different anim.
//
// Clips never push each other — dropping/dragging onto an occupied spot is simply rejected, and
// close edges magnetically snap together instead.
//
// layer = { id, key, spine, x, y, hidden, clips, _activeClipId, _bounds }
// clip  = { id, animName, baseDuration (one loop, seconds), loopCount (>=1), start (seconds) }
//         effective duration = baseDuration * loopCount
// ---------------------------------------------------------------------------
let activeTab = 'preview';
// Sequencer used to be a separate, non-overlapping-only tab with a second "Mixer" tab layered on
// top for crossfades. They've since merged: Sequencer now allows two clips on the same layer to
// overlap directly (that overlap IS the blend region, editable from the Properties panel) — kept
// as its own helper in case a third timeline-ish tab shows up later.
function isTimelineTab() { return activeTab === 'sequencer'; }
let seqLayers = [];
let seqNextLayerId = 1;
let seqNextClipId = 1;
let seqSelectedLayerId = null;
let seqSelectedClip = null; // { layerId, clipId }
let seqPlayhead = 0;        // seconds
let seqPlaying = false;
let seqPxPerSec = 100;
let seqLoopEnabled = true;
let seqLoopStart = 0;
let seqLoopEnd = null; // null = tracks total duration live
// Loop Locally: normally every layer reads the SAME global seqPlayhead, so a layer whose clips
// only cover the first 2s of a 10s timeline just sits idle (or invisible) for the other 8s until
// the whole timeline loops back around. With this on, each layer instead wraps the playhead by its
// OWN clip-list length, so it keeps looping its own short sequence continuously regardless of how
// long other layers (or the global loop region) are.
let seqLoopLocally = false;
let seqLayerColWidth = 230; // px, user-resizable via #seq-col-resizer (wide enough for the play/Loop/Loop Locally buttons)

let seqDraggingClip = null;      // { layer, clip, startClientX, origStart }
let seqResizingClip = null;      // { layer, clip, startClientX, origLoopCount }
let seqScrubbing = false;
let seqDraggingAnim = null;      // { key, animName, duration } — set while dragging a chip
let seqDraggingLayerInst = null; // the seqLayer object whose canvas instance is being repositioned
let seqDragInstStart = null;
let seqLayerDragState = null;    // { layerId, startY, originIndex, currentIndex, rowHeight }
let seqDraggingLoopMarker = null; // 'start' | 'end'
let seqColResizing = null;
let seqTimelinePanning = null;

const SEQ_SNAP_PX = 8;
const SEQ_FPS = 30; // matches the frame-counter's assumption elsewhere in the app

function seqClipEffectiveDuration(clip) { return clip.baseDuration * clip.loopCount; }

function seqTotalDuration() {
  let max = 0;
  seqLayers.forEach(l => l.clips.forEach(c => { max = Math.max(max, c.start + seqClipEffectiveDuration(c)); }));
  return max;
}

// Same idea as seqTotalDuration() but scoped to one layer — its own list of clips looped back to
// back, ignoring every other layer's length. Used by Loop Locally.
function seqLayerLocalDuration(layer) {
  let max = 0;
  layer.clips.forEach(c => { max = Math.max(max, c.start + seqClipEffectiveDuration(c)); });
  return max;
}

function seqEffectiveLoopEnd() { return seqLoopEnd != null ? seqLoopEnd : seqTotalDuration(); }

function seqNiceStep(pxPerSec) {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120];
  for (const c of candidates) if (c * pxPerSec >= 50) return c;
  return candidates[candidates.length - 1];
}

function seqContentWidth() {
  const minWidth = seqTracksScrollEl.clientWidth || 400;
  return Math.max(minWidth, (seqTotalDuration() + 5) * seqPxPerSec);
}

function clientXToSeqTime(clientX) {
  const rect = seqTracksScrollEl.getBoundingClientRect();
  const localX = clientX - rect.left + seqTracksScrollEl.scrollLeft;
  return Math.max(0, localX / seqPxPerSec);
}

// Render order of layers follows child order of `content` (back-to-front). Layer 0 in the UI
// list (top row) is the front-most, matching how most timeline editors stack tracks.
function seqApplyLayerRenderOrder() {
  const spines = seqLayers.slice().reverse().map(l => l.spine).filter(Boolean);
  stage.applyLayerOrder(spines);
}

function seqCreateLayer(key) {
  const entry = library.get(key);
  const layer = { id: seqNextLayerId++, key, spine: null, x: 0, y: 0, hidden: false, clips: [], _activeClipId: null, _bounds: null };
  if (entry && entry.spineData) {
    try {
      layer.spine = stage.createSpine(entry.spineData); // parented under stage.content immediately
      layer.spine.position.set(0, 0);
      layer.spine.visible = false; // becomes visible once a clip covers the playhead
    } catch (e) {
      layer.spine = null;
      markLibraryEntryRenderError(entry, e);
    }
  }
  seqLayers.unshift(layer);
  seqApplyLayerRenderOrder();
  return layer;
}

// Dropping a json straight onto the Sequencer viewport OR the "+ add layer" zone both create the
// layer AND immediately add a clip for its first animation, starting at frame 0. `worldX`/`worldY`
// place the layer's instance where it was actually dropped (defaulting to the origin for drop
// targets, like the "+ add layer" zone, that have no meaningful canvas position).
function seqCreateLayerAt(key, worldX, worldY) {
  const entry = library.get(key);
  if (!entry || !entry.valid || !entry.spineData || !entry.spineData.animations.length) return null;
  const layer = seqCreateLayer(key);
  layer.x = worldX;
  layer.y = worldY;
  if (layer.spine) layer.spine.position.set(worldX, worldY);
  const first = entry.spineData.animations[0];
  const clip = { id: seqNextClipId++, animName: first.name, baseDuration: Math.max(first.duration, 0.0333), loopCount: 1, start: 0 };
  layer.clips.push(clip);
  return layer;
}

// Several jsons dropped together are fanned out on a row (same MULTI_DROP_GAP spacing as the
// Preview tab's dropEntriesAt) so their instances don't all land stacked on top of each other.
function seqAddLayersAt(keys, worldX = 0, worldY = 0) {
  const valid = keys.filter(k => { const e = library.get(k); return e && e.valid && e.spineData && e.spineData.animations.length; });
  if (!valid.length) return;
  pushUndoSnapshot();
  const startX = worldX - ((valid.length - 1) * MULTI_DROP_GAP) / 2;
  let lastLayer = null;
  valid.forEach((key, i) => {
    lastLayer = seqCreateLayerAt(key, startX + i * MULTI_DROP_GAP, worldY);
  });
  if (lastLayer) seqSelectClip(lastLayer.id, lastLayer.clips[lastLayer.clips.length - 1].id);
}

function seqAddLayerWithFirstAnim(key) {
  seqAddLayersAt([key], 0, 0);
}

function seqDeleteLayer(layerId) {
  const idx = seqLayers.findIndex(l => l.id === layerId);
  if (idx < 0) return;
  const layer = seqLayers[idx];
  if (layer.spine) stage.removeSpine(layer.spine);
  seqLayers.splice(idx, 1);
  if (seqSelectedClip && seqSelectedClip.layerId === layerId) seqSelectedClip = null;
  if (seqSelectedLayerId === layerId) seqSelectedLayerId = null;
  if (seqSelectedBlend && seqSelectedBlend.layerId === layerId) seqSelectedBlend = null;
  seqApplyLayerRenderOrder();
  renderSeqAnimList();
  renderSeqTimeline();
  updateSeqBlendProperties();
}

// Free placement, no pushing: moves the clip to `desiredStart` if that spot is clear on this
// layer; otherwise leaves it exactly where it was. Returns whether the move happened.
function seqPlaceClip(layer, clipId, desiredStart) {
  const clip = layer.clips.find(c => c.id === clipId);
  if (!clip) return false;
  // Two clips on a layer are allowed to overlap on purpose (that's the blend region), so there's
  // no conflict rejection here — it always moves to where it was dropped.
  clip.start = Math.max(0, desiredStart);
  return true;
}

// Magnetic snapping: while dragging, if a clip edge (start or end) lands within a few pixels of
// another clip's edge (on any layer — useful for lining up timing across layers), snap to it
// exactly. Falls back to the raw position if nothing is close enough.
// Magnetic snapping: while dragging, if a clip edge (start or end) lands within a few pixels of
// another clip's edge (on any layer — useful for lining up timing across layers), snap to it
// exactly. Falls back to the raw position if nothing is close enough. All 4 edge pairings are
// checked — start-to-start, end-to-end, and critically start-to-end / end-to-start (so a clip
// dragged from before a neighbour to after it — or vice versa — still snaps flush against it).
function seqSnapStart(clip, desiredStart) {
  const dur = seqClipEffectiveDuration(clip);
  const snapDistSec = SEQ_SNAP_PX / seqPxPerSec;
  let best = desiredStart, bestDist = snapDistSec;
  seqLayers.forEach(l => {
    l.clips.forEach(c => {
      if (c.id === clip.id) return;
      const cDur = seqClipEffectiveDuration(c);
      [c.start, c.start + cDur, c.start - dur, c.start + cDur - dur].forEach(cand => {
        const dist = Math.abs(cand - desiredStart);
        if (dist < bestDist) { bestDist = dist; best = cand; }
      });
    });
  });
  return Math.max(0, best);
}

// Inserting a brand new clip (from an anim-chip drop): places it at the requested spot if free;
// otherwise appends it right after the layer's last clip, so a drop never silently fails.
function seqInsertClip(layer, clip, desiredStart) {
  // Dropping an anim chip onto an occupied spot IS the point (that's how you create a blend) — it
  // always lands exactly where dropped.
  clip.start = Math.max(0, desiredStart);
  layer.clips.push(clip);
  layer.clips.sort((a, b) => a.start - b.start);
}

function seqDeleteClip(layerId, clipId) {
  const layer = seqLayers.find(l => l.id === layerId);
  if (!layer) return;
  layer.clips = layer.clips.filter(c => c.id !== clipId);
  if (seqSelectedClip && seqSelectedClip.clipId === clipId) seqSelectedClip = null;
  if (seqSelectedBlend && (seqSelectedBlend.clipAId === clipId || seqSelectedBlend.clipBId === clipId)) seqSelectedBlend = null;
  // A layer can never sit empty — deleting its last clip removes the layer itself.
  if (layer.clips.length === 0) { seqDeleteLayer(layerId); return; }
  renderSeqTimeline();
  updateSeqBlendProperties();
}

// Swaps the selected clip's animation for a different one from the same json (triggered by
// clicking an anim chip while a clip is selected). Rejected if the new duration would overlap a
// neighbour — nothing pushes.
function seqSwapSelectedClipAnim(animName, animDuration) {
  if (!seqSelectedClip) return;
  const layer = seqLayers.find(l => l.id === seqSelectedClip.layerId);
  if (!layer) return;
  const clip = layer.clips.find(c => c.id === seqSelectedClip.clipId);
  if (!clip) return;
  clip.animName = animName;
  clip.baseDuration = Math.max(animDuration, 0.0333);
  clip.loopCount = 1;
  renderSeqTimeline();
}

// ---- selected layer & its anim list (shown in the toolbar, same slot as Preview's chips) ----
// A clip is always paired with its layer: selecting one selects the other, so the two selection
// states can never point at different layers.
function seqSelectLayer(layerId) {
  seqSelectedLayerId = layerId;
  if (!seqSelectedClip || seqSelectedClip.layerId !== layerId) seqSelectedClip = null;
  seqSelectedBlend = null;
  updateSeqBlendProperties();
  renderSeqAnimList();
  renderSeqTimeline();
}

function seqSelectClip(layerId, clipId) {
  seqSelectedClip = { layerId, clipId };
  seqSelectedLayerId = layerId;
  seqSelectedBlend = null;
  updateSeqBlendProperties();
  renderSeqAnimList();
  renderSeqTimeline();
}

// ---- Blend: the overlap between two consecutive clips on the same layer, selectable/editable ---
let seqSelectedBlend = null; // { layerId, clipAId, clipBId }

function seqFindBlend(sel) {
  if (!sel) return null;
  const layer = seqLayers.find(l => l.id === sel.layerId);
  if (!layer) return null;
  const a = layer.clips.find(c => c.id === sel.clipAId);
  const b = layer.clips.find(c => c.id === sel.clipBId);
  if (!a || !b) return null;
  const aEnd = a.start + seqClipEffectiveDuration(a);
  const overlapSec = aEnd - b.start;
  if (overlapSec <= 1e-4) return null;
  return { layer, a, b, overlapSec };
}

function seqSelectBlend(layerId, clipAId, clipBId) {
  seqSelectedBlend = { layerId, clipAId, clipBId };
  seqSelectedClip = null;
  seqSelectedLayerId = layerId;
  renderSeqAnimList();
  renderSeqTimeline();
  updateSeqBlendProperties();
}

function updateSeqBlendProperties() {
  const found = seqFindBlend(seqSelectedBlend);
  blendSectionEl.hidden = !found;
  if (!found) return;
  blendLabelEl.textContent = `${found.a.animName} → ${found.b.animName}`;
  blendLabelEl.title = blendLabelEl.textContent;
  if (document.activeElement !== blendFramesEl) {
    if (blendTimeUnit === 'seconds') {
      blendFramesLabelEl.textContent = 'Số giây giao nhau';
      blendFramesEl.step = '0.01';
      blendFramesEl.value = found.overlapSec.toFixed(2);
    } else {
      blendFramesLabelEl.textContent = 'Số frame giao nhau';
      blendFramesEl.step = '1';
      blendFramesEl.value = Math.round(found.overlapSec * SEQ_FPS);
    }
  }
}

blendUnitBtn.addEventListener('click', () => {
  blendTimeUnit = blendTimeUnit === 'frame' ? 'seconds' : 'frame';
  blendUnitBtn.textContent = blendTimeUnit === 'seconds' ? 's' : 'F';
  updateSeqBlendProperties();
});

blendFramesEl.addEventListener('change', () => {
  const found = seqFindBlend(seqSelectedBlend);
  if (!found) return;
  const { layer, a, b } = found;
  const aEnd = a.start + seqClipEffectiveDuration(a);
  const maxFrames = Math.floor(Math.min(seqClipEffectiveDuration(a), seqClipEffectiveDuration(b)) * SEQ_FPS);
  const enteredFrames = blendTimeUnit === 'seconds'
    ? (Number(blendFramesEl.value) || 0) * SEQ_FPS
    : (Number(blendFramesEl.value) || 0);
  const frames = Math.max(0, Math.min(maxFrames, Math.round(enteredFrames)));
  pushUndoSnapshot();
  b.start = Math.max(0, aEnd - frames / SEQ_FPS);
  layer.clips.sort((c1, c2) => c1.start - c2.start);
  renderSeqTimeline();
  updateSeqBlendProperties();
});

function renderSeqAnimList() {
  seqAnimListEl.innerHTML = '';
  const layer = seqLayers.find(l => l.id === seqSelectedLayerId);
  if (!layer) return;
  const entry = library.get(layer.key);
  if (!entry || !entry.spineData) return;

  const label = document.createElement('div');
  label.className = 'anim-owner';
  label.textContent = entry.name;
  label.title = entry.name;
  seqAnimListEl.appendChild(label);

  entry.spineData.animations.forEach(a => {
    const chip = document.createElement('div');
    chip.className = 'anim-chip seq-anim-chip selectable';
    chip.textContent = a.name;
    chip.draggable = true;
    chip.title = seqSelectedClip
      ? 'Kéo xuống timeline để thêm clip, hoặc bấm để đổi anim của clip đang chọn'
      : 'Kéo xuống timeline của layer để thêm clip';
    chip.addEventListener('dragstart', ev => {
      seqDraggingAnim = { key: layer.key, animName: a.name, duration: Math.max(a.duration, 0.0333) };
      ev.dataTransfer.effectAllowed = 'copy';
      try { ev.dataTransfer.setData('text/plain', a.name); } catch (e) { /* ignore */ }
    });
    chip.addEventListener('dragend', () => { seqDraggingAnim = null; });
    chip.addEventListener('click', () => {
      if (seqSelectedClip) { pushUndoSnapshot(); seqSwapSelectedClipAnim(a.name, Math.max(a.duration, 0.0333)); }
    });
    seqAnimListEl.appendChild(chip);
  });
}

// ---- drag & drop: json (from Json List) -> new layer; anim chip -> a layer's track row -------
function seqWireNewLayerDropzone(el) {
  el.addEventListener('dragover', ev => {
    if (draggingLibKeys.length !== 1) return;
    ev.preventDefault();
    el.classList.add('drag-ok');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-ok'));
  el.addEventListener('drop', ev => {
    ev.preventDefault();
    el.classList.remove('drag-ok');
    if (draggingLibKeys.length !== 1) { draggingLibKeys = []; return; }
    const key = draggingLibKeys[0];
    draggingLibKeys = [];
    seqAddLayerWithFirstAnim(key);
  });
}

// Drop target for an anim-chip: adds a clip to `layer` if the dragged chip belongs to the same
// json, rejecting (darkening) otherwise. Shared by both the track row (drop position = cursor
// time) and the layer's header/name area (no meaningful time under the cursor there, so it just
// appends after the layer's last clip — handled automatically by seqInsertClip's fallback).
function seqWireClipDropTarget(el, layer, useCursorTime) {
  el.addEventListener('dragover', ev => {
    if (!seqDraggingAnim) return;
    if (seqDraggingAnim.key !== layer.key) { el.classList.add('drag-reject'); return; } // reject: no preventDefault
    ev.preventDefault();
    el.classList.remove('drag-reject');
    el.classList.add('drag-ok');
  });
  el.addEventListener('dragleave', () => { el.classList.remove('drag-ok'); el.classList.remove('drag-reject'); });
  el.addEventListener('drop', ev => {
    ev.preventDefault();
    el.classList.remove('drag-ok');
    if (!seqDraggingAnim || seqDraggingAnim.key !== layer.key) { seqDraggingAnim = null; return; }
    const { animName, duration } = seqDraggingAnim;
    seqDraggingAnim = null;
    pushUndoSnapshot();
    const clip = { id: seqNextClipId++, animName, baseDuration: duration, loopCount: 1, start: 0 };
    const desiredStart = useCursorTime ? clientXToSeqTime(ev.clientX) : 0;
    seqInsertClip(layer, clip, desiredStart);
    seqSelectClip(layer.id, clip.id);
  });
}

function seqWireLayerRow(row, layer) {
  row.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    if (ev.target !== row) return; // clicked empty track space, not a clip
    seqSelectedClip = null;
    seqSelectLayer(layer.id);
  });
  seqWireClipDropTarget(row, layer, true);
}

function seqStartClipDrag(ev, layer, clip) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  pushUndoSnapshot();
  seqSelectClip(layer.id, clip.id);
  const el = seqTracksListEl.querySelector(`.seq-clip[data-clip-id="${clip.id}"]`);
  seqDraggingClip = { layer, clip, el, startClientX: ev.clientX, origStart: clip.start, lastDesired: clip.start, valid: true };
}

// Right-edge resize handle: stretches/shrinks the clip in whole-loop increments (x1, x2, x3...)
// of the animation's own duration — dragging right plays the anim more times in a row, dragging
// left removes loops (min x1). Clamped so it can never grow into the next clip on the layer.
function seqStartClipResize(ev, layer, clip) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  pushUndoSnapshot();
  seqSelectClip(layer.id, clip.id);
  seqResizingClip = { layer, clip, startClientX: ev.clientX, origLoopCount: clip.loopCount };
}

window.addEventListener('mousemove', ev => {
  if (seqDraggingClip) {
    const d = seqDraggingClip;
    const raw = d.origStart + (ev.clientX - d.startClientX) / seqPxPerSec;
    const desired = Math.max(0, seqSnapStart(d.clip, raw));
    d.lastDesired = desired;
    d.valid = true; // overlapping another clip is allowed on purpose (that's the blend region)
    if (d.el) d.el.style.left = (desired * seqPxPerSec) + 'px';
    return;
  }
  if (seqResizingClip) {
    const { clip, startClientX, origLoopCount } = seqResizingClip;
    const deltaSec = (ev.clientX - startClientX) / seqPxPerSec;
    const origTotal = clip.baseDuration * origLoopCount;
    // Growing right over a neighbouring clip is allowed on purpose — that overlap is the blend.
    const newLoopCount = Math.max(1, Math.round((origTotal + deltaSec) / clip.baseDuration));
    if (newLoopCount !== clip.loopCount) {
      clip.loopCount = newLoopCount;
      renderSeqTimeline();
      updateSeqBlendProperties();
    }
  }
});
window.addEventListener('mouseup', () => {
  if (seqDraggingClip) {
    const d = seqDraggingClip;
    if (d.valid) seqPlaceClip(d.layer, d.clip.id, d.lastDesired);
    seqDraggingClip = null;
    updateSeqBlendProperties();
    renderSeqTimeline(); // snaps the ghost back to its committed (or reverted) position
  }
  seqResizingClip = null;
});

// ---- layer reorder: drag a layer's name up/down, animated with a lightweight FLIP transition --
function seqCaptureRowRects() {
  const map = new Map();
  seqLayersListEl.querySelectorAll('[data-layer-id]').forEach(el => map.set('h:' + el.dataset.layerId, el.getBoundingClientRect()));
  seqTracksListEl.querySelectorAll('.seq-track-row[data-layer-id]').forEach(el => map.set('t:' + el.dataset.layerId, el.getBoundingClientRect()));
  return map;
}
function seqPlayFlipAnimation(beforeMap) {
  const animate = (el, key) => {
    const before = beforeMap.get(key);
    if (!before) return;
    const after = el.getBoundingClientRect();
    const dy = before.top - after.top;
    if (Math.abs(dy) < 1) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform .18s ease';
      el.style.transform = 'translateY(0)';
      el.addEventListener('transitionend', () => { el.style.transition = ''; el.style.transform = ''; }, { once: true });
    });
  };
  seqLayersListEl.querySelectorAll('[data-layer-id]').forEach(el => animate(el, 'h:' + el.dataset.layerId));
  seqTracksListEl.querySelectorAll('.seq-track-row[data-layer-id]').forEach(el => animate(el, 't:' + el.dataset.layerId));
}
function renderSeqTimelineAnimated() {
  const before = seqCaptureRowRects();
  renderSeqTimeline();
  seqPlayFlipAnimation(before);
}

function seqWireLayerHeaderDrag(headerRow, nameEl, layer) {
  nameEl.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    seqSelectLayer(layer.id);
    const originIndex = seqLayers.findIndex(l => l.id === layer.id);
    seqLayerDragState = {
      layerId: layer.id,
      startY: ev.clientY,
      originIndex,
      currentIndex: originIndex,
      rowHeight: headerRow.getBoundingClientRect().height || 44,
      snapshotted: false // only pushed to the undo stack once an actual reorder happens
    };
    headerRow.classList.add('dragging-layer');
  });
}

window.addEventListener('mousemove', ev => {
  if (!seqLayerDragState) return;
  const st = seqLayerDragState;
  const shift = Math.round((ev.clientY - st.startY) / st.rowHeight);
  const newIndex = Math.max(0, Math.min(seqLayers.length - 1, st.originIndex + shift));
  if (newIndex !== st.currentIndex) {
    if (!st.snapshotted) { pushUndoSnapshot(); st.snapshotted = true; }
    const idx = seqLayers.findIndex(l => l.id === st.layerId);
    const [moved] = seqLayers.splice(idx, 1);
    seqLayers.splice(newIndex, 0, moved);
    st.currentIndex = newIndex;
    seqApplyLayerRenderOrder();
    renderSeqTimelineAnimated();
    const freshHeader = seqLayersListEl.querySelector(`[data-layer-id="${st.layerId}"]`);
    if (freshHeader) freshHeader.classList.add('dragging-layer');
  }
});
window.addEventListener('mouseup', () => {
  if (seqLayerDragState) {
    document.querySelectorAll('.dragging-layer').forEach(el => el.classList.remove('dragging-layer'));
    seqLayerDragState = null;
  }
});

// ---- layer name column: user-resizable width, shared by the header list and the ruler spacer --
function seqApplyLayerColWidth() {
  seqLayersListEl.style.width = seqLayerColWidth + 'px';
  seqRulerSpacerEl.style.width = seqLayerColWidth + 'px';
}
seqColResizerEl.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  seqColResizing = { startX: ev.clientX, startWidth: seqLayerColWidth };
  seqColResizerEl.classList.add('active');
});
window.addEventListener('mousemove', ev => {
  if (!seqColResizing) return;
  seqLayerColWidth = Math.max(80, Math.min(400, seqColResizing.startWidth + (ev.clientX - seqColResizing.startX)));
  seqApplyLayerColWidth();
});
window.addEventListener('mouseup', () => {
  if (seqColResizing) { seqColResizing = null; seqColResizerEl.classList.remove('active'); }
});

// ---- timeline panel height: drag the strip along its top edge to resize vertically -----------
let seqVResizing = null;
seqVResizeEl.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  seqVResizing = { startY: ev.clientY, startHeight: sequencerTimelineWrapEl.getBoundingClientRect().height };
  seqVResizeEl.classList.add('active');
});
window.addEventListener('mousemove', ev => {
  if (!seqVResizing) return;
  // dragging the top edge UP grows the panel (so invert the delta), clamped to a sane range.
  const h = Math.max(120, Math.min(600, seqVResizing.startHeight - (ev.clientY - seqVResizing.startY)));
  sequencerTimelineWrapEl.style.height = h + 'px';
});
window.addEventListener('mouseup', () => {
  if (seqVResizing) { seqVResizing = null; seqVResizeEl.classList.remove('active'); }
});

// ---- wheel-zoom the timeline horizontally, zooming toward the cursor position -----------------
sequencerTimelineWrapEl.addEventListener('wheel', ev => {
  ev.preventDefault();
  const dir = ev.deltaY < 0 ? 1 : -1;
  const before = seqPxPerSec;
  const after = Math.max(20, Math.min(400, before + dir * 15));
  if (after === before) return;
  const rect = seqTracksScrollEl.getBoundingClientRect();
  const timeAtCursor = (ev.clientX - rect.left + seqTracksScrollEl.scrollLeft) / before;
  seqPxPerSec = after;
  seqTracksScrollEl.scrollLeft = Math.max(0, timeAtCursor * after - (ev.clientX - rect.left));
  seqRulerScrollEl.scrollLeft = seqTracksScrollEl.scrollLeft;
  renderSeqTimeline();
}, { passive: false });

// ---- canvas: select + drag-reposition a layer's instance, same idea as Preview's instances ----
function seqHitTest(wx, wy) {
  for (let i = 0; i < seqLayers.length; i++) { // index 0 = front-most, so check it first
    const layer = seqLayers[i];
    const b = layer._bounds;
    if (b && wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY) return layer;
  }
  return null;
}
function seqCanvasMouseDown(ev) {
  const world = screenToWorld(ev.clientX, ev.clientY);
  const hit = seqHitTest(world.x, world.y);
  canvasWrap.focus();
  if (hit) {
    seqSelectLayer(hit.id);
    pushUndoSnapshot();
    seqDraggingLayerInst = hit;
    seqDragInstStart = { x: ev.clientX, y: ev.clientY, ox: hit.x, oy: hit.y };
  } else {
    seqSelectLayer(null);
  }
}

// ---- timeline panning: hold right mouse button + drag (no scrollbars) --------------------
sequencerTimelineWrapEl.addEventListener('mousedown', ev => {
  if (ev.button !== 1 && ev.button !== 2) return; // middle OR right button
  ev.preventDefault();
  seqTimelinePanning = {
    startX: ev.clientX, startY: ev.clientY,
    startScrollLeft: seqTracksScrollEl.scrollLeft,
    startScrollTop: seqBodyEl.scrollTop
  };
  sequencerTimelineWrapEl.classList.add('panning');
});
sequencerTimelineWrapEl.addEventListener('contextmenu', ev => ev.preventDefault());
window.addEventListener('mousemove', ev => {
  if (!seqTimelinePanning) return;
  seqTracksScrollEl.scrollLeft = seqTimelinePanning.startScrollLeft - (ev.clientX - seqTimelinePanning.startX);
  seqBodyEl.scrollTop = seqTimelinePanning.startScrollTop - (ev.clientY - seqTimelinePanning.startY);
  seqRulerScrollEl.scrollLeft = seqTracksScrollEl.scrollLeft; // ticks + loop markers pan with it
});
window.addEventListener('mouseup', () => {
  if (seqTimelinePanning) { seqTimelinePanning = null; sequencerTimelineWrapEl.classList.remove('panning'); }
});

// ---- ruler scrub + loop start/end markers ------------------------------------------------
function seqSetPlayheadFromClientX(clientX) {
  seqPlayhead = Math.max(0, clientXToSeqTime(clientX));
  updateSeqPlayheadUI();
}
seqRulerScrollEl.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  if (ev.target === seqLoopStartMarkerEl || ev.target === seqLoopEndMarkerEl) return; // marker handles its own drag
  seqScrubbing = true;
  seqPlaying = false;
  seqSetPlayheadFromClientX(ev.clientX);
});
window.addEventListener('mousemove', ev => { if (seqScrubbing) seqSetPlayheadFromClientX(ev.clientX); });
window.addEventListener('mouseup', () => { seqScrubbing = false; });

seqLoopStartMarkerEl.addEventListener('mousedown', ev => { if (ev.button !== 0) return; ev.stopPropagation(); seqDraggingLoopMarker = 'start'; });
seqLoopEndMarkerEl.addEventListener('mousedown', ev => { if (ev.button !== 0) return; ev.stopPropagation(); seqDraggingLoopMarker = 'end'; });
window.addEventListener('mousemove', ev => {
  if (!seqDraggingLoopMarker) return;
  const t = clientXToSeqTime(ev.clientX);
  if (seqDraggingLoopMarker === 'start') {
    seqLoopStart = Math.max(0, Math.min(t, seqEffectiveLoopEnd() - 0.1));
  } else {
    seqLoopEnd = Math.max(seqLoopStart + 0.1, t);
  }
  updateSeqLoopMarkersUI();
});
window.addEventListener('mouseup', () => { seqDraggingLoopMarker = null; });

// ---- toolbar: play/pause ---------------------------------------------------------------------
function updateSeqPlayButton() { seqPlayBtn.textContent = seqPlaying ? '⏸' : '▶'; }
seqPlayBtn.addEventListener('click', () => { seqPlaying = !seqPlaying; updateSeqPlayButton(); });

// ---- toolbar: loop toggle -----------------------------------------------------------------
// Disabled (not just visually — the click is ignored too) while Loop Locally is on, since the
// global loop region it controls has no effect any more once every layer loops independently.
function updateSeqLoopButton() {
  seqLoopBtn.classList.toggle('active', seqLoopEnabled);
  seqLoopBtn.disabled = seqLoopLocally;
}
seqLoopBtn.addEventListener('click', () => {
  if (seqLoopLocally) return;
  seqLoopEnabled = !seqLoopEnabled;
  updateSeqLoopButton();
  updateSeqLoopMarkersUI();
});

// ---- toolbar: Loop Locally toggle ----------------------------------------------------------
function updateSeqLoopLocalButton() {
  seqLoopLocalBtn.classList.toggle('active', seqLoopLocally);
  updateSeqLoopButton();
  updateSeqPlayheadUI();
}
seqLoopLocalBtn.addEventListener('click', () => {
  seqLoopLocally = !seqLoopLocally;
  updateSeqLoopLocalButton();
});

// ---- zoom % badge (floats over the canvas, both tabs) --------------------------------------
let zoomFlashTimer = null;
function flashZoomIndicator() {
  zoomFlashEl.textContent = Math.round(view.zoomPercent) + '%';
  zoomFlashEl.classList.add('visible');
  clearTimeout(zoomFlashTimer);
  zoomFlashTimer = setTimeout(() => zoomFlashEl.classList.remove('visible'), 900);
}

// ---- rendering ------------------------------------------------------------------------------
function renderSeqRuler(width) {
  seqRulerEl.querySelectorAll('.seq-ruler-tick').forEach(el => el.remove());
  seqRulerEl.style.width = width + 'px';
  const step = seqNiceStep(seqPxPerSec);
  const totalSec = width / seqPxPerSec;
  for (let t = 0; t <= totalSec; t += step) {
    const tick = document.createElement('div');
    tick.className = 'seq-ruler-tick';
    tick.style.left = (t * seqPxPerSec) + 'px';
    tick.textContent = (Math.round(t * 100) / 100) + 's';
    seqRulerEl.appendChild(tick);
  }
}

function updateSeqLoopMarkersUI() {
  // Loop Locally: there's no shared global loop region any more (each layer loops on its own
  // cycle independently), so the loop-region overlay/markers — and the "Loop" toggle that drives
  // them — would just be showing a number that no longer means anything. Hide them to avoid
  // confusing that with what's actually happening.
  const show = seqLoopEnabled && !seqLoopLocally;
  seqLoopRegionEl.classList.toggle('on', show);
  seqLoopStartMarkerEl.hidden = !show;
  seqLoopEndMarkerEl.hidden = !show;
  if (!show) return;
  const end = seqEffectiveLoopEnd();
  seqLoopRegionEl.style.left = (seqLoopStart * seqPxPerSec) + 'px';
  seqLoopRegionEl.style.width = Math.max(0, (end - seqLoopStart) * seqPxPerSec) + 'px';
  seqLoopStartMarkerEl.style.left = (seqLoopStart * seqPxPerSec - 12) + 'px';
  seqLoopEndMarkerEl.style.left = (end * seqPxPerSec) + 'px';
}

function updateSeqPlayheadUI() {
  // Loop Locally: a single playhead position on one shared ruler is meaningless once every layer
  // is looping its own clip list on its own schedule — hide the moving markers so nobody reads it
  // as "where we are in the sequence" (there no longer is one shared position).
  const line = document.getElementById('seq-playhead-line');
  if (line) line.hidden = seqLoopLocally;
  seqPlayheadRulerMarkerEl.hidden = seqLoopLocally;
  if (!seqLoopLocally) {
    if (line) line.style.left = (seqPlayhead * seqPxPerSec) + 'px';
    seqPlayheadRulerMarkerEl.style.left = (seqPlayhead * seqPxPerSec) + 'px';
  }
  updateSeqLoopMarkersUI();
}

function updateSequencerEmptyHint() {
  sequencerEmptyHintEl.hidden = !(isTimelineTab() && seqLayers.length === 0);
}

function renderSeqTimeline() {
  const width = seqContentWidth();

  seqLayersListEl.innerHTML = '';
  seqTracksListEl.innerHTML = '';
  seqTracksListEl.style.width = width + 'px';

  seqLayers.forEach(layer => {
    const isSelectedLayer = layer.id === seqSelectedLayerId;

    // header (left column)
    const headerRow = document.createElement('div');
    headerRow.className = 'seq-layer-row-h' + (isSelectedLayer ? ' selected' : '') + (layer.hidden ? ' layer-hidden' : '');
    headerRow.dataset.layerId = layer.id;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'seq-layer-name';
    const libEntry = library.get(layer.key);
    nameSpan.textContent = libEntry ? libEntry.name : '(json đã bị xóa)';
    nameSpan.title = nameSpan.textContent;
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'seq-layer-eye';
    eyeBtn.textContent = layer.hidden ? '🙈' : '👁';
    eyeBtn.title = layer.hidden ? 'Hiện layer' : 'Tạm ẩn layer';
    eyeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      pushUndoSnapshot();
      layer.hidden = !layer.hidden;
      renderSeqTimeline();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'seq-layer-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Xóa layer này';
    delBtn.addEventListener('click', () => { pushUndoSnapshot(); seqDeleteLayer(layer.id); });
    headerRow.appendChild(eyeBtn);
    headerRow.appendChild(nameSpan);
    headerRow.appendChild(delBtn);
    seqLayersListEl.appendChild(headerRow);
    seqWireLayerHeaderDrag(headerRow, nameSpan, layer);
    seqWireClipDropTarget(headerRow, layer, false); // drop an anim chip on the title area too

    // track (right column)
    const row = document.createElement('div');
    row.className = 'seq-track-row' + (isSelectedLayer ? ' selected' : '') + (layer.hidden ? ' layer-hidden' : '');
    row.dataset.layerId = layer.id;
    layer.clips.forEach(clip => {
      const el = document.createElement('div');
      const isSelected = seqSelectedClip && seqSelectedClip.clipId === clip.id;
      const dur = seqClipEffectiveDuration(clip);
      el.className = 'seq-clip' + (isSelected ? ' selected' : '');
      el.dataset.clipId = clip.id;
      el.style.left = (clip.start * seqPxPerSec) + 'px';
      el.style.width = Math.max(12, dur * seqPxPerSec) + 'px';
      el.textContent = clip.loopCount > 1 ? `${clip.animName} ×${clip.loopCount}` : clip.animName;
      el.title = `${clip.animName} — ${dur.toFixed(2)}s${clip.loopCount > 1 ? ` (x${clip.loopCount})` : ''}`;
      el.addEventListener('mousedown', ev => seqStartClipDrag(ev, layer, clip));
      const handle = document.createElement('div');
      handle.className = 'seq-clip-resize-handle';
      handle.addEventListener('mousedown', ev => seqStartClipResize(ev, layer, clip));
      el.appendChild(handle);
      row.appendChild(el);
    });

    // Two consecutive clips that overlap get a "blend" strip drawn over the intersection — click
    // it to select, then edit the overlap length from the Properties panel.
    {
      const sorted = layer.clips.slice().sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        const aEnd = a.start + seqClipEffectiveDuration(a);
        const overlapSec = aEnd - b.start;
        if (overlapSec <= 1e-4) continue;
        const blendEl = document.createElement('div');
        const isSelectedBlend = seqSelectedBlend && seqSelectedBlend.layerId === layer.id
          && seqSelectedBlend.clipAId === a.id && seqSelectedBlend.clipBId === b.id;
        blendEl.className = 'seq-blend' + (isSelectedBlend ? ' selected' : '');
        blendEl.style.left = (b.start * seqPxPerSec) + 'px';
        blendEl.style.width = Math.max(4, overlapSec * seqPxPerSec) + 'px';
        const frames = Math.round(overlapSec * SEQ_FPS);
        blendEl.title = `Blend ${a.animName} → ${b.animName}: ${frames} frame (${overlapSec.toFixed(2)}s)`;
        blendEl.addEventListener('mousedown', ev => ev.stopPropagation());
        blendEl.addEventListener('click', ev => {
          ev.stopPropagation();
          seqSelectBlend(layer.id, a.id, b.id);
        });
        row.appendChild(blendEl);
      }
    }

    seqTracksListEl.appendChild(row);
    seqWireLayerRow(row, layer);
  });

  // "+ add layer" drop zone, plus its matching spacer in the header column so rows stay aligned
  // — wired as its own drop target too, so dropping a json on either side of that row works.
  const spacer = document.createElement('div');
  spacer.className = 'seq-new-layer-spacer';
  spacer.style.cssText = 'height:44px;margin:6px 0;border:1.5px dashed transparent;border-radius:8px;';
  seqLayersListEl.appendChild(spacer);
  seqWireNewLayerDropzone(spacer);

  const newLayerRow = document.createElement('div');
  newLayerRow.id = 'seq-new-layer-row';
  newLayerRow.textContent = '+ Kéo json từ Json List vào đây để tạo layer mới';
  seqTracksListEl.appendChild(newLayerRow);
  seqWireNewLayerDropzone(newLayerRow);

  const playheadLine = document.createElement('div');
  playheadLine.id = 'seq-playhead-line';
  seqTracksListEl.appendChild(playheadLine);

  renderSeqRuler(width);
  updateSeqPlayheadUI();
  updateSequencerEmptyHint();
}

// ---------------------------------------------------------------------------
// Tab switching: only one tab's instances are ever attached to stage.content at a time.
// ---------------------------------------------------------------------------
function setActiveTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;

  const timelineTab = tab === 'sequencer';

  tabBtnPreview.classList.toggle('active', tab === 'preview');
  tabBtnSequencer.classList.toggle('active', tab === 'sequencer');
  previewToolbarTabEl.hidden = tab !== 'preview';
  sequencerToolbarTabEl.hidden = !timelineTab;
  scrubBarWrapEl.hidden = tab !== 'preview';
  sequencerTimelineWrapEl.hidden = !timelineTab;

  if (tab === 'preview') {
    seqLayers.forEach(l => { if (l.spine && l.spine.parent) l.spine.parent.removeChild(l.spine); });
    instances.forEach(inst => stage.content.addChild(inst.spine));
    stage.applyLayerOrder(instances.map(i => i.spine));
  } else {
    instances.forEach(inst => { if (inst.spine.parent) inst.spine.parent.removeChild(inst.spine); });
    selection = [];
    updatePropertiesFromSelection();
    seqLayers.forEach(l => { if (l.spine) stage.content.addChild(l.spine); });
    seqApplyLayerRenderOrder();
    renderSeqAnimList();
    renderSeqTimeline();
  }
  seqSelectedBlend = null;
  updateSeqBlendProperties();
  updateSequencerEmptyHint();
}
tabBtnPreview.addEventListener('click', () => setActiveTab('preview'));
tabBtnSequencer.addEventListener('click', () => setActiveTab('sequencer'));

function advanceSequencer(dt) {
  if (seqPlaying) {
    seqPlayhead += dt;
    // Loop Locally: each layer is its own independent "prefab" looping on its own cycle (see
    // below) — there is no shared total length any more, so seqPlayhead must NOT get wrapped or
    // clamped by the global loop region here. Wrapping it would yank every layer's local-time
    // modulo back with it, which is exactly the abrupt restart bug this mode is meant to avoid
    // (e.g. a short "fly" clip snapping back to frame 0 the instant a longer layer's timeline
    // would have looped). It's just left to increase forever; each layer takes its own modulo of
    // it below.
    if (!seqLoopLocally) {
      if (seqLoopEnabled) {
        const start = seqLoopStart, end = seqEffectiveLoopEnd();
        if (end > start && seqPlayhead >= end) seqPlayhead = start + (seqPlayhead - end);
      } else {
        const total = seqTotalDuration();
        if (seqPlayhead >= total) { seqPlayhead = total; seqPlaying = false; }
      }
    }
  }
  seqLayers.forEach(layer => {
    if (!layer.spine) return;
    if (layer.hidden) { layer.spine.visible = false; layer._activeClipId = null; return; }
    // Loop Locally: instead of reading the shared global seqPlayhead directly, wrap it by this
    // layer's OWN clip-list length — so a short layer keeps looping its own sequence on its own
    // schedule instead of idling until the full (possibly much longer) timeline loops around.
    let t = seqPlayhead;
    if (seqLoopLocally) {
      const localDur = seqLayerLocalDuration(layer);
      if (localDur > 1e-6) t = seqPlayhead % localDur;
    }
    const candidates = layer.clips.filter(c => t >= c.start && t < c.start + seqClipEffectiveDuration(c));
    if (candidates.length > 1) {
      // Blend region (two overlapping clips): crossfade via AnimationState's own
      // TrackEntry.mixingFrom chain, weighted by how far the playhead is through the overlap —
      // see SpineStage.playBlend for details.
      candidates.sort((c1, c2) => c1.start - c2.start);
      const a = candidates[0], b = candidates[1];
      const overlapStart = b.start;
      const overlapEnd = Math.min(a.start + seqClipEffectiveDuration(a), b.start + seqClipEffectiveDuration(b));
      const alpha = Math.max(0, Math.min(1, (t - overlapStart) / Math.max(overlapEnd - overlapStart, 1e-6)));
      const timeA = (t - a.start) % a.baseDuration;
      const timeB = (t - b.start) % b.baseDuration;
      try {
        SpineStage.playBlend(layer.spine, a.animName, timeA, b.animName, timeB, alpha);
      } catch (e) {
        tickErrorOnce('blend:' + layer.id, 'Lỗi khi blend animation cho layer ' + layer.id, e);
      }
      layer.spine.visible = true;
      // No single clip is "active" while blending — clearing this forces a fresh play() once the
      // overlap ends and single-clip playback resumes, cleanly discarding playBlend's mixingFrom
      // chain via a normal AnimationState.setAnimation() call.
      layer._activeClipId = null;
      return;
    }
    const clip = candidates[0];
    if (clip) {
      layer.spine.visible = true;
      if (layer._activeClipId !== clip.id) {
        SpineStage.play(layer.spine, clip.animName);
        layer._activeClipId = clip.id;
      }
      const localTime = (t - clip.start) % clip.baseDuration;
      SpineStage.seek(layer.spine, localTime);
    } else {
      layer.spine.visible = false;
      layer._activeClipId = null;
    }
  });
  updateSeqPlayheadUI();
}

// ---------------------------------------------------------------------------
// Playback loop
// ---------------------------------------------------------------------------
let lastFrameTime = performance.now();

// A single bad skeleton (a specific mesh/IK/deform combo pixi-spine's runtime can choke on)
// throwing INSIDE this loop used to kill the whole rAF chain forever — the last line
// (`requestAnimationFrame(tick)`) never ran because the exception unwound past it, so the
// preview froze blank until the app was fully restarted. Everything below is wrapped so one
// instance failing never stops the loop, and the other instances / future drops keep working.
let _tickErrorLoggedFor = new Set();
function tickErrorOnce(key, label, e) {
  if (_tickErrorLoggedFor.has(key)) return;
  _tickErrorLoggedFor.add(key);
  console.error('[SpinePreview] ' + label, e);
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  try {
    stage.syncViewportSize();
    stage.setView(view.zoomPercent / 100, view.panX, view.panY);
    stage.clearOverlay();

    if (activeTab === 'preview') {
      instances.forEach(inst => {
        if (!inst.playing) return;
        try {
          SpineStage.advance(inst.spine, dt);
        } catch (e) {
          tickErrorOnce('advance:' + inst.id, 'Lỗi khi cập nhật animation của ' + inst.name + ' — đã tạm dừng instance này.', e);
          inst.playing = false;
        }
      });

      emptyHint.style.display = instances.length === 0 ? 'block' : 'none';

      // Bounds are read after the view transform is applied and before rendering; they feed both
      // hit-testing and the selection overlay.
      const strokeColor = contrastStrokeColor();
      instances.forEach(inst => {
        try {
          inst.bounds = stage.worldBoundsOf(inst.spine);
          if (selection.includes(inst.id)) {
            stage.drawSelectionBox(inst.spine, inst.exportW, inst.exportH, strokeColor);
          }
        } catch (e) {
          tickErrorOnce('bounds:' + inst.id, 'Lỗi khi tính bounds/vẽ selection cho ' + inst.name, e);
        }
      });
      updateScrubUI();
    } else {
      emptyHint.style.display = 'none';
      try {
        advanceSequencer(dt);
      } catch (e) {
        tickErrorOnce('sequencer', 'Lỗi trong Sequencer playback', e);
      }
      updateSeqPlayButton();

      const strokeColor = contrastStrokeColor();
      seqLayers.forEach(layer => {
        try {
          layer._bounds = (layer.spine && layer.spine.visible) ? stage.worldBoundsOf(layer.spine) : null;
        } catch (e) {
          tickErrorOnce('seqbounds:' + layer.id, 'Lỗi khi tính bounds cho layer ' + layer.id, e);
          layer._bounds = null;
        }
      });
      if (seqSelectedLayerId != null) {
        const sel = seqLayers.find(l => l.id === seqSelectedLayerId);
        if (sel && sel.spine && sel.spine.visible) {
          try { stage.drawBoundsSelection(sel.spine, strokeColor); } catch (e) { /* non-critical overlay */ }
        }
      }
    }

    stage.render();
  } catch (e) {
    // Last-resort net: even a failure we didn't anticipate above must not stop the loop.
    tickErrorOnce('tick', 'Lỗi không mong muốn trong vòng lặp render', e);
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Undo (Ctrl+Z / Cmd+Z)
// Snapshot-based: each undo step is a plain-data copy of everything a user edit can touch —
// Preview's `instances` and the Sequencer's `seqLayers` — taken right BEFORE the edit happens.
// PIXI Spine objects themselves aren't (usefully) serializable, so a snapshot stores only the
// plain fields; restoring destroys every current spine and recreates fresh ones from the json
// library, then reapplies position/scale/skin/animation/time onto them.
// ---------------------------------------------------------------------------
let undoStack = [];
const UNDO_LIMIT = 60;
let suppressSnapshot = false; // guarded while restoreSnapshot() itself is rebuilding state

function snapshotState() {
  return {
    nextInstanceId, seqNextLayerId, seqNextClipId,
    activeTab,
    instances: instances.map(i => ({
      id: i.id, key: i.key, name: i.name, x: i.x, y: i.y, scale: i.scale,
      exportW: i.exportW, exportH: i.exportH, playing: i.playing,
      anim: SpineStage.currentAnimation(i.spine),
      time: SpineStage.currentTime(i.spine),
      skin: SpineStage.currentSkin(i.spine)
    })),
    selection: selection.slice(),
    seqLayers: seqLayers.map(l => ({
      id: l.id, key: l.key, x: l.x, y: l.y, hidden: l.hidden,
      clips: l.clips.map(c => ({ id: c.id, animName: c.animName, baseDuration: c.baseDuration, loopCount: c.loopCount, start: c.start }))
    })),
    seqSelectedLayerId,
    seqSelectedClip: seqSelectedClip ? { ...seqSelectedClip } : null
  };
}

function pushUndoSnapshot() {
  if (suppressSnapshot) return;
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function restoreSnapshot(snap) {
  suppressSnapshot = true;

  instances.forEach(i => stage.removeSpine(i.spine));
  seqLayers.forEach(l => { if (l.spine) stage.removeSpine(l.spine); });

  instances = snap.instances.map(s => {
    const entry = library.get(s.key);
    if (!entry || !entry.spineData) return null;
    const spine = stage.createSpine(entry.spineData);
    const inst = {
      id: s.id, key: s.key, name: s.name, spine,
      x: s.x, y: s.y, scale: s.scale,
      exportW: s.exportW, exportH: s.exportH, playing: s.playing, bounds: null
    };
    if (s.skin && s.skin !== 'default') SpineStage.setSkin(spine, s.skin);
    if (s.anim) { SpineStage.play(spine, s.anim); SpineStage.seek(spine, s.time || 0); }
    applyInstanceTransform(inst);
    return inst;
  }).filter(Boolean);
  nextInstanceId = snap.nextInstanceId;

  seqLayers = snap.seqLayers.map(s => {
    const entry = library.get(s.key);
    const layer = {
      id: s.id, key: s.key, spine: null, x: s.x, y: s.y, hidden: s.hidden,
      clips: s.clips.map(c => ({ ...c })), _activeClipId: null, _bounds: null
    };
    if (entry && entry.spineData) {
      layer.spine = stage.createSpine(entry.spineData);
      layer.spine.position.set(s.x, s.y);
      layer.spine.visible = false;
    }
    return layer;
  });
  seqNextLayerId = snap.seqNextLayerId;
  seqNextClipId = snap.seqNextClipId;

  selection = snap.selection.filter(id => instances.some(i => i.id === id));
  seqSelectedLayerId = snap.seqSelectedLayerId;
  seqSelectedClip = snap.seqSelectedClip;
  seqSelectedBlend = null; // not persisted across undo/redo — just clears with the edit

  // Only the active tab's instances are ever attached to stage.content — reattach accordingly.
  if (activeTab === 'preview') {
    seqLayers.forEach(l => { if (l.spine && l.spine.parent) l.spine.parent.removeChild(l.spine); });
    instances.forEach(inst => stage.content.addChild(inst.spine));
    stage.applyLayerOrder(instances.map(i => i.spine));
  } else {
    instances.forEach(inst => { if (inst.spine.parent) inst.spine.parent.removeChild(inst.spine); });
    seqLayers.forEach(l => { if (l.spine) stage.content.addChild(l.spine); });
    seqApplyLayerRenderOrder();
  }

  updatePropertiesFromSelection();
  renderSeqAnimList();
  renderSeqTimeline();
  updateSeqBlendProperties();

  suppressSnapshot = false;
}

function undo() {
  if (!undoStack.length) return;
  const snap = undoStack.pop();
  restoreSnapshot(snap);
}


scrubBar.addEventListener('mousedown', () => {
  scrubDragging = true;
  const focused = getFocusedInstance();
  if (focused) focused.playing = false; // holding/clicking the scrub bar stops playback
});
window.addEventListener('mouseup', () => { scrubDragging = false; });
scrubBar.addEventListener('input', () => {
  const focused = getFocusedInstance();
  if (!focused) return;
  const dur = SpineStage.animationDuration(focused.spine);
  if (dur > 0) SpineStage.seek(focused.spine, (scrubBar.value / 1000) * dur);
});
scrubPlayBtn.addEventListener('click', () => togglePlay());

function updateScrubUI() {
  const sel = getSelectedInstances();
  const focused = getFocusedInstance();

  if (sel.length > 1) {
    // Hide the controls but keep the row's height, otherwise the preview resizes and the whole
    // layout jumps whenever the selection count crosses 1.
    scrubBarWrapEl.classList.add('scrub-hidden');
    return;
  }
  scrubBarWrapEl.classList.remove('scrub-hidden');

  if (!focused || !SpineStage.currentAnimation(focused.spine)) {
    scrubBar.disabled = true;
    scrubPlayBtn.disabled = true;
    scrubPlayBtn.textContent = '▶';
    frameCounter.textContent = '0 / 0';
    return;
  }

  scrubBar.disabled = false;
  scrubPlayBtn.disabled = false;
  scrubPlayBtn.textContent = focused.playing ? '⏸' : '▶';
  const dur = SpineStage.animationDuration(focused.spine);
  const time = SpineStage.currentTime(focused.spine);
  const fps = 30;
  if (!scrubDragging) {
    scrubBar.max = 1000;
    scrubBar.value = dur > 0 ? Math.round((time / dur) * 1000) : 0;
  }
  frameCounter.textContent = previewTimeUnit === 'seconds'
    ? `${time.toFixed(2)}s / ${dur.toFixed(2)}s`
    : `${Math.round(time * fps)} / ${Math.round(dur * fps)}`;
}

scrubUnitBtn.addEventListener('click', () => {
  previewTimeUnit = previewTimeUnit === 'frame' ? 'seconds' : 'frame';
  scrubUnitBtn.textContent = previewTimeUnit === 'seconds' ? 's' : 'F';
  updateScrubUI();
});

function togglePlay() {
  const sel = getSelectedInstances();
  const targets = sel.length ? sel : (instances.length === 1 ? [instances[0]] : []);
  if (!targets.length) return;
  const anyPlaying = targets.some(i => i.playing);
  targets.forEach(i => { i.playing = !anyPlaying; });
}

// Delete/Backspace always deletes the json selected in the Json List first, no matter what else
// is selected (a Sequencer clip, a canvas instance) or which element currently has keyboard
// focus. Registered on the CAPTURE phase so it runs before jsonListEl's/canvasWrap's own
// bubble-phase keydown handlers even get a chance to react — this sidesteps any focus-timing
// ambiguity entirely instead of relying on stopPropagation ordering.
window.addEventListener('keydown', ev => {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && libSelection.length) {
    ev.preventDefault();
    ev.stopPropagation();
    deleteSelectedJson();
  }
}, true);

window.addEventListener('keydown', ev => {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
    return;
  }

  if (ev.code === 'Space') {
    ev.preventDefault();
    if (isTimelineTab()) seqPlaying = !seqPlaying;
    else togglePlay();
    return;
  }

  if (isTimelineTab()) {
    if (ev.key === 'Home') {
      ev.preventDefault();
      seqPlaying = false;
      seqPlayhead = 0; updateSeqPlayheadUI();
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && seqSelectedClip) {
      ev.preventDefault();
      pushUndoSnapshot();
      seqDeleteClip(seqSelectedClip.layerId, seqSelectedClip.clipId);
    }
    return; // Preview-only shortcuts (+/-, canvas Delete) don't apply on the Sequencer tab
  }

  // Mirror the canvas shortcuts at window level so they still fire when focus drifted off the
  // canvas (clicking a chip, finishing a marquee drag, etc.).
  if (ev.target === canvasWrap) return; // the canvas handler already dealt with it
  if (ev.key === 'Home') { ev.preventDefault(); rewindSelectionToStart(); return; }
  if (ev.key === '+' || ev.key === '=' || ev.code === 'NumpadAdd') { ev.preventDefault(); moveSelectionLayer(+1); return; }
  if (ev.key === '-' || ev.key === '_' || ev.code === 'NumpadSubtract') { ev.preventDefault(); moveSelectionLayer(-1); }
});

renderJsonList();
updatePropertiesFromSelection();
updateSeqPlayButton();
updateSeqLoopButton();
updateSeqLoopLocalButton();
seqApplyLayerColWidth();
renderSeqTimeline();
requestAnimationFrame(tick);
