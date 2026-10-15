# Arbre 3D GEDCOM

Application web pour **explorer un arbre généalogique en 3D** à partir d'un fichier
GEDCOM (`.ged`). Chaque personne devient un point dans l'espace, relié à ses parents,
conjoints et enfants. On voit d'un coup d'œil ce qu'un arbre 2D cache : remariages,
demi-fratries, mariages entre cousins, ancêtres qui reviennent par plusieurs chemins
(implexe), branches qui se rejoignent.

## Confidentialité : tout reste sur votre ordinateur

- Le fichier est lu par votre navigateur (API `FileReader`). **Il n'est jamais envoyé
  sur internet.**
- Les bibliothèques (three.js, 3d-force-graph) sont incluses dans le dépôt
  (`vendor/vendor.js`). La page ne charge rien depuis l'extérieur et fonctionne hors-ligne.
- La page déclare une politique de sécurité (`Content-Security-Policy`,
  `connect-src 'none'`) : le navigateur lui **interdit toute connexion réseau**, même
  en cas de bug.
- Rien n'est conservé : fermer l'onglet efface tout. Seuls vos réglages d'affichage
  sont mémorisés (dans le navigateur, `localStorage`).

## Utilisation

Trois façons de lancer l'application, sans rien installer :

1. **Fichier unique** : téléchargez `dist/arbre-3d-gedcom.html` et ouvrez-le
   (double-clic) dans Firefox, Chrome, Edge ou Safari.
2. **Depuis le dépôt** : clonez ou téléchargez le dépôt (bouton *Code → Download ZIP*),
   puis ouvrez `index.html`.
3. **GitHub Pages** : dans *Settings → Pages* du dépôt, publiez la branche principale ;
   l'application est alors accessible en ligne. Le fichier GEDCOM reste malgré tout
   traité uniquement dans le navigateur de la personne qui l'ouvre.

Puis cliquez sur **Choisir un fichier…** (ou glissez-déposez votre `.ged`), ou essayez
**l'exemple** fourni (famille fictive en Auvergne, avec unions entre cousins,
remariage et dates du calendrier républicain).

### Navigation

| Action | Effet |
| --- | --- |
| Glisser | Faire tourner la vue |
| Molette | Zoomer |
| Clic droit + glisser | Déplacer la vue |
| Clic sur une personne | Fiche détaillée, la caméra se centre dessus |
| Maj + clic sur une 2ᵉ personne | Lien de parenté avec la personne sélectionnée |
| Clic sur un nœud doré (union) | Le couple et ses enfants |
| `/` | Rechercher une personne |
| `Échap` | Tout désélectionner |

## Fonctionnalités

- **Lecture GEDCOM robuste** : GEDCOM 5.5 / 5.5.1 (et la plupart des exports 7.0),
  encodages UTF-8, UTF-16, ANSI (Windows-1252) et ANSEL, lignes `CONC`/`CONT`,
  liens déclarés d'un seul côté. Dates affichées en français, y compris
  `ABT`, `BEF`, `BET … AND …` et le **calendrier républicain** (`@#DFRENCH R@`).
- **Deux structures de graphe** :
  - *Personnes + nœuds « union »* (par défaut) : chaque couple est un petit nœud
    doré auquel sont rattachés ses enfants. Remariages et demi-frères/sœurs deviennent lisibles.
  - *Personnes seules* : liens directs parent → enfant et entre conjoints.
- **Trois dispositions** : libre (forces), **par générations** (ancêtres en haut),
  **chronologique** (hauteur = année de naissance, estimée si inconnue).
- **Couleurs** : sexe, patronyme, époque de naissance, lieu de naissance, groupe familial.
  Cliquer sur un patronyme ou un lieu de la légende met ses porteurs en évidence.
- **Regroupement par patronyme** (menu *Affichage*) : les porteurs d'un même nom sont
  attirés vers une zone commune, dont le nom flotte au-dessus. Les femmes sont rattachées
  à leur nom de naissance : les mariages apparaissent comme des ponts entre zones.
  L'intensité est réglable ; fonctionne avec les trois dispositions (en « générations »
  et « chronologique », les zones s'étalent horizontalement, l'axe vertical restant le temps).
- **Taille des personnes** réglable (de 30 % à 300 %).
- **Fiche personne** : dates et lieux, profession, notes, parents, conjoints, enfants,
  frères et sœurs (demi signalés), nombre d'ascendants et de descendants.
- **Mise en évidence** des ascendants, descendants, des deux, ou de l'entourage ;
  option pour masquer tout le reste.
- **Entourage** de la personne sélectionnée (mise en évidence, ou seul affiché) :
  dans toutes les directions (parents, enfants, conjoints) sur N liens, ou seulement
  ses **ascendants** sur N générations, ou seulement ses **descendants** (avec leurs
  conjoints) sur N générations.
- **Lien de parenté** entre deux personnes : nom du lien en français (oncle, cousin
  germain, issu de germain, demi-…, cousin d'un parent…), degré civil, ancêtres
  communs les plus proches, chemin animé dans la vue 3D. À défaut de lien de sang,
  chemin par alliance.
- **Implexe** : ancêtres qui apparaissent plusieurs fois dans l'ascendance d'une
  personne, avec le nombre de chemins et le taux d'implexe.
- **Unions consanguines** : détection automatique des couples dont les conjoints ont un
  ancêtre commun (sur 10 générations), signalés en rouge et listés dans les statistiques.
- **Statistiques** : effectifs, période couverte, générations, groupes non reliés,
  patronymes et lieux les plus fréquents.
- **Capture d'écran** PNG de la vue.

## Gros fichiers

Le calcul (lecture, générations, parentés) reste rapide même sur des dizaines de
milliers de personnes. L'affichage 3D dépend de la carte graphique : jusqu'à environ
10 000 à 20 000 personnes, la vue complète reste fluide sur un ordinateur récent.
Au-delà, sélectionnez une personne et cochez **N'afficher que l'entourage de la
sélection** (menu *Affichage*) pour travailler sur une partie de l'arbre.

## Organisation du code

```
index.html              page principale
src/gedcom.js           décodage (UTF-8, ANSEL…) et analyse du GEDCOM, dates
src/kinship.js          calculs généalogiques (générations, parentés, implexe…)
src/app.js              graphe 3D et interface
src/style.css           styles
src/sample.js           arbre d'exemple embarqué (copie de examples/famille-exemple.ged)
vendor/vendor.js        three.js + 3d-force-graph + three-spritetext (généré)
dist/arbre-3d-gedcom.html  application complète en un seul fichier (générée)
```

Le code de l'application est du JavaScript sans framework ni étape de compilation :
on peut modifier `src/*.js` et recharger la page.

Pour régénérer les fichiers produits (nécessite Node.js) :

```sh
npm install
npm run build          # vendor/vendor.js + dist/arbre-3d-gedcom.html
npm run build:single   # seulement le fichier unique, après une modification de src/
```

## Crédits

Rendu 3D : [three.js](https://threejs.org/) et
[3d-force-graph](https://github.com/vasturiano/3d-force-graph) de Vasco Asturiano
(licences MIT, voir `vendor/THIRD-PARTY-LICENSES.txt`).
