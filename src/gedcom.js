/*
 * Lecture et analyse d'un fichier GEDCOM, entièrement dans le navigateur.
 *
 * Expose window.Gedcom = { decode, parse, formatDate, parseYear }.
 *
 * parse(texte) renvoie :
 *   {
 *     individuals: Map<id, Individual>,
 *     families:    Map<id, Family>,
 *     header:      { source, charset, gedcomVersion },
 *     warnings:    string[]
 *   }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Décodage des octets (UTF-8, UTF-16, ANSI/Windows-1252, ANSEL)
  // ---------------------------------------------------------------------------

  // Diacritiques combinants ANSEL (placés AVANT la lettre en ANSEL, après en Unicode).
  const ANSEL_COMBINING = {
    0xe0: '̉', 0xe1: '̀', 0xe2: '́', 0xe3: '̂', 0xe4: '̃',
    0xe5: '̄', 0xe6: '̆', 0xe7: '̇', 0xe8: '̈', 0xe9: '̌',
    0xea: '̊', 0xeb: '︠', 0xec: '︡', 0xed: '̕', 0xee: '̋',
    0xef: '̐', 0xf0: '̧', 0xf1: '̨', 0xf2: '̣', 0xf3: '̤',
    0xf4: '̥', 0xf5: '̳', 0xf6: '̲', 0xf7: '̦', 0xf8: '̜',
    0xf9: '̮', 0xfa: '︢', 0xfb: '︣', 0xfe: '̓',
  };
  const ANSEL_SPACING = {
    0xa1: 'Ł', 0xa2: 'Ø', 0xa3: 'Đ', 0xa4: 'Þ', 0xa5: 'Æ', 0xa6: 'Œ', 0xa7: 'ʹ',
    0xa8: '·', 0xa9: '♭', 0xaa: '®', 0xab: '±', 0xac: 'Ơ', 0xad: 'Ư', 0xae: 'ʼ',
    0xb0: 'ʻ', 0xb1: 'ł', 0xb2: 'ø', 0xb3: 'đ', 0xb4: 'þ', 0xb5: 'æ', 0xb6: 'œ',
    0xb7: 'ʺ', 0xb8: 'ı', 0xb9: '£', 0xba: 'ð', 0xbc: 'ơ', 0xbd: 'ư', 0xc0: '°',
    0xc1: 'ℓ', 0xc2: '℗', 0xc3: '©', 0xc4: '♯', 0xc5: '¿', 0xc6: '¡', 0xc7: 'ß',
    0xc8: '€', 0xcf: 'ß',
  };

  function decodeAnsel(bytes) {
    let out = '';
    let pending = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) {
        const ch = String.fromCharCode(b);
        out += ch + pending;
        pending = '';
      } else if (ANSEL_COMBINING[b]) {
        pending += ANSEL_COMBINING[b];
      } else {
        out += (ANSEL_SPACING[b] || '�') + pending;
        pending = '';
      }
    }
    return (out + pending).normalize('NFC');
  }

  function tryDecode(bytes, label, fatal) {
    try {
      return new TextDecoder(label, { fatal: !!fatal }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /**
   * Transforme le contenu binaire du fichier en texte, en détectant l'encodage
   * à partir du BOM puis de la balise « 1 CHAR » de l'en-tête.
   */
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: tryDecode(bytes.subarray(3), 'utf-8'), charset: 'UTF-8' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: tryDecode(bytes.subarray(2), 'utf-16le'), charset: 'UTF-16LE' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: tryDecode(bytes.subarray(2), 'utf-16be'), charset: 'UTF-16BE' };
    }
    // UTF-16 sans BOM : un octet nul sur deux au début.
    if (bytes.length > 4 && bytes[0] === 0x30 && bytes[1] === 0x00) {
      return { text: tryDecode(bytes, 'utf-16le'), charset: 'UTF-16LE' };
    }
    if (bytes.length > 4 && bytes[0] === 0x00 && bytes[1] === 0x30) {
      return { text: tryDecode(bytes, 'utf-16be'), charset: 'UTF-16BE' };
    }

    const head = tryDecode(bytes.subarray(0, 8192), 'latin1') || '';
    const m = head.match(/^\s*1\s+CHAR\s+(.+?)\s*$/m);
    const declared = m ? m[1].toUpperCase() : '';

    if (declared === 'ANSEL') {
      return { text: decodeAnsel(bytes), charset: 'ANSEL' };
    }
    if (declared === 'ANSI' || declared.startsWith('WINDOWS') || declared.startsWith('CP125') ||
        declared.startsWith('ISO') || declared === 'LATIN1' || declared === 'IBMPC') {
      const asUtf8 = tryDecode(bytes, 'utf-8', true);
      // Certains logiciels déclarent ANSI mais écrivent de l'UTF-8.
      if (asUtf8 !== null && /[À-ſ]/.test(asUtf8)) {
        return { text: asUtf8, charset: 'UTF-8 (déclaré ' + declared + ')' };
      }
      return { text: tryDecode(bytes, 'windows-1252'), charset: declared };
    }
    const utf8 = tryDecode(bytes, 'utf-8', true);
    if (utf8 !== null) return { text: utf8, charset: declared || 'UTF-8' };
    return { text: tryDecode(bytes, 'windows-1252'), charset: 'Windows-1252 (repli)' };
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------

  const MONTHS = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
    'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  // Calendrier républicain : mois → décalage de l'année grégorienne (An N → 1791+N ou 1792+N)
  const FRENCH_MONTHS = {
    VEND: ['vendémiaire', 1791], BRUM: ['brumaire', 1791], FRIM: ['frimaire', 1791],
    NIVO: ['nivôse', 1791], PLUV: ['pluviôse', 1792], VENT: ['ventôse', 1792],
    GERM: ['germinal', 1792], FLOR: ['floréal', 1792], PRAI: ['prairial', 1792],
    MESS: ['messidor', 1792], THER: ['thermidor', 1792], FRUC: ['fructidor', 1792],
    COMP: ['jours complémentaires', 1792],
  };

  /** Extrait une année (approximative) d'une date GEDCOM, ou null. */
  function parseYear(raw) {
    if (!raw) return null;
    const s = String(raw).toUpperCase();
    const fr = s.match(/@#DFRENCH R@\s*(?:(\d{1,2})\s+)?([A-Z]{4})?\s*(?:AN\s*)?(\d{1,2})\b/);
    if (fr) {
      const month = FRENCH_MONTHS[fr[2]];
      return parseInt(fr[3], 10) + (month ? month[1] : 1792);
    }
    const years = s.match(/\b\d{3,4}\b/g);
    if (!years) return null;
    const nums = years.map(Number).filter(y => y > 500 && y < 2200);
    if (!nums.length) return null;
    if (/\bBET\b/.test(s) && nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
    return nums[0];
  }

  function formatSimpleDate(part) {
    part = part.trim();
    const fr = part.match(/^@#DFRENCH R@\s*(?:(\d{1,2})\s+)?(?:([A-Z]{4})\s+)?(?:AN\s*)?(\d{1,2})$/i);
    if (fr) {
      const month = fr[2] && FRENCH_MONTHS[fr[2].toUpperCase()];
      const year = parseInt(fr[3], 10);
      const greg = year + (month ? month[1] : 1792);
      return [fr[1], month ? month[0] : null, 'an ' + year].filter(Boolean).join(' ') + ' (≈ ' + greg + ')';
    }
    part = part.replace(/^@#D[A-Z ]+@\s*/i, '');
    const m = part.match(/^(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{1,4}(?:\/\d{1,2})?)(\s*B\.?C\.?)?$/i);
    if (!m) return part;
    const day = m[1] ? (m[1] === '1' ? '1er' : String(parseInt(m[1], 10))) : null;
    const month = m[2] ? MONTHS_FR[(MONTHS[m[2].toUpperCase()] || 0) - 1] || m[2] : null;
    return [day, month, m[3]].filter(Boolean).join(' ') + (m[4] ? ' av. J.-C.' : '');
  }

  /** Rend une date GEDCOM lisible en français. */
  function formatDate(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    let m;
    if ((m = s.match(/^BET\s+(.+?)\s+AND\s+(.+)$/i))) return 'entre ' + formatSimpleDate(m[1]) + ' et ' + formatSimpleDate(m[2]);
    if ((m = s.match(/^FROM\s+(.+?)\s+TO\s+(.+)$/i))) return 'de ' + formatSimpleDate(m[1]) + ' à ' + formatSimpleDate(m[2]);
    if ((m = s.match(/^\((.*)\)$/))) return m[1];
    const prefixes = {
      ABT: 'vers', ABOUT: 'vers', CIRCA: 'vers', CA: 'vers', EST: 'estimé', CAL: 'calculé',
      BEF: 'avant', AFT: 'après', FROM: 'depuis', TO: "jusqu'à", INT: '',
    };
    if ((m = s.match(/^([A-Z]+)\.?\s+(.+)$/i)) && prefixes[m[1].toUpperCase()] !== undefined) {
      const p = prefixes[m[1].toUpperCase()];
      return (p ? p + ' ' : '') + formatSimpleDate(m[2].replace(/\s*\(.*\)$/, ''));
    }
    return formatSimpleDate(s);
  }

  // ---------------------------------------------------------------------------
  // Analyse syntaxique
  // ---------------------------------------------------------------------------

  const LINE_RE = /^\s*(\d{1,2})\s+(?:(@[^@\s]+@)\s+)?([A-Za-z0-9_]+)(?:\s(.*))?$/;

  /** Construit l'arbre des enregistrements (niveau 0 et leurs sous-balises). */
  function parseRecords(text, warnings) {
    const lines = text.split(/\r\n|\r|\n/);
    const records = [];
    const stack = [];
    let bad = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = LINE_RE.exec(line);
      if (!m) {
        // Ligne de continuation sans balise : on la rattache à la précédente.
        if (stack.length) stack[stack.length - 1].value += '\n' + line;
        else bad++;
        continue;
      }
      const level = parseInt(m[1], 10);
      const node = { level, xref: m[2] || null, tag: m[3].toUpperCase(), value: m[4] || '', children: [] };

      if (node.tag === 'CONC' || node.tag === 'CONT') {
        const parent = stack[level - 1];
        if (parent) parent.value += (node.tag === 'CONT' ? '\n' : '') + node.value;
        continue;
      }
      stack.length = level;
      if (level === 0) {
        records.push(node);
      } else if (stack[level - 1]) {
        stack[level - 1].children.push(node);
      } else {
        bad++;
        continue;
      }
      stack[level] = node;
    }
    if (bad) warnings.push(bad + ' ligne(s) illisible(s) ignorée(s).');
    return records;
  }

  const child = (node, tag) => node.children.find(c => c.tag === tag);
  const childValue = (node, tag) => {
    const c = child(node, tag);
    return c ? c.value.trim() : '';
  };

  function readEvent(node) {
    if (!node) return null;
    const date = childValue(node, 'DATE');
    const place = childValue(node, 'PLAC');
    if (!date && !place && node.value !== 'Y') return null;
    return { date, place, year: parseYear(date), text: formatDate(date) };
  }

  function cleanName(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function readName(indi) {
    const nameNode = child(indi, 'NAME');
    let given = '', surname = '';
    if (nameNode) {
      const raw = nameNode.value;
      const m = raw.match(/^([^/]*)\/([^/]*)\/?(.*)$/);
      if (m) {
        given = cleanName(m[1] + ' ' + m[3]);
        surname = cleanName(m[2]);
      } else {
        given = cleanName(raw);
      }
      if (!given) given = childValue(nameNode, 'GIVN');
      if (!surname) surname = childValue(nameNode, 'SURN');
    }
    return { given, surname };
  }

  const refId = v => (v || '').trim().replace(/^@|@$/g, '');

  function parse(text) {
    const warnings = [];
    const records = parseRecords(text, warnings);
    const individuals = new Map();
    const families = new Map();
    const header = {};

    for (const rec of records) {
      if (rec.tag === 'HEAD') {
        header.source = childValue(rec, 'SOUR');
        header.charset = childValue(rec, 'CHAR');
        const g = child(rec, 'GEDC');
        if (g) header.gedcomVersion = childValue(g, 'VERS');
      } else if (rec.tag === 'INDI' && rec.xref) {
        const id = refId(rec.xref);
        const { given, surname } = readName(rec);
        const sexRaw = childValue(rec, 'SEX').toUpperCase();
        const birth = readEvent(child(rec, 'BIRT'));
        const baptism = readEvent(child(rec, 'CHR')) || readEvent(child(rec, 'BAPM'));
        const death = readEvent(child(rec, 'DEAT'));
        const burial = readEvent(child(rec, 'BURI'));
        const occupations = rec.children.filter(c => c.tag === 'OCCU' && c.value.trim()).map(c => c.value.trim());
        const notes = rec.children.filter(c => c.tag === 'NOTE' && c.value && !/^@.*@$/.test(c.value.trim()))
          .map(c => c.value.trim());
        individuals.set(id, {
          id,
          given,
          surname,
          name: cleanName(given + ' ' + surname) || '(sans nom)',
          sex: sexRaw === 'M' || sexRaw === 'F' ? sexRaw : 'U',
          birth, baptism, death, burial,
          occupations,
          notes,
          famc: rec.children.filter(c => c.tag === 'FAMC').map(c => refId(c.value)),
          fams: rec.children.filter(c => c.tag === 'FAMS').map(c => refId(c.value)),
        });
      } else if (rec.tag === 'FAM' && rec.xref) {
        const id = refId(rec.xref);
        families.set(id, {
          id,
          husb: refId(childValue(rec, 'HUSB')) || null,
          wife: refId(childValue(rec, 'WIFE')) || null,
          children: rec.children.filter(c => c.tag === 'CHIL').map(c => refId(c.value)),
          marriage: readEvent(child(rec, 'MARR')),
          divorce: readEvent(child(rec, 'DIV')),
        });
      }
    }

    // Réconciliation : les liens peuvent n'être déclarés que d'un seul côté.
    let dangling = 0;
    for (const fam of families.values()) {
      for (const role of ['husb', 'wife']) {
        if (fam[role] && !individuals.has(fam[role])) { fam[role] = null; dangling++; }
      }
      fam.children = [...new Set(fam.children)].filter(c => individuals.has(c) || (dangling++, false));
    }
    for (const ind of individuals.values()) {
      for (const fid of ind.famc) {
        const fam = families.get(fid);
        if (fam && !fam.children.includes(ind.id)) fam.children.push(ind.id);
      }
      for (const fid of ind.fams) {
        const fam = families.get(fid);
        if (!fam) continue;
        if (fam.husb !== ind.id && fam.wife !== ind.id) {
          if (!fam.husb && ind.sex !== 'F') fam.husb = ind.id;
          else if (!fam.wife) fam.wife = ind.id;
          else if (!fam.husb) fam.husb = ind.id;
        }
      }
    }
    for (const ind of individuals.values()) { ind.famc = []; ind.fams = []; }
    for (const fam of families.values()) {
      if (fam.husb) individuals.get(fam.husb).fams.push(fam.id);
      if (fam.wife && fam.wife !== fam.husb) individuals.get(fam.wife).fams.push(fam.id);
      for (const c of fam.children) individuals.get(c).famc.push(fam.id);
    }
    if (dangling) warnings.push(dangling + ' référence(s) vers des personnes absentes ignorée(s).');
    if (!individuals.size) warnings.push('Aucune personne (INDI) trouvée : est-ce bien un fichier GEDCOM ?');

    return { individuals, families, header, warnings };
  }

  window.Gedcom = { decode, parse, formatDate, parseYear };
})();
