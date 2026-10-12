// Small UI motion helpers that CSS can't do alone:
//  - a red ink bar that slides between the Preview / Sequencer tabs
//  - the red "filled" part of every slider track (also follows values set from code, e.g.
//    the scrub bar moving during playback)
(() => {
  const tabs = document.querySelector('.preview-tabs');
  if (tabs) {
    const ink = document.createElement('div');
    ink.className = 'tab-ink';
    tabs.append(ink);
    const place = () => {
      const active = tabs.querySelector('.tab-btn.active');
      if (!active) return;
      ink.style.left = active.offsetLeft + 'px';
      ink.style.width = active.offsetWidth + 'px';
    };
    new MutationObserver(place).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', place);
    place();
  }

  const fill = range => {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const pct = max > min ? ((Number(range.value) - min) / (max - min)) * 100 : 0;
    const v = pct.toFixed(2) + '%';
    if (range.style.getPropertyValue('--fill') !== v) range.style.setProperty('--fill', v);
  };
  const tick = () => {
    document.querySelectorAll('input[type="range"]').forEach(fill);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
