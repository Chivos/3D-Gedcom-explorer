/*
 * Application : chargement du fichier, construction du graphe 3D, interface.
 * Dépend de window.ForceGraph3D, window.SpriteText, window.Gedcom, window.Kinship.
 */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  };
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------

  const COLORS = {
    M: '#4a90d9', F: '#e0569b', U: '#9aa0a6',
    family: '#f0c040', consanguine: '#ff5c5c',
    dim: '#262c38', dimLink: 'rgba(80,90,110,0.12)',
    linkChild: 'rgba(122,167,199,0.55)', linkSpouse: 'rgba(240,192,64,0.7)',
    highlight: '#ffffff', path: '#f0c040',
  };
  const GEN_SPACING = 45;
  const YEAR_SCALE = 1.6;

  const DEFAULTS = {
    structure: 'families', layout: 'free', color: 'sex', labels: 'focus',
    hideOthers: false, focusOnly: false, radius: 4, particles: true,
    nodeSize: 1, groupSurnames: false, groupStrength: 0.5, direction: 'all',
  };
  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('gedcom3d.settings') || '{}')); } catch (e) { /* stockage indisponible */ }
  const saveSettings = () => { try { localStorage.setItem('gedcom3d.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  const state = {
    data: null, K: null, fileName: '',
    gens: null, years: null, comps: null, consanguine: new Map(),
    searchIndex: [],
    nodeCache: new Map(),
    selected: null,
    highlight: null,       // { mode, persons:Set, nodes:Set, label }
    path: null,            // { a, b, nodes:Set, linkKeys:Set }
    colorMaps: {},
    yearRange: [0, 0],
  };

  let Graph = null;
  const big = () => state.data && state.data.individuals.size > 4000;

  // ---------------------------------------------------------------------------
  // Chargement
  // ---------------------------------------------------------------------------

  function showLoading(text) {
    $('#loading-text').textContent = text || 'Analyse du fichier…';
    $('#loading').hidden = false;
  }
  const hideLoading = () => { $('#loading').hidden = true; };

  let toastTimer = null;
  function toast(msg, ms = 4000) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function loadFile(file) {
    if (!file) return;
    showLoading('Lecture de « ' + file.name + ' »…');
    const reader = new FileReader();
    reader.onerror = () => { hideLoading(); toast('Impossible de lire le fichier.'); };
    reader.onload = () => {
      // Laisse le temps au navigateur d'afficher l'indicateur de chargement.
      setTimeout(() => {
        try {
          const { text, charset } = Gedcom.decode(reader.result);
          loadText(text, file.name, charset);
        } catch (err) {
          console.error(err);
          hideLoading();
          toast('Erreur pendant l\'analyse : ' + err.message, 8000);
        }
      }, 30);
    };
    reader.readAsArrayBuffer(file);
  }

  function loadText(text, name, charset) {
    const t0 = performance.now();
    const data = Gedcom.parse(text);
    if (!data.individuals.size) {
      hideLoading();
      toast(data.warnings.join(' ') || 'Fichier vide.', 8000);
      return;
    }
    const K = Kinship.create(data);
    Object.assign(state, {
      data, K, fileName: name,
      gens: K.generations(),
      years: K.estimatedYears(),
      comps: K.components(),
      consanguine: new Map(),
      nodeCache: new Map(),
      selected: null, highlight: null, path: null,
    });
    buildColorMaps();
    buildSearchIndex();

    $('#welcome').hidden = true;
    $('#legend').hidden = false;
    $('#hint').hidden = false;
    $('#panel').hidden = true;
    for (const b of ['#search', '#btn-stats', '#btn-settings', '#btn-shot']) $(b).disabled = false;
    $('#file-info').textContent = name + ' · ' + data.individuals.size.toLocaleString('fr-FR') + ' personnes · ' +
      data.families.size.toLocaleString('fr-FR') + ' unions';
    $('#file-info').title = 'Encodage : ' + charset + (data.header.source ? ' · Logiciel : ' + data.header.source : '');

    initGraph();
    rebuildGraph();
    renderLegend();
    hideLoading();
    computeConsanguinity();
    if (data.warnings.length) toast(data.warnings.join(' '), 7000);
    console.info('GEDCOM chargé en', Math.round(performance.now() - t0), 'ms');
    setTimeout(() => Graph && Graph.zoomToFit(800, 40), 2500);
  }

  /** Détection des unions consanguines par petits lots, sans bloquer l'interface. */
  function computeConsanguinity() {
    const K = state.K;
    const fams = [...state.data.families.values()];
    const job = {};
    state.consanguineJob = job;
    let i = 0;
    const step = () => {
      if (state.consanguineJob !== job) return; // un autre fichier a été chargé
      const t = performance.now();
      while (i < fams.length && performance.now() - t < 25) {
        const u = K.unionKinship(fams[i++], 10);
        if (u) state.consanguine.set(u.family, u);
      }
      if (i < fams.length) { setTimeout(step, 0); return; }
      state.consanguineJob = null;
      if (state.consanguine.size) refreshStyles();
      if (!$('#stats').hidden) showStats();
    };
    setTimeout(step, 50);
  }

  // ---------------------------------------------------------------------------
  // Couleurs
  // ---------------------------------------------------------------------------

  function hashColor(str, s = 65, l = 58) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    // Angle d'or pour bien séparer des teintes proches.
    const hue = (h * 137.508) % 360;
    return `hsl(${hue.toFixed(0)}, ${s}%, ${l}%)`;
  }

  const placeKey = ind => {
    const p = (ind.birth && ind.birth.place) || (ind.baptism && ind.baptism.place) || '';
    return p.split(',')[0].trim();
  };

  function topCounts(values, n) {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function buildColorMaps() {
    const inds = [...state.data.individuals.values()];
    state.colorMaps.surname = topCounts(inds.map(i => i.surname.toUpperCase()), 16);
    state.colorMaps.place = topCounts(inds.map(placeKey), 16);
    state.colorMaps.surnameSet = new Set(state.colorMaps.surname.map(([k]) => k));
    state.colorMaps.placeSet = new Set(state.colorMaps.place.map(([k]) => k));
    const ys = [...state.years.values()].map(y => y.year).sort((a, b) => a - b);
    // On ignore les extrêmes (dates aberrantes) pour l'échelle des couleurs.
    state.yearRange = ys.length ? [ys[Math.floor(ys.length * 0.02)], ys[Math.floor(ys.length * 0.98)]] : [1700, 1900];
    if (state.yearRange[0] === state.yearRange[1]) state.yearRange[1] += 1;
  }

  function eraColor(year) {
    const [a, b] = state.yearRange;
    const t = Math.max(0, Math.min(1, (year - a) / (b - a)));
    // Du violet (ancien) au orangé (récent).
    const hue = 270 - t * 240;
    return `hsl(${hue.toFixed(0)}, 70%, 58%)`;
  }

  function personColor(ind) {
    switch (settings.color) {
      case 'surname': {
        const s = ind.surname.toUpperCase();
        return state.colorMaps.surnameSet.has(s) ? hashColor(s) : '#6b7280';
      }
      case 'era': {
        const y = state.years.get(ind.id);
        return y ? eraColor(y.year) : '#6b7280';
      }
      case 'place': {
        const p = placeKey(ind);
        return state.colorMaps.placeSet.has(p) ? hashColor(p, 60, 55) : '#6b7280';
      }
      case 'component':
        return hashColor('c' + state.comps.comp.get(ind.id) + 'x', 60, 58);
      default:
        return COLORS[ind.sex];
    }
  }

  function renderLegend() {
    const L = $('#legend');
    L.replaceChildren();
    const item = (color, label, onclick) => el('div', { class: 'item' + (onclick ? ' clickable' : ''), onclick },
      el('span', { class: 'sw', style: 'background:' + color }), el('span', { text: label }));
    const titles = { sex: 'Sexe', surname: 'Patronymes les plus fréquents', era: 'Époque de naissance', place: 'Lieux de naissance', component: 'Groupes familiaux' };
    L.append(el('h4', { text: titles[settings.color] }));
    if (settings.color === 'sex') {
      L.append(item(COLORS.M, 'Homme'), item(COLORS.F, 'Femme'), item(COLORS.U, 'Inconnu'));
    } else if (settings.color === 'surname' || settings.color === 'place') {
      for (const [k, n] of state.colorMaps[settings.color]) {
        L.append(item(settings.color === 'surname' ? hashColor(k) : hashColor(k, 60, 55), k + ' (' + n + ')',
          () => highlightGroup(settings.color, k)));
      }
      L.append(item('#6b7280', 'Autres'));
    } else if (settings.color === 'era') {
      const [a, b] = state.yearRange;
      const stops = [0, .25, .5, .75, 1].map(t => eraColor(a + t * (b - a))).join(',');
      L.append(el('div', { class: 'bar', style: 'background:linear-gradient(90deg,' + stops + ')' }),
        el('div', { class: 'ends' }, el('span', { text: String(a) }), el('span', { text: String(b) })),
        el('small', { class: 'muted', text: 'Années estimées si inconnues' }));
    } else {
      const sizes = state.comps.sizes;
      L.append(el('small', { class: 'muted', text: sizes.length + ' groupe(s) sans lien entre eux ; le plus grand compte ' + Math.max(...sizes) + ' personnes.' }));
    }
    if (settings.structure === 'families') {
      L.append(el('h4', { text: 'Liens', style: 'margin-top:8px' }),
        item(COLORS.family, 'Union (couple)'), item(COLORS.consanguine, 'Union consanguine'));
    }
  }

  // ---------------------------------------------------------------------------
  // Construction du graphe
  // ---------------------------------------------------------------------------

  function cachedNode(id, init) {
    let n = state.nodeCache.get(id);
    if (!n) { n = init(); state.nodeCache.set(id, n); }
    return n;
  }

  /**
   * Entourage d'une personne selon la direction choisie :
   * - all  : tous les liens (parents, enfants, conjoints) jusqu'à `radius` liens ;
   * - up   : ascendants sur `radius` générations ;
   * - down : descendants sur `radius` générations, avec leurs conjoints
   *          (l'autre parent des enfants).
   */
  function entourage(id) {
    const K = state.K;
    const r = settings.radius;
    if (settings.direction === 'up') return new Set([id, ...K.ancestors(id, r).keys()]);
    if (settings.direction === 'down') {
      const out = new Set([id, ...K.descendants(id, r).keys()]);
      for (const p of [...out]) for (const s of K.spousesOf(p)) out.add(s);
      return out;
    }
    return new Set(K.neighborhood(id, r).keys());
  }

  function entourageLabel() {
    const r = settings.radius;
    if (settings.direction === 'up') return r + ' génération(s) d\'ascendants';
    if (settings.direction === 'down') return r + ' génération(s) de descendants';
    return r + ' lien(s)';
  }

  function visiblePersons() {
    if (settings.focusOnly && state.selected) return entourage(state.selected);
    return null; // tout le monde
  }

  function familyYear(f) {
    if (f.marriage && f.marriage.year) return f.marriage.year;
    const ys = [f.husb, f.wife].map(id => id && state.years.get(id)).filter(Boolean).map(y => y.year);
    if (ys.length) return Math.max(...ys) + 25;
    const cs = f.children.map(c => state.years.get(c)).filter(Boolean).map(y => y.year);
    return cs.length ? Math.min(...cs) - 1 : null;
  }

  function buildGraphData() {
    const { individuals, families } = state.data;
    const visible = visiblePersons();
    const isVis = id => !visible || visible.has(id);
    const nodes = [];
    const links = [];

    for (const ind of individuals.values()) {
      if (!isVis(ind.id)) continue;
      nodes.push(cachedNode(ind.id, () => ({ id: ind.id, type: 'person', ind })));
    }

    for (const f of families.values()) {
      const spouses = [f.husb, f.wife].filter(id => id && isVis(id));
      const kids = f.children.filter(isVis);
      if (settings.structure === 'families') {
        if (spouses.length + kids.length < 2) continue;
        const fid = 'fam:' + f.id;
        nodes.push(cachedNode(fid, () => ({ id: fid, type: 'family', fam: f })));
        for (const s of spouses) links.push({ source: s, target: fid, kind: 'spouse', key: s + '>' + fid });
        for (const c of kids) links.push({ source: fid, target: c, kind: 'child', key: fid + '>' + c });
      } else {
        if (spouses.length === 2) links.push({ source: spouses[0], target: spouses[1], kind: 'couple', key: spouses[0] + '>' + spouses[1], fam: f });
        for (const p of spouses) for (const c of kids) links.push({ source: p, target: c, kind: 'child', key: p + '>' + c, fam: f });
      }
    }
    applyLayout(nodes);
    return { nodes, links };
  }

  function applyLayout(nodes) {
    let mid = 0;
    if (settings.layout === 'generations') {
      const vals = [...state.gens.values()];
      mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    } else if (settings.layout === 'timeline') {
      mid = (state.yearRange[0] + state.yearRange[1]) / 2;
    }
    for (const n of nodes) {
      if (settings.layout === 'free') {
        delete n.fy;
        continue;
      }
      let v = null;
      if (settings.layout === 'generations') {
        if (n.type === 'person') v = state.gens.get(n.id);
        else {
          const f = n.fam;
          const g = [f.husb, f.wife].filter(Boolean).map(id => state.gens.get(id));
          v = g.length ? Math.max(...g) + 0.5 : Math.min(...f.children.map(c => state.gens.get(c))) - 0.5;
        }
        n.fy = -(v - mid) * GEN_SPACING;
      } else {
        if (n.type === 'person') {
          const y = state.years.get(n.id);
          v = y ? y.year : null;
        } else {
          v = familyYear(n.fam);
        }
        if (v === null) delete n.fy;
        else n.fy = -(v - mid) * YEAR_SCALE;
      }
      if (n.fy !== undefined && n.y === undefined) n.y = n.fy;
    }
  }

  function rebuildGraph({ reheat = true } = {}) {
    if (!Graph) return;
    const gd = buildGraphData();
    Graph.graphData(gd);
    applyGrouping();
    refreshStyles();
    if (reheat) Graph.d3ReheatSimulation();
  }

  // ---------------------------------------------------------------------------
  // Mise en évidence
  // ---------------------------------------------------------------------------

  /** Ajoute au jeu de nœuds les unions qui relient au moins deux personnes du jeu. */
  function withFamilies(persons) {
    const nodes = new Set(persons);
    if (settings.structure !== 'families') return nodes;
    for (const f of state.data.families.values()) {
      let n = 0;
      if (f.husb && persons.has(f.husb)) n++;
      if (f.wife && persons.has(f.wife)) n++;
      for (const c of f.children) if (persons.has(c)) n++;
      if (n >= 2) nodes.add('fam:' + f.id);
    }
    return nodes;
  }

  function setHighlight(mode, id = state.selected, extra) {
    const K = state.K;
    let persons = null;
    let label = '';
    const name = id ? K.get(id).name : '';
    switch (mode) {
      case 'ancestors':
        persons = new Set([id, ...K.ancestors(id).keys()]);
        label = 'Ascendants de ' + name;
        break;
      case 'descendants':
        persons = new Set([id, ...K.descendants(id).keys()]);
        label = 'Descendants de ' + name;
        break;
      case 'lineage':
        persons = new Set([id, ...K.ancestors(id).keys(), ...K.descendants(id).keys()]);
        label = 'Ascendants et descendants de ' + name;
        break;
      case 'neighborhood':
        persons = entourage(id);
        label = 'Entourage de ' + name + ' (' + entourageLabel() + ')';
        break;
      case 'implex':
        persons = new Set([id, ...extra]);
        label = 'Ancêtres multiples (implexe) de ' + name;
        break;
      case 'set':
        persons = new Set(extra.persons);
        label = extra.label;
        break;
      default:
        state.highlight = null;
        refreshStyles();
        updateHighlightButtons();
        return;
    }
    let nodes = withFamilies(persons);
    if (mode === 'implex' && settings.structure === 'families') {
      // Pour l'implexe on montre toute l'ascendance mais on fait ressortir les doublons.
      nodes = withFamilies(new Set([id, ...K.ancestors(id).keys()]));
    }
    state.highlight = { mode, persons, nodes, label, strong: mode === 'implex' ? new Set(extra) : null };
    refreshStyles();
    updateHighlightButtons();
    toast(label + ' : ' + persons.size + ' personne(s)', 3000);
    if (persons.size > 1) fitTo(nodes);
  }

  function highlightGroup(kind, key) {
    const persons = [];
    for (const ind of state.data.individuals.values()) {
      if (kind === 'surname' ? ind.surname.toUpperCase() === key : placeKey(ind) === key) persons.push(ind.id);
    }
    state.path = null;
    setHighlight('set', null, { persons, label: (kind === 'surname' ? 'Patronyme ' : 'Nés à ') + key });
  }

  function setPath(a, b, path) {
    if (!path) { state.path = null; refreshStyles(); return; }
    const persons = new Set(path.map(s => s.id));
    const linkKeys = new Set();
    // Liens à animer : entre deux étapes consécutives (via l'union le cas échéant).
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1].id;
      const q = path[i].id;
      const via = path[i].via;
      for (const f of state.data.families.values()) {
        const spouses = [f.husb, f.wife];
        let ok = false;
        if (via === 'spouse') ok = spouses.includes(p) && spouses.includes(q);
        else if (via === 'parent') ok = spouses.includes(q) && f.children.includes(p);
        else if (via === 'child') ok = spouses.includes(p) && f.children.includes(q);
        if (!ok) continue;
        if (settings.structure === 'families') {
          const fid = 'fam:' + f.id;
          for (const x of [p, q]) {
            linkKeys.add(x + '>' + fid);
            linkKeys.add(fid + '>' + x);
          }
        } else {
          linkKeys.add(p + '>' + q);
          linkKeys.add(q + '>' + p);
        }
        break;
      }
    }
    state.path = { a, b, steps: path, persons, nodes: withFamilies(persons), linkKeys };
    // N'inclure que les unions réellement traversées.
    if (settings.structure === 'families') {
      state.path.nodes = new Set(persons);
      for (const k of linkKeys) k.split('>').forEach(x => x.startsWith('fam:') && state.path.nodes.add(x));
    }
    refreshStyles();
  }

  const isHighlighted = n => {
    if (state.path) return state.path.nodes.has(n.id);
    if (state.highlight) return state.highlight.nodes.has(n.id);
    return true;
  };
  const hasFocus = () => !!(state.path || state.highlight);
  const linkEnd = x => (typeof x === 'object' ? x.id : x);

  function linkHighlighted(l) {
    const s = linkEnd(l.source);
    const t = linkEnd(l.target);
    if (state.path) return state.path.linkKeys.has(l.key);
    if (state.highlight) return state.highlight.nodes.has(s) && state.highlight.nodes.has(t);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Rendu 3D
  // ---------------------------------------------------------------------------

  function nodeColor(n) {
    if (hasFocus() && !isHighlighted(n)) return COLORS.dim;
    if (n.type === 'family') return state.consanguine.has(n.fam.id) ? COLORS.consanguine : COLORS.family;
    if (state.highlight && state.highlight.strong && state.highlight.strong.has(n.id)) return '#ff9f43';
    return personColor(n.ind);
  }

  function nodeVal(n) {
    if (n.type === 'family') return state.consanguine.has(n.fam.id) ? 0.9 : 0.35;
    // nodeVal est un volume : on élève le facteur au cube pour que le réglage
    // agisse proportionnellement sur le diamètre des boules.
    const k = Math.pow(settings.nodeSize, 3);
    if (n.id === state.selected) return 7 * k;
    if (state.path && (n.id === state.path.a || n.id === state.path.b)) return 5 * k;
    if (state.highlight && state.highlight.strong && state.highlight.strong.has(n.id)) return 4 * k;
    return 1.6 * k;
  }

  function linkColor(l) {
    if (hasFocus()) {
      if (linkHighlighted(l)) return state.path ? COLORS.path : (l.kind === 'child' ? '#9cc8ea' : COLORS.family);
      return COLORS.dimLink;
    }
    return l.kind === 'child' ? COLORS.linkChild : COLORS.linkSpouse;
  }

  function wantsLabel(n) {
    if (n.type !== 'person' || settings.labels === 'none') return false;
    if (n.id === state.selected) return true;
    if (state.path) return state.path.persons.has(n.id);
    if (settings.labels === 'all') return !hasFocus() || isHighlighted(n);
    if (state.highlight) return state.highlight.persons.size <= 300 && state.highlight.persons.has(n.id);
    return false;
  }

  function makeLabel(n) {
    const ind = n.ind;
    const y = state.years.get(ind.id);
    const sprite = new SpriteText(ind.name + (y && !y.estimated ? ' (' + y.year + ')' : ''));
    sprite.color = n.id === state.selected ? '#ffffff' : '#dfe6f3';
    sprite.textHeight = n.id === state.selected ? 4.2 : 3;
    sprite.fontFace = 'system-ui, sans-serif';
    sprite.backgroundColor = 'rgba(10,14,22,0.55)';
    sprite.padding = 1;
    sprite.borderRadius = 2;
    sprite.userData.offset = n.id === state.selected ? 12 : 8;
    sprite.material.depthWrite = false;
    return sprite;
  }

  // Les étiquettes sont gérées dans un groupe 3D séparé : les ajouter ou les
  // retirer ne force pas la reconstruction de tous les nœuds du graphe.
  const labels = new Map(); // id → { sprite, selected }
  let labelGroup = null;
  const MAX_LABELS = 1500;

  function updateLabels() {
    if (!Graph) return;
    const wanted = new Set();
    for (const n of Graph.graphData().nodes) {
      if (wantsLabel(n)) {
        wanted.add(n.id);
        if (wanted.size >= MAX_LABELS) break;
      }
    }
    if (state.selected) wanted.add(state.selected);
    for (const [id, l] of labels) {
      if (!wanted.has(id) || l.selected !== (id === state.selected) || !state.nodeCache.has(id)) {
        labelGroup.remove(l.sprite);
        l.sprite.material.map && l.sprite.material.map.dispose();
        l.sprite.material.dispose();
        labels.delete(id);
      }
    }
    for (const id of wanted) {
      if (labels.has(id)) continue;
      const n = state.nodeCache.get(id);
      if (!n || n.type !== 'person') continue;
      const sprite = makeLabel(n);
      labels.set(id, { sprite, selected: id === state.selected, node: n });
      labelGroup.add(sprite);
    }
  }

  function positionLabels() {
    for (const { sprite, node } of labels.values()) {
      if (node.x === undefined) { sprite.visible = false; continue; }
      sprite.visible = true;
      sprite.position.set(node.x, node.y + sprite.userData.offset * Math.max(1, settings.nodeSize), node.z);
    }
    positionGroupLabels();
    requestAnimationFrame(positionLabels);
  }

  // ---------------------------------------------------------------------------
  // Regroupement par patronyme
  // ---------------------------------------------------------------------------
  //
  // Chaque patronyme fréquent reçoit un point d'ancrage dans l'espace ; une force
  // attire ses porteurs vers ce point. Les femmes sont rattachées à leur nom de
  // naissance (convention GEDCOM) : les mariages apparaissent comme des ponts
  // entre zones patronymiques.

  const MAX_GROUPS = 40;
  const surnameKey = ind => ind.surname.toUpperCase();
  const groupLabels = new Map(); // patronyme → { sprite, members: [] }

  function surnameAnchors() {
    const counts = topCounts([...state.data.individuals.values()].map(surnameKey), MAX_GROUPS)
      .filter(([, n]) => n >= 2);
    const anchors = new Map();
    const N = counts.length;
    const grouped = counts.reduce((a, [, n]) => a + n, 0);
    // L'espace alloué grandit avec le nombre de groupes et de personnes.
    const spread = 50 + 14 * Math.sqrt(grouped) + 25 * Math.sqrt(N);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const flat = settings.layout !== 'free'; // l'axe vertical est déjà imposé
    counts.forEach(([key, n], i) => {
      let x, y, z;
      if (flat) {
        // Disposition en tournesol dans le plan horizontal, étirée de gauche à
        // droite pour rester lisible dans la vue de face.
        const r = 0.6 * spread * Math.sqrt((i + 0.5) / N);
        x = 1.6 * r * Math.cos(i * golden);
        z = 0.7 * r * Math.sin(i * golden);
        y = 0;
      } else {
        // Points répartis régulièrement sur une sphère.
        const R = spread;
        const t = N > 1 ? 1 - (2 * i) / (N - 1) : 0;
        const ring = Math.sqrt(1 - t * t);
        x = R * ring * Math.cos(i * golden);
        y = R * t;
        z = R * ring * Math.sin(i * golden);
      }
      anchors.set(key, { x, y, z, count: n });
    });
    return anchors;
  }

  /** Groupe d'un nœud : patronyme pour une personne, celui du mari pour une union. */
  function groupOf(n) {
    if (n.type === 'person') return surnameKey(n.ind);
    const f = n.fam;
    const ref = f.husb || f.wife || f.children[0];
    return ref ? surnameKey(state.K.get(ref)) : null;
  }

  function surnameForce() {
    let nodes = [];
    let anchors = new Map();
    const flat = settings.layout !== 'free';
    const force = alpha => {
      const k = 0.02 + 0.25 * settings.groupStrength;
      for (const n of nodes) {
        if (n.x === undefined) continue;
        const a = anchors.get(groupOf(n));
        if (!a) continue;
        n.vx += (a.x - n.x) * k * alpha;
        n.vz += (a.z - n.z) * k * alpha;
        if (!flat) n.vy += (a.y - n.y) * k * alpha;
      }
    };
    force.initialize = ns => { nodes = ns; anchors = surnameAnchors(); };
    return force;
  }

  function applyGrouping() {
    if (!Graph) return;
    Graph.d3Force('surname', settings.groupSurnames ? surnameForce() : null);
    // Plus de répulsion quand on regroupe, pour que les zones respirent.
    Graph.d3Force('charge').strength(settings.groupSurnames ? -60 : -45);
    applyLinkForce();
    updateGroupLabels();
  }

  /**
   * Les liens entre deux patronymes différents (mariages, enfants rattachés à
   * l'union du côté de la mère) sont assouplis et allongés quand on regroupe :
   * les zones se séparent et les alliances deviennent des ponts visibles.
   */
  function applyLinkForce() {
    const g = settings.groupSurnames ? settings.groupStrength : 0;
    const node = x => (typeof x === 'object' ? x : state.nodeCache.get(x));
    const cross = l => {
      if (!g) return false;
      const a = groupOf(node(l.source));
      const b = groupOf(node(l.target));
      return a !== b;
    };
    const base = l => (l.kind === 'spouse' ? 8 : l.kind === 'couple' ? 12 : 18);
    Graph.d3Force('link')
      .distance(l => (cross(l) ? base(l) + 70 * g : base(l)))
      .strength(l => (cross(l) ? 0.9 * (1 - 0.9 * g) : 0.9));
  }

  function updateGroupLabels() {
    for (const { sprite } of groupLabels.values()) {
      labelGroup.remove(sprite);
      sprite.material.map && sprite.material.map.dispose();
      sprite.material.dispose();
    }
    groupLabels.clear();
    if (!settings.groupSurnames || !state.data) return;
    const anchors = surnameAnchors();
    const members = new Map([...anchors.keys()].map(k => [k, []]));
    for (const n of Graph.graphData().nodes) {
      if (n.type === 'person' && members.has(surnameKey(n.ind))) members.get(surnameKey(n.ind)).push(n);
    }
    for (const [key, list] of members) {
      if (!list.length) continue;
      const sprite = new SpriteText(key);
      sprite.color = hashColor(key, 70, 70);
      sprite.textHeight = 9 + Math.min(14, Math.sqrt(list.length) * 1.5);
      sprite.fontFace = 'system-ui, sans-serif';
      sprite.fontWeight = '700';
      sprite.material.depthWrite = false;
      sprite.material.opacity = 0.85;
      sprite.material.transparent = true;
      groupLabels.set(key, { sprite, members: list });
      labelGroup.add(sprite);
    }
  }

  /** Place le nom de chaque groupe au-dessus du barycentre de ses membres. */
  function positionGroupLabels() {
    for (const { sprite, members } of groupLabels.values()) {
      let x = 0, y = 0, z = 0, n = 0, top = -Infinity;
      for (const m of members) {
        if (m.x === undefined) continue;
        x += m.x; y += m.y; z += m.z; n++;
        if (m.y > top) top = m.y;
      }
      sprite.visible = n > 0 && !hasFocus();
      if (!n) continue;
      // En disposition libre : au centre du groupe ; sinon au-dessus (l'axe vertical est le temps).
      const yy = settings.layout === 'free' ? y / n : top + 25;
      sprite.position.set(x / n, yy, z / n);
    }
  }

  function lifeSpan(ind) {
    const b = ind.birth || ind.baptism;
    const d = ind.death || ind.burial;
    const by = b && b.year;
    const dy = d && d.year;
    if (!by && !dy) return '';
    return (by || '?') + ' – ' + (dy || (d ? '?' : ''));
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function nodeLabel(n) {
    if (n.type === 'family') {
      const f = n.fam;
      const names = [f.husb, f.wife].filter(Boolean).map(id => esc(state.K.get(id).name)).join(' &amp; ');
      const m = f.marriage && f.marriage.text ? '<br><small>Mariage : ' + esc(f.marriage.text) + '</small>' : '';
      const c = state.consanguine.get(f.id);
      return '<b>Union</b> ' + names + m + '<br><small>' + f.children.length + ' enfant(s)</small>' +
        (c ? '<br><small style="color:#ff8a8a">Conjoints apparentés : ' + esc(c.name) + '</small>' : '');
    }
    const ind = n.ind;
    const span = lifeSpan(ind);
    const occ = ind.occupations[0] ? '<br><small>' + esc(ind.occupations[0]) + '</small>' : '';
    return '<b>' + esc(ind.name) + '</b>' + (span ? ' <small>(' + span + ')</small>' : '') + occ;
  }

  function initGraph() {
    if (Graph) return;
    const container = $('#graph');
    Graph = ForceGraph3D({ rendererConfig: { antialias: true, alpha: false, preserveDrawingBuffer: true } })(container)
      .backgroundColor('#0b0e14')
      .showNavInfo(false)
      .nodeId('id')
      .nodeRelSize(3.2)
      .nodeLabel(nodeLabel)
      .nodeColor(nodeColor)
      .nodeVal(nodeVal)
      .nodeOpacity(0.95)
      .linkColor(linkColor)
      .linkOpacity(0.9)
      .linkWidth(l => (hasFocus() && linkHighlighted(l) ? 1.2 : 0))
      .linkDirectionalParticles(l => (settings.particles && hasFocus() && linkHighlighted(l) ? 2 : 0))
      .linkDirectionalParticleWidth(1.8)
      .linkDirectionalParticleSpeed(0.008)
      .onNodeClick((n, ev) => {
        if (n.type === 'family') return showFamily(n.fam);
        if (ev && ev.shiftKey && state.selected && state.selected !== n.id) return showRelation(state.selected, n.id);
        select(n.id, { fly: true });
      })
      .onNodeHover(n => { container.style.cursor = n ? 'pointer' : ''; })
      .onBackgroundClick(() => closeDropdowns());

    Graph.d3Force('charge').strength(-45).distanceMax(400);

    labelGroup = new THREE.Group();
    Graph.scene().add(labelGroup);
    requestAnimationFrame(positionLabels);

    const resize = () => Graph.width(container.clientWidth).height(container.clientHeight);
    window.addEventListener('resize', resize);
    resize();
  }

  /** Réapplique les accesseurs pour forcer le recalcul des styles. */
  function refreshStyles() {
    if (!Graph) return;
    const n = state.data.individuals.size;
    const resolution = n > 8000 ? 4 : n > 2000 ? 6 : 10;
    if (Graph.nodeResolution() !== resolution) Graph.nodeResolution(resolution);
    updateLabels();
    Graph
      .nodeColor(nodeColor)
      .nodeVal(nodeVal)
      .linkColor(linkColor)
      .linkWidth(Graph.linkWidth())
      .linkDirectionalParticles(Graph.linkDirectionalParticles())
      .nodeVisibility(n2 => !(settings.hideOthers && hasFocus()) || isHighlighted(n2))
      .linkVisibility(l => !(settings.hideOthers && hasFocus()) || linkHighlighted(l))
      .enableNodeDrag(!big())
      .cooldownTicks(big() ? 250 : 600);
  }

  /** Cadre la caméra sur un ensemble de nœuds. */
  function fitTo(ids) {
    setTimeout(() => Graph.zoomToFit(1000, 80, n => ids.has(n.id)), 300);
  }

  function flyTo(id) {
    const node = Graph.graphData().nodes.find(n => n.id === id);
    if (!node) return;
    const go = () => {
      const { x = 0, y = 0, z = 0 } = node;
      const dist = 160;
      const r = Math.hypot(x, y, z);
      const pos = r > 1 ? { x: x * (1 + dist / r), y: y * (1 + dist / r), z: z * (1 + dist / r) } : { x, y, z: z + dist };
      Graph.cameraPosition(pos, { x, y, z }, 1200);
    };
    if (node.x === undefined) setTimeout(go, 600); else go();
  }

  // ---------------------------------------------------------------------------
  // Sélection et fiche
  // ---------------------------------------------------------------------------

  function select(id, { fly = false } = {}) {
    if (!state.K.get(id)) return;
    const changed = state.selected !== id;
    state.selected = id;
    state.path = null;
    if (changed && state.highlight && state.highlight.mode !== 'set') {
      // On garde le même type de mise en évidence pour la nouvelle personne.
      setHighlight(state.highlight.mode === 'implex' ? 'lineage' : state.highlight.mode, id);
    }
    if (settings.focusOnly) rebuildGraph();
    else refreshStyles();
    showPerson(id);
    if (fly) flyTo(id);
  }

  function clearSelection() {
    state.selected = null;
    state.highlight = null;
    state.path = null;
    $('#panel').hidden = true;
    if (settings.focusOnly) rebuildGraph(); else refreshStyles();
  }

  const plink = (id, extra) => {
    const ind = state.K.get(id);
    const span = lifeSpan(ind);
    return el('li', {},
      el('a', { class: 'plink', href: '#', onclick: e => { e.preventDefault(); select(id, { fly: true }); } }, ind.name),
      span ? el('small', { text: ' ' + span }) : null,
      extra ? el('small', { text: ' · ' + extra }) : null);
  };

  function eventRow(label, ev) {
    if (!ev) return [];
    const txt = [ev.text, ev.place].filter(Boolean).join(' — ');
    return [el('dt', { text: label }), el('dd', { text: txt || 'oui' })];
  }

  function section(title, ...content) {
    const c = content.flat().filter(Boolean);
    if (!c.length) return null;
    return [el('h3', { text: title }), ...c];
  }

  function hlButton(mode, text) {
    return el('button', {
      class: 'btn small' + (state.highlight && state.highlight.mode === mode ? ' active' : ''),
      'data-hl': mode,
      onclick: () => setHighlight(state.highlight && state.highlight.mode === mode ? null : mode),
    }, text);
  }

  function updateHighlightButtons() {
    document.querySelectorAll('[data-hl]').forEach(b => {
      b.classList.toggle('active', !!(state.highlight && state.highlight.mode === b.dataset.hl));
    });
  }

  function openPanel(...content) {
    closeSide('help');
    const body = $('#panel-body');
    body.replaceChildren(...content.flat().filter(Boolean));
    $('#panel').hidden = false;
    $('#panel').scrollTop = 0;
  }

  function showPerson(id) {
    const K = state.K;
    const ind = K.get(id);
    const parents = K.parentsOf(id);
    const siblings = K.siblingsOf(id);
    const children = K.childrenOf(id);
    const anc = K.ancestors(id);
    const desc = K.descendants(id);
    const yr = state.years.get(id);
    const imp = K.implex(id);

    const marriages = ind.fams.map(fid => state.data.families.get(fid)).filter(Boolean).map(f => {
      const other = f.husb === id ? f.wife : f.husb;
      const c = state.consanguine.get(f.id);
      const m = f.marriage && (f.marriage.text || f.marriage.place) ? 'mariage ' + [f.marriage.text, f.marriage.place && f.marriage.place.split(',')[0]].filter(Boolean).join(', ') : '';
      if (!other) return el('li', {}, el('small', { text: 'Conjoint inconnu ' + (m ? '· ' + m : '') }));
      const li = plink(other, m);
      if (c) li.append(' ', el('span', { class: 'badge', title: 'Les conjoints ont un ancêtre commun', text: 'apparentés : ' + c.name }));
      return li;
    });

    const halfSibs = new Set();
    const parentSet = new Set(parents);
    for (const s of siblings) {
      const sp = K.parentsOf(s);
      if (sp.length !== parentSet.size || sp.some(p => !parentSet.has(p))) halfSibs.add(s);
    }

    const facts = el('dl', { class: 'facts' },
      ...eventRow('Naissance', ind.birth), ...eventRow('Baptême', ind.baptism),
      ...eventRow('Décès', ind.death), ...eventRow('Inhumation', ind.burial),
      ind.occupations.length ? [el('dt', { text: 'Profession' }), el('dd', { text: ind.occupations.join(', ') })] : [],
      !ind.birth && !ind.baptism && yr ? [el('dt', { text: 'Naissance' }), el('dd', {}, el('small', { text: 'estimée vers ' + yr.year }))] : [],
      [el('dt', { text: 'Génération' }), el('dd', { text: String(state.gens.get(id) + 1) + (state.gens.get(id) === 0 ? ' (la plus ancienne)' : '') })],
      [el('dt', { text: 'Réf.' }), el('dd', {}, el('small', { text: '@' + id + '@' }))]);

    const implexBlock = imp.repeated.length ? [
      el('p', {},
        'Implexe : ', el('b', { text: imp.repeated.length + ' ancêtre(s)' }), ' apparaissent plusieurs fois dans l\'ascendance (' +
        imp.distinct + ' ancêtres distincts pour ' + imp.totalPaths + ' places, taux ' + Math.round(imp.rate * 100) + ' %).'),
      el('ul', { class: 'plist' }, imp.repeated.slice(0, 12).map(r => plink(r.id, r.paths + ' chemins, génération ' + r.depths.join('/')))),
      imp.repeated.length > 12 ? el('small', { class: 'muted', text: '… et ' + (imp.repeated.length - 12) + ' autres.' }) : null,
      el('div', { class: 'tagrow' }, el('button', {
        class: 'btn small', 'data-hl': 'implex',
        onclick: () => setHighlight('implex', id, imp.repeated.map(r => r.id)),
      }, 'Mettre en évidence l\'implexe')),
    ] : null;

    const relSearch = el('input', { type: 'search', placeholder: 'Chercher une 2e personne…', autocomplete: 'off' });
    const relResults = el('ul', { class: 'dropdown', hidden: true });
    attachSearch(relSearch, relResults, other => showRelation(id, other));

    openPanel(
      el('div', { class: 'person-head' },
        el('span', { class: 'dot', style: 'background:' + personColor(ind) }),
        el('h2', { text: ind.name })),
      facts,
      el('div', { class: 'tagrow' },
        hlButton('ancestors', 'Ascendants (' + anc.size + ')'),
        hlButton('descendants', 'Descendants (' + desc.size + ')'),
        hlButton('lineage', 'Les deux'),
        hlButton('neighborhood', 'Entourage'),
        el('button', { class: 'btn small', onclick: () => flyTo(id) }, 'Centrer')),
      section('Parents', parents.length ? el('ul', { class: 'plist' }, parents.map(p => plink(p))) : null),
      section('Conjoint(s)', marriages.length ? el('ul', { class: 'plist' }, marriages) : null),
      section('Enfants (' + children.length + ')', children.length ? el('ul', { class: 'plist' }, children.map(c => plink(c))) : null),
      section('Frères et sœurs (' + siblings.length + ')', siblings.length ? el('ul', { class: 'plist' },
        siblings.map(s => plink(s, halfSibs.has(s) ? 'demi' : null))) : null),
      section('Implexe', implexBlock),
      section('Lien de parenté avec…',
        el('div', { class: 'relation-search' }, relSearch, relResults),
        el('small', { class: 'muted', text: 'Astuce : Maj + clic sur une personne dans la vue 3D.' })),
      section('Notes', ind.notes.map(n => el('div', { class: 'note', text: n }))),
    );
  }

  function showFamily(f) {
    const K = state.K;
    const c = state.consanguine.get(f.id);
    const spouses = [f.husb, f.wife].filter(Boolean);
    const persons = [...spouses, ...f.children];
    state.path = null;
    setHighlight('set', null, { persons, label: 'Union ' + spouses.map(s => K.get(s).name).join(' & ') });
    openPanel(
      el('h2', { text: 'Union' }),
      el('ul', { class: 'plist' }, spouses.map(s => plink(s))),
      el('dl', { class: 'facts' }, ...eventRow('Mariage', f.marriage), ...eventRow('Divorce', f.divorce)),
      c ? el('div', { class: 'relation-box' },
        el('div', { text: 'Union consanguine' }),
        el('div', { class: 'big', text: K.get(f.wife).name + ' est ' + c.name + ' de ' + K.get(f.husb).name }),
        el('div', { class: 'tagrow' }, el('button', { class: 'btn small', onclick: () => showRelation(f.husb, f.wife) }, 'Voir le lien'))) : null,
      section('Enfants (' + f.children.length + ')', f.children.length ? el('ul', { class: 'plist' }, f.children.map(x => plink(x))) : null),
    );
  }

  function pathList(path) {
    const K = state.K;
    return el('ol', { class: 'path' }, path.map((step, i) => {
      const li = el('li', {});
      if (i > 0) {
        li.append(el('span', { class: 'via', text: '↓ ' + K.stepLabel(path[i - 1].id, step.id, step.via) + ' : ' }));
      }
      li.append(el('a', { class: 'plink', href: '#', onclick: e => { e.preventDefault(); select(step.id, { fly: true }); } }, K.get(step.id).name));
      return li;
    }));
  }

  function showRelation(a, b) {
    const K = state.K;
    const A = K.get(a);
    const B = K.get(b);
    const r = K.relationship(a, b);
    state.selected = a;
    state.highlight = null;
    const shown = (r.blood && r.bloodPath) || r.path;
    if (settings.focusOnly) {
      settings.focusOnly = false;
      $('#opt-focus').checked = false;
      saveSettings();
      rebuildGraph();
    }
    setPath(a, b, shown);

    const blocks = [];
    if (r.blood) {
      blocks.push(el('div', { class: 'relation-box' },
        el('div', {}, B.name + ' est'),
        el('div', { class: 'big', text: r.blood.name }),
        el('div', {}, 'de ' + A.name),
        el('small', { class: 'muted', text: 'Degré civil : ' + r.blood.civilDegree + ' · ancêtre(s) commun(s) le(s) plus proche(s) : ' +
          r.blood.ancestors.map(x => K.get(x).name).join(' & ') + ' (' + r.blood.d1 + ' et ' + r.blood.d2 + ' générations)' })));
      if (r.common.length > r.blood.ancestors.length) {
        const others = r.common.filter(c => !r.blood.ancestors.includes(c.id)).slice(0, 8);
        blocks.push(el('h3', { text: 'Autres ancêtres communs' }),
          el('ul', { class: 'plist' }, others.map(c => plink(c.id, c.d1 + ' / ' + c.d2 + ' générations'))));
      }
    } else if (r.path) {
      blocks.push(el('div', { class: 'relation-box' },
        el('div', { class: 'big', text: 'Pas de lien de sang connu' }),
        el('div', {}, 'Lien par alliance : ' + (r.path.length - 1) + ' étape(s).')));
    } else {
      blocks.push(el('div', { class: 'relation-box' }, el('div', { class: 'big', text: 'Aucun lien trouvé' }),
        el('div', {}, 'Ces deux personnes appartiennent à des groupes familiaux non reliés dans le fichier.')));
    }
    if (shown) {
      blocks.push(el('h3', { text: 'Chemin (' + (shown.length - 1) + ' étapes)' }), pathList(shown));
      if (r.blood && r.path && r.path.length < shown.length) {
        blocks.push(el('div', { class: 'tagrow' }, el('button', {
          class: 'btn small',
          onclick: () => { setPath(a, b, r.path); fitTo(state.path.nodes); toast('Chemin le plus court (alliances comprises) : ' + (r.path.length - 1) + ' étapes'); },
        }, 'Chemin le plus court avec alliances (' + (r.path.length - 1) + ')')));
      }
    }
    openPanel(
      el('h2', { text: 'Lien de parenté' }),
      el('ul', { class: 'plist' }, plink(a, 'personne de référence'), plink(b)),
      blocks,
      el('div', { class: 'tagrow' },
        el('button', { class: 'btn small', onclick: () => showRelation(b, a) }, 'Inverser'),
        el('button', { class: 'btn small', onclick: () => { state.path = null; select(a); } }, 'Retour à la fiche')),
    );
    if (shown) fitTo(state.path.nodes);
  }

  // ---------------------------------------------------------------------------
  // Recherche
  // ---------------------------------------------------------------------------

  function buildSearchIndex() {
    state.searchIndex = [...state.data.individuals.values()].map(ind => ({
      id: ind.id,
      key: norm(ind.name + ' ' + ind.surname + ' ' + ind.given + ' ' + ind.id),
      ind,
    }));
  }

  function searchPeople(q, limit = 25) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const e of state.searchIndex) {
      if (terms.every(t => e.key.includes(t))) {
        out.push(e);
        if (out.length >= 400) break;
      }
    }
    // Les noms qui commencent par le texte saisi en premier.
    const first = terms[0];
    out.sort((x, y) => (norm(y.ind.surname).startsWith(first) || norm(y.ind.given).startsWith(first)) -
      (norm(x.ind.surname).startsWith(first) || norm(x.ind.given).startsWith(first)) || x.ind.name.localeCompare(y.ind.name));
    return out.slice(0, limit);
  }

  function attachSearch(input, list, onPick) {
    let items = [];
    let active = -1;
    const render = () => {
      list.replaceChildren(...items.map((e, i) => el('li', {
        class: i === active ? 'active' : '',
        onmousedown: ev => { ev.preventDefault(); pick(i); },
      }, el('span', { text: e.ind.name }), el('small', { text: lifeSpan(e.ind) }))));
      list.hidden = !items.length;
    };
    const pick = i => {
      const e = items[i];
      if (!e) return;
      input.value = '';
      items = [];
      render();
      input.blur();
      onPick(e.id);
    };
    input.addEventListener('input', () => { items = state.data ? searchPeople(input.value) : []; active = items.length ? 0 : -1; render(); });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { pick(active); ev.preventDefault(); }
      else if (ev.key === 'Escape') { items = []; render(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    input.addEventListener('focus', () => { if (items.length) list.hidden = false; });
  }

  function closeDropdowns() {
    document.querySelectorAll('.dropdown').forEach(d => { d.hidden = true; });
  }

  // ---------------------------------------------------------------------------
  // Statistiques
  // ---------------------------------------------------------------------------

  function showStats() {
    const { individuals, families } = state.data;
    const K = state.K;
    const inds = [...individuals.values()];
    const count = f => inds.filter(f).length;
    const years = inds.map(i => (i.birth && i.birth.year) || (i.baptism && i.baptism.year)).filter(Boolean).sort((a, b) => a - b);
    const gens = Math.max(...state.gens.values()) + 1;
    const kv = (k, v) => el('div', { class: 'kv' }, el('span', { text: k }), el('b', { text: String(v) }));

    const unions = [...state.consanguine.values()];
    const sizes = state.comps.sizes;

    const surnames = topCounts(inds.map(i => i.surname.toUpperCase()), 15);
    const places = topCounts(inds.map(placeKey), 10);

    const body = $('#stats-body');
    body.replaceChildren(...[
      el('h2', { text: 'Statistiques' }),
      kv('Personnes', individuals.size.toLocaleString('fr-FR')),
      kv('Hommes / femmes / inconnus', count(i => i.sex === 'M') + ' / ' + count(i => i.sex === 'F') + ' / ' + count(i => i.sex === 'U')),
      kv('Unions', families.size.toLocaleString('fr-FR')),
      kv('Générations', gens),
      years.length ? kv('Naissances connues', years.length + ' (de ' + years[0] + ' à ' + years[years.length - 1] + ')') : null,
      kv('Groupes familiaux non reliés', sizes.length),
      sizes.length > 1 ? kv('Taille du plus grand groupe', Math.max(...sizes)) : null,
      kv('Unions consanguines détectées', state.consanguineJob ? 'calcul en cours…' : unions.length),
      unions.length ? [el('h3', { text: 'Unions consanguines' }),
        el('ul', { class: 'plist' }, unions.slice(0, 50).map(u => el('li', {},
          el('a', { class: 'plink', href: '#', onclick: e => { e.preventDefault(); closeSide('stats'); showRelation(u.husb, u.wife); } },
            K.get(u.husb).name + ' & ' + K.get(u.wife).name),
          el('small', { text: ' · elle est ' + u.name + ' (degré ' + u.degree + ')' })))),
        unions.length > 50 ? el('small', { class: 'muted', text: '… ' + (unions.length - 50) + ' autres' }) : null] : null,
      el('h3', { text: 'Patronymes' }),
      el('ul', { class: 'plist' }, surnames.map(([k, n]) => el('li', {},
        el('a', { class: 'plink', href: '#', onclick: e => { e.preventDefault(); highlightGroup('surname', k); } }, k), el('small', { text: ' ' + n })))),
      places.length ? [el('h3', { text: 'Lieux de naissance' }),
        el('ul', { class: 'plist' }, places.map(([k, n]) => el('li', {},
          el('a', { class: 'plink', href: '#', onclick: e => { e.preventDefault(); highlightGroup('place', k); } }, k), el('small', { text: ' ' + n }))))] : null,
    ].flat(2).filter(Boolean));
    closeSide('settings');
    $('#stats').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Panneaux, réglages, divers
  // ---------------------------------------------------------------------------

  function closeSide(...ids) { ids.forEach(id => { $('#' + id).hidden = true; }); }
  // Panneaux de gauche (réglages, statistiques) et de droite (fiche, aide) :
  // un seul ouvert de chaque côté.
  function toggleSide(id) {
    const p = $('#' + id);
    const open = p.hidden;
    closeSide(...(['settings', 'stats'].includes(id) ? ['settings', 'stats'] : ['panel', 'help']));
    p.hidden = !open;
    return open;
  }

  function bindSettings() {
    const bind = (sel, key, onChange, prop = 'value') => {
      const input = $(sel);
      input[prop] = settings[key];
      input.addEventListener('change', () => {
        settings[key] = prop === 'checked' ? input.checked : input.value;
        saveSettings();
        if (state.data) onChange();
      });
    };
    bind('#opt-structure', 'structure', () => {
      state.nodeCache = new Map([...state.nodeCache].filter(([k]) => !k.startsWith('fam:')));
      if (state.highlight) state.highlight.nodes = withFamilies(state.highlight.persons);
      if (state.path) setPath(state.path.a, state.path.b, state.path.steps);
      rebuildGraph();
      renderLegend();
    });
    bind('#opt-layout', 'layout', () => { rebuildGraph(); setTimeout(() => Graph.zoomToFit(800, 40), 1500); });
    bind('#opt-color', 'color', () => { refreshStyles(); renderLegend(); if (state.selected && !$('#panel').hidden && !state.path) showPerson(state.selected); });
    bind('#opt-labels', 'labels', refreshStyles);
    bind('#opt-hide', 'hideOthers', refreshStyles, 'checked');
    bind('#opt-particles', 'particles', refreshStyles, 'checked');
    bind('#opt-group', 'groupSurnames', () => {
      // Le regroupement se lit mieux avec une couleur par patronyme.
      if (settings.groupSurnames && settings.color === 'sex') {
        settings.color = 'surname';
        $('#opt-color').value = 'surname';
        saveSettings();
        refreshStyles();
        renderLegend();
      }
      applyGrouping();
      Graph.d3ReheatSimulation();
      setTimeout(() => Graph.zoomToFit(800, 40), 2500);
    }, 'checked');

    // Curseurs : effet immédiat pendant le glissement (limité à une mise à jour par image).
    const slider = (sel, key, onChange) => {
      const input = $(sel);
      const out = $(sel + '-val');
      const show = () => { out.textContent = Math.round(settings[key] * 100) + ' %'; };
      input.value = settings[key];
      show();
      let pending = false;
      input.addEventListener('input', () => {
        settings[key] = parseFloat(input.value);
        show();
        if (pending || !state.data) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; onChange(); });
      });
      input.addEventListener('change', saveSettings);
    };
    slider('#opt-size', 'nodeSize', refreshStyles);
    slider('#opt-group-strength', 'groupStrength', () => {
      if (settings.groupSurnames) { applyLinkForce(); Graph.d3ReheatSimulation(); }
    });
    bind('#opt-focus', 'focusOnly', () => {
      if (settings.focusOnly && !state.selected) toast('Sélectionnez d\'abord une personne.');
      rebuildGraph();
    }, 'checked');
    const radius = $('#opt-radius');
    radius.value = settings.radius;
    $('#opt-radius-val').textContent = settings.radius;
    radius.addEventListener('input', () => { $('#opt-radius-val').textContent = radius.value; });
    const refreshEntourage = () => {
      if (settings.focusOnly) rebuildGraph();
      if (state.highlight && state.highlight.mode === 'neighborhood') setHighlight('neighborhood');
    };
    radius.addEventListener('change', () => {
      settings.radius = parseInt(radius.value, 10);
      saveSettings();
      if (state.data) refreshEntourage();
    });
    bind('#opt-direction', 'direction', refreshEntourage);
    $('#btn-reheat').addEventListener('click', () => {
      for (const n of Graph.graphData().nodes) { delete n.x; delete n.y; delete n.z; delete n.vx; delete n.vy; delete n.vz; }
      rebuildGraph();
    });
    $('#btn-fit').addEventListener('click', () => Graph.zoomToFit(800, 40));
  }

  function screenshot() {
    if (!Graph) return;
    const canvas = Graph.renderer().domElement;
    Graph.renderer().render(Graph.scene(), Graph.camera());
    const a = document.createElement('a');
    a.download = (state.fileName.replace(/\.[^.]+$/, '') || 'arbre') + '-3d.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  function bindUI() {
    const input = $('#file-input');
    const open = () => input.click();
    $('#btn-open').addEventListener('click', open);
    $('#btn-open-2').addEventListener('click', open);
    input.addEventListener('change', () => { loadFile(input.files[0]); input.value = ''; });
    $('#btn-demo').addEventListener('click', () => {
      showLoading();
      setTimeout(() => loadText(window.SAMPLE_GEDCOM, 'famille-exemple.ged', 'UTF-8'), 30);
    });

    // Glisser-déposer n'importe où sur la page.
    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    attachSearch($('#search'), $('#search-results'), id => select(id, { fly: true }));
    $('#btn-settings').addEventListener('click', () => toggleSide('settings'));
    $('#btn-stats').addEventListener('click', () => { if ($('#stats').hidden) showStats(); else closeSide('stats'); });
    $('#btn-help').addEventListener('click', () => toggleSide('help'));
    $('#btn-shot').addEventListener('click', screenshot);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
      closeSide(b.dataset.close);
    }));

    document.addEventListener('keydown', e => {
      const a = document.activeElement;
      const typing = a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search)$/.test(a.type));
      if (e.key === '/' && !typing && state.data) { e.preventDefault(); $('#search').focus(); }
      else if (e.key === 'Escape' && !typing) {
        if (!$('#help').hidden || !$('#settings').hidden || !$('#stats').hidden) closeSide('help', 'settings', 'stats');
        else if (state.data) clearSelection();
      }
    });
    bindSettings();
  }

  bindUI();

  // Point d'accès pour les tests automatisés et la console.
  window.GedcomApp = { state, settings, loadText, select, showRelation, setHighlight, get graph() { return Graph; } };
})();
