// ---------------------------------------------------------------------------
// Spine 4.2 runtime (official @esotericsoftware/spine-pixi-v7), used next to pixi-spine, which
// only goes up to 4.1. The package is ESM-only, so its self-contained IIFE build is evaluated
// here with this module's require (it pulls @pixi/* from the same copies pixi.js uses).
//
// The runtime registers its own PIXI.Assets loaders for .atlas / .json on load; those would
// compete with pixi-spine's loaders for 3.x files, so they are taken out again — 4.2 files are
// loaded by hand in SpineStage.loadSkeletonData. Its renderer plugin (dark tint) stays.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const PIXI = require('pixi.js');

const file = path.join(__dirname, 'node_modules', '@esotericsoftware', 'spine-pixi-v7', 'dist', 'iife', 'spine-pixi-v7.js');
const added = [];
const realAdd = PIXI.extensions.add;
PIXI.extensions.add = function (...exts) { added.push(...exts); return realAdd.apply(this, exts); };
let runtime;
try {
  runtime = new Function('require', fs.readFileSync(file, 'utf-8') + '\nreturn spine;')(require);
} finally {
  PIXI.extensions.add = realAdd;
}
added.filter(e => e && e.extension === PIXI.ExtensionType.Asset).forEach(e => PIXI.extensions.remove(e));

module.exports = runtime;
