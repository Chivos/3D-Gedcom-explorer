/*
 * Calculs généalogiques sur les données issues de Gedcom.parse :
 * parents/enfants, générations, années estimées, chemin le plus court entre
 * deux personnes, nom du lien de parenté, implexe, unions consanguines.
 *
 * Expose window.Kinship.create(data) → objet d'analyse.
 */
(function () {
  'use strict';

  const GEN_YEARS = 28; // écart moyen entre générations, pour les estimations

  function create(data) {
    const { individuals, families } = data;

    const get = id => individuals.get(id);

    // Listes d'adjacence calculées une fois (ne pas modifier les tableaux renvoyés).
    const EMPTY = Object.freeze([]);
    const parentsMap = new Map();
    const childrenMap = new Map();
    const spousesMap = new Map();
    const siblingsMap = new Map();
    const push = (map, k, v) => {
      const a = map.get(k);
      if (!a) map.set(k, [v]);
      else if (!a.includes(v)) a.push(v);
    };
    for (const f of families.values()) {
      const parents = [f.husb, f.wife].filter(Boolean);
      for (const c of f.children) {
        for (const p of parents) { push(parentsMap, c, p); push(childrenMap, p, c); }
        for (const c2 of f.children) if (c2 !== c) push(siblingsMap, c, c2);
      }
      if (f.husb && f.wife && f.husb !== f.wife) { push(spousesMap, f.husb, f.wife); push(spousesMap, f.wife, f.husb); }
    }
    const parentsOf = id => parentsMap.get(id) || EMPTY;
    const childrenOf = id => childrenMap.get(id) || EMPTY;
    const spousesOf = id => spousesMap.get(id) || EMPTY;
    const siblingsOf = id => siblingsMap.get(id) || EMPTY;

    /** Ancêtres → Map(id, profondeur minimale). */
    function ancestors(id, maxDepth = Infinity) {
      const depth = new Map();
      let frontier = [id];
      for (let d = 1; frontier.length && d <= maxDepth; d++) {
        const next = [];
        for (const p of frontier) {
          for (const q of parentsOf(p)) {
            if (!depth.has(q) && q !== id) { depth.set(q, d); next.push(q); }
          }
        }
        frontier = next;
      }
      return depth;
    }

    /** Descendants → Map(id, profondeur minimale). */
    function descendants(id, maxDepth = Infinity) {
      const depth = new Map();
      let frontier = [id];
      for (let d = 1; frontier.length && d <= maxDepth; d++) {
        const next = [];
        for (const p of frontier) {
          for (const q of childrenOf(p)) {
            if (!depth.has(q) && q !== id) { depth.set(q, d); next.push(q); }
          }
        }
        frontier = next;
      }
      return depth;
    }

    /** Toutes les personnes à moins de `radius` liens (parent, enfant, conjoint). */
    function neighborhood(id, radius) {
      const seen = new Map([[id, 0]]);
      let frontier = [id];
      for (let d = 1; frontier.length && d <= radius; d++) {
        const next = [];
        for (const p of frontier) {
          for (const q of [...parentsOf(p), ...childrenOf(p), ...spousesOf(p)]) {
            if (!seen.has(q)) { seen.set(q, d); next.push(q); }
          }
        }
        frontier = next;
      }
      return seen;
    }

    /**
     * Chemin le plus court entre a et b dans le graphe (parent, enfant, conjoint).
     * Renvoie [{id, via}] où via décrit le lien depuis l'étape précédente.
     */
    function shortestPath(a, b, { bloodOnly = false } = {}) {
      if (!get(a) || !get(b)) return null;
      if (a === b) return [{ id: a, via: null }];
      const prev = new Map([[a, null]]);
      let frontier = [a];
      while (frontier.length) {
        const next = [];
        for (const p of frontier) {
          const steps = [
            ...parentsOf(p).map(q => [q, 'parent']),
            ...childrenOf(p).map(q => [q, 'child']),
            ...(bloodOnly ? [] : spousesOf(p).map(q => [q, 'spouse'])),
          ];
          for (const [q, via] of steps) {
            if (prev.has(q)) continue;
            prev.set(q, { from: p, via });
            if (q === b) {
              const path = [];
              let cur = b;
              while (cur !== null) {
                const info = prev.get(cur);
                path.unshift({ id: cur, via: info ? info.via : null });
                cur = info ? info.from : null;
              }
              return path;
            }
            next.push(q);
          }
        }
        frontier = next;
      }
      return null;
    }

    /** Chemin ascendant le plus court de `from` jusqu'à son ancêtre `to` (liste d'ids). */
    function upPath(from, to) {
      const prev = new Map([[from, null]]);
      let frontier = [from];
      while (frontier.length && !prev.has(to)) {
        const next = [];
        for (const p of frontier) {
          for (const q of parentsOf(p)) {
            if (!prev.has(q)) { prev.set(q, p); next.push(q); }
          }
        }
        frontier = next;
      }
      if (!prev.has(to)) return null;
      const out = [];
      for (let cur = to; cur !== null; cur = prev.get(cur)) out.unshift(cur);
      return out;
    }

    /** Chemin de a à b passant par leur ancêtre commun x : a ↑ x ↓ b. */
    function pathThrough(a, b, x) {
      const up = upPath(a, x);
      const down = upPath(b, x);
      if (!up || !down) return null;
      const steps = up.map((id, i) => ({ id, via: i ? 'parent' : null }));
      for (let i = down.length - 2; i >= 0; i--) steps.push({ id: down[i], via: 'child' });
      return steps;
    }

    /** Ancêtres communs les plus proches de a et b (non ancêtres d'un autre commun). */
    function commonAncestors(a, b) {
      const da = ancestors(a);
      da.set(a, 0);
      const db = ancestors(b);
      db.set(b, 0);
      const common = [];
      for (const [id, d1] of da) {
        if (db.has(id)) common.push({ id, d1, d2: db.get(id) });
      }
      if (!common.length) return [];
      const commonSet = new Set(common.map(c => c.id));
      // On écarte les ancêtres communs qui sont eux-mêmes ancêtres d'un autre ancêtre commun.
      const redundant = new Set();
      const visited = new Set();
      const stack = [];
      for (const c of common) stack.push(...parentsOf(c.id));
      while (stack.length) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        if (commonSet.has(id)) redundant.add(id);
        stack.push(...parentsOf(id));
      }
      return common.filter(c => !redundant.has(c.id)).sort((x, y) => (x.d1 + x.d2) - (y.d1 + y.d2));
    }

    const word = (sex, m, f, n) => (sex === 'M' ? m : sex === 'F' ? f : n || m + '/' + f);

    function ordinalCousin(n) {
      // n = nombre de générations jusqu'à l'ancêtre commun (2 = germain)
      if (n === 2) return ['cousin germain', 'cousine germaine'];
      if (n === 3) return ['cousin issu de germain', 'cousine issue de germain'];
      if (n === 4) return ["cousin issu d'issu de germain", "cousine issue d'issu de germain"];
      return ['cousin au ' + (n - 1) + 'e degré', 'cousine au ' + (n - 1) + 'e degré'];
    }

    /**
     * Nom du lien de parenté de B vis-à-vis de A, à partir des distances
     * d1 (A → ancêtre commun) et d2 (B → ancêtre commun).
     */
    function relationName(d1, d2, sexB, half) {
      const s = sexB;
      if (d1 === 0 && d2 === 0) return 'la même personne';
      if (d1 === 0) {
        if (d2 === 1) return word(s, 'fils', 'fille', 'enfant');
        if (d2 === 2) return word(s, 'petit-fils', 'petite-fille', 'petit-enfant');
        if (d2 <= 4) {
          const pre = 'arrière-'.repeat(d2 - 2);
          return word(s, pre + 'petit-fils', pre + 'petite-fille', pre + 'petit-enfant');
        }
        return word(s, 'descendant', 'descendante') + ' à la ' + d2 + 'e génération';
      }
      if (d2 === 0) {
        if (d1 === 1) return word(s, 'père', 'mère', 'parent');
        if (d1 === 2) return word(s, 'grand-père', 'grand-mère', 'grand-parent');
        if (d1 <= 4) {
          const pre = 'arrière-'.repeat(d1 - 2);
          return word(s, pre + 'grand-père', pre + 'grand-mère', pre + 'grand-parent');
        }
        return word(s, 'ancêtre', 'ancêtre') + ' à la ' + d1 + 'e génération';
      }
      const demi = half ? 'demi-' : '';
      if (d1 === 1 && d2 === 1) return demi + word(s, 'frère', 'sœur', 'frère/sœur');
      if (d1 === 1) {
        if (d2 === 2) return demi + word(s, 'neveu', 'nièce');
        const pre = 'arrière-'.repeat(d2 - 3);
        return demi + word(s, pre + 'petit-neveu', pre + 'petite-nièce');
      }
      if (d2 === 1) {
        if (d1 === 2) return demi + word(s, 'oncle', 'tante');
        const pre = 'arrière-'.repeat(d1 - 3);
        return demi + word(s, pre + 'grand-oncle', pre + 'grand-tante');
      }
      const [m, f] = ordinalCousin(Math.min(d1, d2));
      if (d1 === d2) return demi + word(s, m, f);
      // Générations décalées : cousin d'un ascendant, ou descendant d'un cousin.
      const gap = Math.abs(d1 - d2);
      if (d1 > d2) {
        const anc = ['', "d'un parent", "d'un grand-parent", "d'un arrière-grand-parent"][gap] ||
          "d'un ancêtre à la " + gap + 'e génération';
        return demi + word(s, m, f) + ' ' + anc;
      }
      const desc = gap === 1 ? word(s, 'fils', 'fille', 'enfant')
        : gap === 2 ? word(s, 'petit-fils', 'petite-fille', 'petit-enfant')
          : word(s, 'descendant', 'descendante') + ' (' + gap + 'e génération)';
      const neutral = m.replace(/^cousin/, 'cousin(e)').replace(/ germain$/, ' germain(e)').replace(/issu /, 'issu(e) ');
      return desc + " d'un(e) " + demi + neutral;
    }

    /** Description du lien entre a et b : parenté de sang si elle existe, sinon chemin. */
    function relationship(a, b) {
      const B = get(b);
      if (!B) return null;
      const common = commonAncestors(a, b);
      const result = { common, blood: null, path: shortestPath(a, b), bloodPath: null };
      if (common.length) {
        const best = common[0];
        const sameLevel = common.filter(c => c.d1 === best.d1 && c.d2 === best.d2);
        // demi-frère, demi-cousin… : un seul ancêtre commun le plus proche
        const half = best.d1 > 0 && best.d2 > 0 && sameLevel.length === 1;
        result.blood = {
          name: relationName(best.d1, best.d2, B.sex, half),
          d1: best.d1,
          d2: best.d2,
          civilDegree: best.d1 + best.d2,
          ancestors: sameLevel.map(c => c.id),
        };
        result.bloodPath = pathThrough(a, b, best.id);
      }
      return result;
    }

    /** Description d'une étape de chemin : « X est le père de Y », etc. */
    function stepLabel(fromId, toId, via) {
      const to = get(toId);
      const s = to ? to.sex : 'U';
      if (via === 'parent') return word(s, 'père', 'mère', 'parent');
      if (via === 'child') return word(s, 'fils', 'fille', 'enfant');
      if (via === 'spouse') return word(s, 'époux', 'épouse', 'conjoint');
      return '';
    }

    /**
     * Implexe : ancêtres atteints par plusieurs chemins.
     * Renvoie { repeated: [{id, paths, depths}], distinct, theoretical, rate, maxDepth }.
     */
    function implex(id, maxDepth = 30) {
      // Nombre de chemins vers chaque ancêtre, génération par génération.
      const paths = new Map();
      const depths = new Map();
      let level = new Map([[id, 1]]);
      let theoretical = 0;
      let reachedDepth = 0;
      for (let d = 1; d <= maxDepth && level.size; d++) {
        const next = new Map();
        for (const [p, n] of level) {
          for (const q of parentsOf(p)) {
            next.set(q, (next.get(q) || 0) + n);
          }
        }
        if (!next.size) break;
        reachedDepth = d;
        theoretical += Math.pow(2, d);
        for (const [q, n] of next) {
          paths.set(q, (paths.get(q) || 0) + n);
          if (!depths.has(q)) depths.set(q, []);
          depths.get(q).push(d);
        }
        level = next;
      }
      const repeated = [];
      for (const [q, n] of paths) {
        if (n > 1) repeated.push({ id: q, paths: n, depths: [...new Set(depths.get(q))] });
      }
      repeated.sort((x, y) => Math.min(...x.depths) - Math.min(...y.depths) || y.paths - x.paths);
      let totalPaths = 0;
      for (const n of paths.values()) totalPaths += n;
      const distinct = paths.size;
      return {
        repeated,
        distinct,
        totalPaths,
        // Taux d'implexe sur les ancêtres connus : part des « places » occupées par des doublons.
        rate: totalPaths ? 1 - distinct / totalPaths : 0,
        theoretical,
        maxDepth: reachedDepth,
      };
    }

    /**
     * Union consanguine ? Renvoie {name, degree} ou null. Le plus proche ancêtre
     * commun (somme d1+d2 minimale) ne peut pas être ancêtre d'un autre ancêtre
     * commun : pas besoin de filtrer les ancêtres « redondants » ici.
     */
    function unionKinship(f, maxDepth = 12) {
      if (!f.husb || !f.wife) return null;
      const ah = ancestors(f.husb, maxDepth);
      if (!ah.size) return null;
      const aw = ancestors(f.wife, maxDepth);
      let best = null;
      let ties = 0;
      for (const [id, d2] of aw) {
        const d1 = ah.get(id);
        if (d1 === undefined) continue;
        if (!best || d1 + d2 < best.d1 + best.d2) { best = { d1, d2 }; ties = 1; }
        else if (d1 === best.d1 && d2 === best.d2) ties++;
      }
      if (!best) return null;
      return { family: f.id, husb: f.husb, wife: f.wife, name: relationName(best.d1, best.d2, 'F', ties === 1), degree: best.d1 + best.d2 };
    }

    /** Unions dont les deux conjoints ont un ancêtre commun (dans maxDepth générations). */
    function consanguineousUnions(maxDepth = 12) {
      const out = [];
      for (const f of families.values()) {
        const u = unionKinship(f, maxDepth);
        if (u) out.push(u);
      }
      return out.sort((x, y) => x.degree - y.degree);
    }

    /**
     * Niveau de génération de chaque personne (0 = plus ancien) :
     * enfant ≥ parent + 1, conjoints alignés. Robuste aux boucles de données.
     */
    function generations() {
      const level = new Map();
      for (const id of individuals.keys()) level.set(id, 0);
      const ids = [...individuals.keys()];
      const n = ids.length;
      for (let iter = 0; iter < 60; iter++) {
        let changed = false;
        for (const f of families.values()) {
          let base = 0;
          if (f.husb) base = Math.max(base, level.get(f.husb));
          if (f.wife) base = Math.max(base, level.get(f.wife));
          if (f.husb && level.get(f.husb) < base) { level.set(f.husb, base); changed = true; }
          if (f.wife && level.get(f.wife) < base) { level.set(f.wife, base); changed = true; }
          for (const c of f.children) {
            if (level.get(c) < base + 1 && base + 1 < n) { level.set(c, base + 1); changed = true; }
          }
        }
        if (!changed) break;
      }
      // Remonter les personnes sans parents connus près de leurs enfants
      // (évite qu'un conjoint rapporté flotte tout en haut).
      for (let iter = 0; iter < 30; iter++) {
        let changed = false;
        for (const id of ids) {
          if (parentsOf(id).length) continue;
          const kids = childrenOf(id);
          const sp = spousesOf(id);
          let target = level.get(id);
          if (kids.length) target = Math.max(target, Math.min(...kids.map(k => level.get(k))) - 1);
          if (sp.length) target = Math.max(target, ...sp.map(x => level.get(x)));
          if (target !== level.get(id)) { level.set(id, target); changed = true; }
        }
        if (!changed) break;
      }
      return level;
    }

    /** Année de naissance connue ou estimée de chaque personne → Map(id, {year, estimated}). */
    function estimatedYears() {
      const out = new Map();
      for (const ind of individuals.values()) {
        const y = (ind.birth && ind.birth.year) || (ind.baptism && ind.baptism.year);
        if (y) out.set(ind.id, { year: y, estimated: false });
      }
      // Estimations directes : mariage, décès.
      for (const ind of individuals.values()) {
        if (out.has(ind.id)) continue;
        const marr = ind.fams.map(f => families.get(f)).map(f => f && f.marriage && f.marriage.year).filter(Boolean);
        if (marr.length) { out.set(ind.id, { year: Math.min(...marr) - 25, estimated: true }); continue; }
        const d = (ind.death && ind.death.year) || (ind.burial && ind.burial.year);
        if (d) out.set(ind.id, { year: d - 55, estimated: true });
      }
      // Propagation par la famille.
      for (let iter = 0; iter < 40; iter++) {
        let changed = false;
        for (const ind of individuals.values()) {
          if (out.has(ind.id)) continue;
          const cands = [];
          for (const p of parentsOf(ind.id)) if (out.has(p)) cands.push(out.get(p).year + GEN_YEARS);
          for (const c of childrenOf(ind.id)) if (out.has(c)) cands.push(out.get(c).year - GEN_YEARS);
          for (const s of spousesOf(ind.id)) if (out.has(s)) cands.push(out.get(s).year);
          for (const s of siblingsOf(ind.id)) if (out.has(s)) cands.push(out.get(s).year);
          if (cands.length) {
            out.set(ind.id, { year: Math.round(cands.reduce((a, b) => a + b, 0) / cands.length), estimated: true });
            changed = true;
          }
        }
        if (!changed) break;
      }
      return out;
    }

    /** Composantes connexes (groupes de personnes reliées entre elles). */
    function components() {
      const comp = new Map();
      let count = 0;
      const sizes = [];
      for (const id of individuals.keys()) {
        if (comp.has(id)) continue;
        const stack = [id];
        comp.set(id, count);
        let size = 0;
        while (stack.length) {
          const p = stack.pop();
          size++;
          for (const q of [...parentsOf(p), ...childrenOf(p), ...spousesOf(p)]) {
            if (!comp.has(q)) { comp.set(q, count); stack.push(q); }
          }
        }
        sizes.push(size);
        count++;
      }
      return { comp, sizes };
    }

    return {
      data,
      get,
      parentsOf, childrenOf, spousesOf, siblingsOf,
      ancestors, descendants, neighborhood,
      shortestPath, commonAncestors, relationship, relationName, stepLabel,
      implex, unionKinship, consanguineousUnions,
      generations, estimatedYears, components,
    };
  }

  window.Kinship = { create };
})();
