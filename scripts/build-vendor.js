// Regroupe three.js, 3d-force-graph et three-spritetext dans vendor/vendor.js
// (script classique, utilisable en file://) et rassemble leurs licences.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'vendor-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  legalComments: 'none',
  metafile: true,
  outfile: path.join(root, 'vendor', 'vendor.js'),
});

// Licences des paquets réellement inclus dans le bundle.
const pkgs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (m) pkgs.add(m[1]);
}
let out = 'Bibliothèques tierces incluses dans vendor.js\n=============================================\n';
for (const name of [...pkgs].sort()) {
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lic = fs.readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  out += `\n\n----- ${name}@${pkg.version} (${pkg.license || '?'}) -----\n`;
  out += lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : '(fichier de licence absent du paquet)';
}
fs.writeFileSync(path.join(root, 'vendor', 'THIRD-PARTY-LICENSES.txt'), out + '\n');
console.log('vendor/vendor.js :', pkgs.size, 'paquets');
