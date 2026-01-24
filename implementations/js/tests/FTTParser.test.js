import { describe, it, expect, beforeEach } from 'vitest';
import FTTParser from '../FTTParser.js';

describe('FTTParser v0.1', () => {
  let parser;

  beforeEach(() => {
    parser = new FTTParser();
  });

  // ==========================================
  // 1. BASIC SYNTAX & PARSING
  // ==========================================
  describe('Basic Syntax', () => {
    it('should parse global headers', () => {
      const input = `
HEAD_FORMAT: FTT v0.1
HEAD_TITLE: My Family Tree
HEAD_ROOT:  I1
`;
      const result = parser.parse(input);
      expect(result.headers['HEAD_FORMAT']).toBe('FTT v0.1');
      expect(result.headers['HEAD_TITLE']).toBe('My Family Tree');
      expect(result.headers['HEAD_ROOT']).toBe('I1');
      expect(result.errors).toHaveLength(0);
    });

    it('should parse a simple individual record', () => {
      const input = `
ID: PERSON-01
NAME: John Doe | Doe, John
SEX:  M
`;
      const result = parser.parse(input);
      const rec = result.records['PERSON-01'];
      
      expect(rec).toBeDefined();
      expect(rec.type).toBe('INDIVIDUAL');
      expect(rec.data.NAME[0].parsed[0]).toBe('John Doe');
      expect(rec.data.SEX[0].parsed[0]).toBe('M');
    });

    it('should handle pipe delimiters and empty fields', () => {
      const input = `
ID: A
# Format: Display | Sort | Type | Status
NAME: John ||| PREF
`;
      const result = parser.parse(input);
      const name = result.records['A'].data.NAME[0].parsed;
      
      expect(name[0]).toBe('John');
      expect(name[1]).toBe(''); // Empty
      expect(name[2]).toBe(''); // Empty
      expect(name[3]).toBe('PREF');
    });

    it('should handle escaped pipes', () => {
      const input = `
ID: A
NOTE: This is a pipe \\| character
`;
      const result = parser.parse(input);
      const note = result.records['A'].data.NOTE[0].parsed[0];
      expect(note).toBe('This is a pipe | character');
    });

    it('should handle multiline indentation (folding)', () => {
      const input = `
ID: A
NOTES: Line 1.
  Line 2.
  Line 3.
`;
      const result = parser.parse(input);
      const raw = result.records['A'].data.NOTES[0].raw;
      expect(raw).toBe('Line 1. Line 2. Line 3.'); 
    });
  });

  // ==========================================
  // 2. MODIFIERS & CITATIONS
  // ==========================================
  describe('Modifiers (Adjacency Logic)', () => {
    it('should attach citations to the immediately preceding field', () => {
      const input = `
ID: A
BORN: 1980
BORN_SRC: ^SRC-1
DIED: 2020
`;
      const result = parser.parse(input);
      const born = result.records['A'].data.BORN[0];
      const died = result.records['A'].data.DIED[0];

      expect(born.modifiers['BORN_SRC']).toBeDefined();
      expect(born.modifiers['BORN_SRC'][0].parsed[0]).toBe('^SRC-1');
      
      // Ensure it didn't leak to DIED
      expect(died.modifiers).toEqual({});
    });

    it('should error if modifier has no predecessor', () => {
      const input = `
ID: A
BORN_SRC: ^SRC-1
`;
      const result = parser.parse(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe('CTX_MODIFIER');
    });

    it('should error if modifier type mismatch (BORN_SRC after DIED)', () => {
      const input = `
ID: A
DIED: 2020
BORN_SRC: ^SRC-1
`;
      const result = parser.parse(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe('CTX_MODIFIER');
    });
  });

  // ==========================================
  // 3. PLACE HIERARCHIES & GEO
  // ==========================================
  describe('Place Parsing', () => {
    it('should parse standard place strings', () => {
      const input = `
ID: A
BORN: 1980 | City; Region; Country
`;
      const result = parser.parse(input);
      const place = result.records['A'].data.BORN[0].parsed[1];
      expect(place).toBe('City; Region; Country');
    });

    it('should extract historical name metadata {=Modern}', () => {
      const input = `
ID: A
BORN: 1980 | Berlin {=Kitchener}; Ontario
`;
      const result = parser.parse(input);
      const field = result.records['A'].data.BORN[0];
      
      expect(field.parsed[1]).toBe('Berlin; Ontario');
      expect(field.metadata.geo).toBe('Kitchener; Ontario');
    });

    it('should extract coordinates <lat, long>', () => {
      const input = `
ID: A
BORN: 1980 | City <51.5, -0.1>
`;
      const result = parser.parse(input);
      const field = result.records['A'].data.BORN[0];
      expect(field.parsed[1]).toBe('City');
      expect(field.metadata.coords).toBe('51.5, -0.1');
    });
  });

  // ==========================================
  // 4. GRAPH LOGIC (IMPLICIT UNIONS)
  // ==========================================
  describe('Graph Logic', () => {
    it('should inject implicit reciprocal unions', () => {
      const input = `
ID: HUSB
UNION: WIFE | MARR

ID: WIFE
# No explicit UNION line back to HUSB
`;
      const result = parser.parse(input);
      const wifeRec = result.records['WIFE'];
      
      expect(wifeRec.data.UNION).toBeDefined();
      expect(wifeRec.data.UNION[0].parsed[0]).toBe('HUSB');
      expect(wifeRec.data.UNION[0].isImplicit).toBe(true);
    });

    it('should warn on inconsistent reciprocal unions', () => {
      const input = `
ID: A
UNION: B | MARR

ID: B
UNION: A | PART
`;
      const result = parser.parse(input);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0].code).toBe('DATA_CONSISTENCY');
    });
  });

  // ==========================================
  // 5. VALIDATION & ERRORS
  // ==========================================
  describe('Validation', () => {
    it('should detect dangling references', () => {
      const input = `
ID: A
PARENT: MISSING_ID | BIO
`;
      const result = parser.parse(input);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DANGLING_REF' })
        ])
      );
    });

    it('should allow references to Placeholder IDs (?)', () => {
      const input = `
HEAD_FORMAT: FTT v0.1
ID: A
PARENT: ?UNK-FATHER | BIO
`;
      const result = parser.parse(input);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect Ghost Children (Child not reciprocating Parent)', () => {
      const input = `
ID: PARENT
CHILD: KID

ID: KID
# Missing PARENT: PARENT
`;
      const result = parser.parse(input);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'GHOST_CHILD' })
        ])
      );
    });

    it('should detect Circular Lineage', () => {
      const input = `
ID: A
PARENT: B | BIO

ID: B
PARENT: A | BIO
`;
      const result = parser.parse(input);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'CIRCULAR_LINEAGE' })
        ])
      );
    });

    it('should detect Circular Lineage involving Placeholder records', () => {
      // Regression test: Placeholders (?) should not block cycle detection
      const input = `
ID: A
PARENT: B | BIO

ID: B
PARENT: ?C | BIO

ID: ?C
PARENT: A | BIO
`;
      const result = parser.parse(input);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'CIRCULAR_LINEAGE' })
        ])
      );
    });

    it('should validate ISO 8601 / EDTF dates', () => {
      const input = `
HEAD_FORMAT: FTT v0.1
ID: A
BORN: 1980-05-12
DIED: 2020?
EVENT: OCC | [1900..1910] || Work
`;
      const result = parser.parse(input);
      expect(result.errors).toHaveLength(0);
    });

    it('should error on invalid dates', () => {
      const input = `
ID: A
BORN: May 12, 1980
`;
      const result = parser.parse(input);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'INVALID_DATE' })
        ])
      );
    });
  });
});
