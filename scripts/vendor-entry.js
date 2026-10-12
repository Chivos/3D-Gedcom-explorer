// Point d'entrée du bundle des bibliothèques tierces (three.js, 3d-force-graph,
// three-spritetext). Produit vendor/vendor.js, chargé par un simple <script>
// pour que l'application fonctionne même ouverte en file:// sans serveur.
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';

window.THREE = THREE;
window.ForceGraph3D = ForceGraph3D;
window.SpriteText = SpriteText;
