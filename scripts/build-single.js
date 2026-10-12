// Produit dist/arbre-3d-gedcom.html : toute l'application dans un seul fichier
// HTML autonome, à ouvrir directement dans un navigateur (même hors-ligne).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) =>
  '<style>\n' + fs.readFileSync(path.join(root, href), 'utf8') + '</style>');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const js = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + js + '\n</script>';
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'arbre-3d-gedcom.html');
fs.writeFileSync(out, html);
console.log(out, Math.round(fs.statSync(out).size / 1024), 'Ko');
