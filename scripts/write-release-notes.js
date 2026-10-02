// Copies this version's line(s) from changelog.txt into build/release-notes.md, which
// electron-builder uses as the GitHub Release text — that's what the update dialog shows.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const notes = fs.readFileSync(path.join(root, 'changelog.txt'), 'utf-8')
  .split(/\r\n|\r|\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .filter(l => l.split('|')[0].trim() === version)
  .map(l => '- ' + l.slice(l.indexOf('|') + 1).trim());

fs.writeFileSync(path.join(root, 'build', 'release-notes.md'), notes.join('\n') || `Spine Preview v${version}`);
console.log(notes.join('\n'));
