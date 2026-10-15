// ---------------------------------------------------------------------------
// Checklist (Preview tab only): automatic checks run on every animation of the focused skeleton.
// When the checklist is on, each animation chip gets a dot — green = passes every enabled check
// that applies to it, red = fails at least one. Hovering a chip lists what failed and why.
//
// Checks so far:
//   frameMatch — the pose on the first frame is EXACTLY the pose on the last frame (seamless
//                loop). Optional name filter: only animations whose name contains the text.
//
// renderer.js calls Checklist.decorate(inst, chipsByName) every time it rebuilds the chips, and
// Checklist calls Checklist.onChange() (set by renderer.js) when a setting changes.
// ---------------------------------------------------------------------------
const Checklist = (() => {
  const STORE_KEY = 'spv-checklist';
  const MIX_BLEND_SETUP = 0;   // spine MixBlend.setup
  const MIX_DIRECTION_IN = 0;  // spine MixDirection.in
  const MAX_DETAILS = 4;

  const defaults = { on: false, frameMatch: { enabled: true, filter: '' } };
  let settings = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { on: !!s.on, frameMatch: { ...defaults.frameMatch, ...(s.frameMatch || {}) } };
    } catch (e) {
      return JSON.parse(JSON.stringify(defaults));
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* not critical */ }
  }

  // ---- frameMatch: pose at time 0 vs pose at time = duration ----------------------------------

  const fmt = v => (typeof v === 'number' ? String(+v.toPrecision(7)) : String(v));

  // Pose a scratch skeleton (never the one on screen) at `time` and read every value an
  // animation can key: bone local transforms, slot colour / dark colour / attachment / deform,
  // draw order and constraint mixes.
  function snapshot(spine, anim, time) {
    const Skeleton = spine.skeleton.constructor;
    const sk = new Skeleton(spine.spineData);
    const skinName = spine.skeleton.skin && spine.skeleton.skin.name;
    if (skinName) sk.setSkinByName(skinName);
    sk.setToSetupPose();
    anim.apply(sk, time, time, false, [], 1, MIX_BLEND_SETUP, MIX_DIRECTION_IN);

    const snap = { bones: {}, slots: {}, drawOrder: sk.drawOrder.map(s => s.data.name).join('|'), constraints: {} };
    sk.bones.forEach(b => {
      snap.bones[b.data.name] = {
        x: b.x, y: b.y, 'xoay': b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY
      };
    });
    sk.slots.forEach(s => {
      const c = s.color, d = s.darkColor;
      snap.slots[s.data.name] = {
        'màu': [c.r, c.g, c.b].map(fmt).join(','),
        alpha: c.a,
        'màu tối': d ? [d.r, d.g, d.b].map(fmt).join(',') : '',
        'hình': s.attachment ? s.attachment.name : '(trống)',
        deform: (s.attachmentVertices || s.deform || []).join(',')
      };
    });
    (sk.ikConstraints || []).forEach(c => {
      snap.constraints['IK "' + c.data.name + '"'] = { mix: c.mix, bend: c.bendDirection, compress: c.compress, stretch: c.stretch };
    });
    (sk.transformConstraints || []).forEach(c => {
      snap.constraints['Transform "' + c.data.name + '"'] = { rotateMix: c.rotateMix, translateMix: c.translateMix, scaleMix: c.scaleMix, shearMix: c.shearMix };
    });
    (sk.pathConstraints || []).forEach(c => {
      snap.constraints['Path "' + c.data.name + '"'] = { position: c.position, spacing: c.spacing, rotateMix: c.rotateMix, translateMix: c.translateMix };
    });
    return snap;
  }

  function diffGroup(label, a, b, out) {
    let count = 0;
    Object.keys(a).forEach(name => {
      const pa = a[name], pb = b[name];
      Object.keys(pa).forEach(prop => {
        if (pa[prop] !== pb[prop]) { // exact match only, no tolerance
          count++;
          if (out.length < MAX_DETAILS) {
            const what = prop === 'deform' ? 'mesh deform khác' : `${prop} ${fmt(pa[prop])} → ${fmt(pb[prop])}`;
            out.push(`${label} "${name}": ${what}`);
          }
        }
      });
    });
    return count;
  }

  const frameMatchCache = new WeakMap(); // spineData -> Map(skin|anim -> result)

  function checkFrameMatch(spine, animName) {
    const skinName = (spine.skeleton.skin && spine.skeleton.skin.name) || '';
    let byAnim = frameMatchCache.get(spine.spineData);
    if (!byAnim) { byAnim = new Map(); frameMatchCache.set(spine.spineData, byAnim); }
    const key = skinName + '|' + animName;
    if (byAnim.has(key)) return byAnim.get(key);

    let result;
    try {
      const anim = spine.spineData.findAnimation(animName);
      const first = snapshot(spine, anim, 0);
      const last = snapshot(spine, anim, anim.duration);
      const details = [];
      const bones = diffGroup('Bone', first.bones, last.bones, details);
      const slots = diffGroup('Slot', first.slots, last.slots, details);
      const cons = diffGroup('Constraint', first.constraints, last.constraints, details);
      const order = first.drawOrder !== last.drawOrder ? 1 : 0;
      if (order && details.length < MAX_DETAILS) details.push('Thứ tự vẽ (draw order) khác');
      const total = bones + slots + cons + order;
      const summary = [bones && `${bones} giá trị bone`, slots && `${slots} giá trị slot`,
        cons && `${cons} giá trị constraint`, order && 'thứ tự vẽ'].filter(Boolean).join(', ');
      result = total === 0 ? { ok: true, details: [] } : { ok: false, summary: 'Lệch ' + summary, details };
    } catch (e) {
      console.error('[Checklist] frameMatch', animName, e);
      result = { ok: false, summary: 'Không kiểm tra được: ' + e.message, details: [] };
    }
    byAnim.set(key, result);
    return result;
  }

  // ---- registry of checks ----------------------------------------------------------------------

  const CHECKS = [{
    id: 'frameMatch',
    name: 'Frame đầu = frame cuối',
    applies: name => {
      const f = settings.frameMatch.filter.trim().toLowerCase();
      return settings.frameMatch.enabled && (!f || name.toLowerCase().includes(f));
    },
    run: (spine, name) => checkFrameMatch(spine, name)
  }];

  // null = no enabled check applies to this animation (it gets no dot)
  function evaluate(spine, animName) {
    const results = CHECKS.filter(c => c.applies(animName)).map(c => ({ check: c, ...c.run(spine, animName) }));
    if (!results.length) return null;
    return { ok: results.every(r => r.ok), results };
  }

  // ---- UI -------------------------------------------------------------------------------------

  const $ = id => document.getElementById(id);
  const switchEl = $('qa-switch');
  const fmEnabledEl = $('qa-framematch');
  const fmFilterEl = $('qa-framematch-filter');
  const rowsEl = $('qa-rows');
  const countEl = $('qa-count');
  const ownerEl = $('qa-owner');
  const noteEl = $('qa-note');

  const tip = document.createElement('div');
  tip.className = 'qa-tip';
  document.body.append(tip);

  let lastInst = null;
  let lastChips = null;

  const api = { onChange: () => {} };

  function applyOnClass() {
    document.body.classList.toggle('qa-on', settings.on);
    switchEl.classList.toggle('on', settings.on);
    switchEl.setAttribute('aria-checked', String(settings.on));
  }

  function changed() {
    save();
    applyOnClass();
    api.onChange();
  }

  switchEl.addEventListener('click', () => { settings.on = !settings.on; changed(); });
  fmEnabledEl.checked = settings.frameMatch.enabled;
  fmFilterEl.value = settings.frameMatch.filter;
  fmEnabledEl.addEventListener('change', () => { settings.frameMatch.enabled = fmEnabledEl.checked; changed(); });
  fmFilterEl.addEventListener('input', () => { settings.frameMatch.filter = fmFilterEl.value; changed(); });
  fmFilterEl.addEventListener('keydown', e => e.stopPropagation()); // typing Q/E/Space here must not hit shortcuts
  applyOnClass();

  function showTip(chip, name, ev) {
    if (!settings.on || !ev) return;
    const lines = ev.results.map(r => {
      const head = `<div class="qa-tip-row"><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span><span>${r.check.name}</span></div>`;
      if (r.ok) return head;
      const more = r.details.map(d => `<div class="qa-tip-detail">${escapeHtml(d)}</div>`).join('');
      return head + `<div class="qa-tip-detail">${escapeHtml(r.summary || '')}</div>` + more;
    }).join('');
    tip.innerHTML = `<div class="qa-tip-title">${escapeHtml(name)}</div>${lines}`;
    const b = chip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(b.left, window.innerWidth - 300)) + 'px';
    tip.style.top = (b.bottom + 8) + 'px';
    tip.classList.add('show');
  }
  const hideTip = () => tip.classList.remove('show');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Called by renderer.js after it rebuilds the Preview animation chips.
  api.decorate = (inst, chipsByName) => {
    lastInst = inst;
    lastChips = chipsByName;
    hideTip();
    rowsEl.innerHTML = '';

    if (!inst) {
      ownerEl.textContent = '';
      countEl.textContent = '';
      noteEl.textContent = 'Chọn 1 skeleton trên khung Preview để xem kết quả.';
      return;
    }

    ownerEl.textContent = inst.name;
    let checked = 0, passed = 0, skipped = 0;
    Object.entries(chipsByName).forEach(([name, chip]) => {
      const ev = settings.on ? evaluate(inst.spine, name) : null;
      if (settings.on && !ev) { skipped++; return; }
      if (!settings.on) return;
      checked++;
      if (ev.ok) passed++;

      const dot = document.createElement('span');
      dot.className = 'qa-dot ' + (ev.ok ? 'pass' : 'fail');
      chip.append(dot);
      chip.addEventListener('mouseenter', () => showTip(chip, name, ev));
      chip.addEventListener('mouseleave', hideTip);

      const row = document.createElement('div');
      row.className = 'qa-row';
      row.title = 'Bấm để phát anim này';
      row.innerHTML = `<span class="d ${ev.ok ? 'pass' : 'fail'}"></span><span class="n"></span><span class="r">${ev.ok ? 'Đạt' : 'Chưa đạt'}</span>`;
      row.querySelector('.n').textContent = name;
      row.addEventListener('mouseenter', () => showTip(row, name, ev));
      row.addEventListener('mouseleave', hideTip);
      row.addEventListener('click', () => chip.click());
      rowsEl.append(row);
    });

    countEl.textContent = settings.on && checked ? `${passed}/${checked} đạt` : '';
    if (!settings.on) noteEl.textContent = 'Checklist đang tắt, bật công tắc để chấm.';
    else if (!checked) noteEl.textContent = 'Không có anim nào khớp bộ lọc.';
    else noteEl.textContent = skipped ? `Bỏ qua ${skipped} anim không khớp bộ lọc.` : '';
  };

  return api;
})();
