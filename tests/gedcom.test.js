// Tests du parseur GEDCOM et des calculs de parenté : `npm test`
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global;
require('../src/gedcom.js');
require('../src/kinship.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'examples', 'famille-exemple.ged'));
const data = Gedcom.parse(Gedcom.decode(sample).text);
const K = Kinship.create(data);

test('lecture du fichier exemple', () => {
  assert.strictEqual(data.individuals.size, 48);
  assert.strictEqual(data.families.size, 23);
  assert.deepStrictEqual(data.warnings, []);
  const lucien = K.get('I41');
  assert.strictEqual(lucien.name, 'Lucien MARTIN');
  assert.strictEqual(lucien.birth.year, 1887);
  assert.deepStrictEqual(K.parentsOf('I41'), ['I37', 'I38']);
});

test('encodages ANSEL et ANSI', () => {
  const ansel = Buffer.from('0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME Ren\xe2ee /No\xe8el/\n0 TRLR\n', 'latin1');
  assert.strictEqual(Gedcom.parse(Gedcom.decode(ansel).text).individuals.get('I1').name, 'Renée Noël');
  const ansi = Buffer.from('0 HEAD\n1 CHAR ANSI\n0 @I1@ INDI\n1 NAME Ren\xe9e /No\xebl/\n0 TRLR\n', 'latin1');
  assert.strictEqual(Gedcom.parse(Gedcom.decode(ansi).text).individuals.get('I1').name, 'Renée Noël');
});

test('dates', () => {
  assert.strictEqual(Gedcom.formatDate('ABT 1 JAN 1750'), 'vers 1er janvier 1750');
  assert.strictEqual(Gedcom.formatDate('BET 1884 AND 1886'), 'entre 1884 et 1886');
  assert.strictEqual(Gedcom.formatDate('@#DFRENCH R@ 12 FLOR 8'), '12 floréal an 8 (≈ 1800)');
  assert.strictEqual(Gedcom.parseYear('@#DFRENCH R@ 3 VEND 10'), 1801);
  assert.strictEqual(Gedcom.parseYear('BET 1740 AND 1750'), 1745);
});

test('CONC / CONT et liens déclarés d\'un seul côté', () => {
  const g = Gedcom.parse([
    '0 @I1@ INDI', '1 NAME Jean /A/', '1 NOTE début', '2 CONC  suite', '2 CONT ligne 2',
    '0 @I2@ INDI', '1 NAME Paul /A/', '1 FAMC @F1@',
    '0 @F1@ FAM', '1 HUSB @I1@',
  ].join('\n'));
  assert.strictEqual(g.individuals.get('I1').notes[0], 'début suite\nligne 2');
  assert.deepStrictEqual(g.families.get('F1').children, ['I2']);
  assert.deepStrictEqual(g.individuals.get('I1').fams, ['F1']);
});

test('noms de liens de parenté', () => {
  const rel = (a, b) => K.relationship(a, b).blood.name;
  assert.strictEqual(rel('I41', 'I37'), 'père');
  assert.strictEqual(rel('I41', 'I44'), 'nièce');
  assert.strictEqual(rel('I27', 'I28'), 'demi-sœur');
  assert.strictEqual(rel('I10', 'I13'), 'cousine germaine');
  assert.strictEqual(rel('I16', 'I21'), 'cousine issue de germain');
  assert.strictEqual(rel('I3', 'I12'), 'neveu');
  assert.strictEqual(K.relationship('I45', 'I1').blood, null);
});

test('chemin par l\'ancêtre commun', () => {
  const r = K.relationship('I41', 'I40');
  assert.deepStrictEqual(r.blood.ancestors, ['I19']);
  assert.deepStrictEqual(r.bloodPath.map(s => s.id), ['I41', 'I38', 'I33', 'I27', 'I19', 'I28', 'I35', 'I40']);
});

test('implexe et unions consanguines', () => {
  const imp = K.implex('I41');
  assert.ok(imp.repeated.some(r => r.id === 'I16' && r.paths === 3));
  const unions = K.consanguineousUnions();
  assert.strictEqual(unions.length, 8);
  assert.ok(unions.some(u => u.family === 'F6' && u.name === 'cousine germaine'));
});

test('générations et années estimées', () => {
  const gens = K.generations();
  assert.strictEqual(gens.get('I1'), 0);
  assert.strictEqual(gens.get('I41'), 7);
  assert.strictEqual(gens.get('I45'), 1); // remonté près de sa descendance
  const years = K.estimatedYears();
  assert.deepStrictEqual(years.get('I24'), { year: 1801, estimated: false });
  assert.ok(years.get('I48').estimated);
});
