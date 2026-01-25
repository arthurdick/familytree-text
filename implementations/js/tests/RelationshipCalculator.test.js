import { describe, it, expect, beforeEach } from 'vitest';
import FTTParser from '../FTTParser.js';
import { RelationshipCalculator, RelationText, getGender } from '../RelationshipCalculator.js';

describe('RelationshipCalculator', () => {
    let parser;

    beforeEach(() => {
        parser = new FTTParser();
    });

    /**
     * Helper to parse string data and run calculation.
     * Automatically prepends the required HEAD_FORMAT to satisfy FTTParser validation.
     */
    function calc(fttData, idA, idB) {
        // FIX: Prepend the mandatory header so the parser doesn't throw MISSING_HEADER
        const fullData = `HEAD_FORMAT: FTT v0.1\n${fttData}`;
        
        const result = parser.parse(fullData);
        
        // If parser finds errors (like missing headers or invalid dates), fail the test
        if (result.errors.length > 0) {
            throw new Error(`Parser Error: ${result.errors[0].message} (Line ${result.errors[0].line})`);
        }

        const calculator = new RelationshipCalculator(result.records);
        const rels = calculator.calculate(idA, idB);
        
        // Verify text generation also runs without crashing
        const textGen = new RelationText(result.records);
        const genderA = getGender(result.records[idA]);
        rels.forEach(r => textGen.describe(r, genderA, idB, idA));

        return rels;
    }

    // ==========================================
    // 1. Basic Lineage
    // ==========================================
    describe('Lineage', () => {
        const data = `
ID: PARENT
SEX: M
CHILD: CHILD

ID: CHILD
SEX: F
PARENT: PARENT | BIO
CHILD: GRANDCHILD

ID: GRANDCHILD
SEX: M
PARENT: CHILD | BIO
`;

        it('should identify Parent', () => {
            const rels = calc(data, 'PARENT', 'CHILD');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(0); // A is ancestor
            expect(rels[0].distB).toBe(1); // B is descendant (1 gen down)
        });

        it('should identify Child', () => {
            const rels = calc(data, 'CHILD', 'PARENT');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(1);
            expect(rels[0].distB).toBe(0);
        });

        it('should identify Grandparent', () => {
            const rels = calc(data, 'PARENT', 'GRANDCHILD');
            expect(rels[0].distA).toBe(0);
            expect(rels[0].distB).toBe(2);
        });
    });

    // ==========================================
    // 2. Siblings & Half-Siblings
    // ==========================================
    describe('Siblings', () => {
        const data = `
ID: DAD
CHILD: ME
CHILD: SIS
CHILD: HALF-BRO

ID: MOM
CHILD: ME
CHILD: SIS

ID: ME
SEX: M
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: SIS
SEX: F
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: HALF-BRO
SEX: M
PARENT: DAD | BIO
# Different mom or unknown
`;

        it('should identify Full Siblings', () => {
            const rels = calc(data, 'ME', 'SIS');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(1);
            expect(rels[0].distB).toBe(1);
            expect(rels[0].isHalf).toBe(false);
        });

        it('should identify Half Siblings', () => {
            const rels = calc(data, 'ME', 'HALF-BRO');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(1);
            expect(rels[0].distB).toBe(1);
            expect(rels[0].isHalf).toBe(true);
        });
    });

    // ==========================================
    // 3. Spouses (Direct Union)
    // ==========================================
    describe('Unions', () => {
        const data = `
ID: HUSB
SEX: M
UNION: WIFE | MARR

ID: WIFE
SEX: F
UNION: HUSB | MARR
`;

        it('should identify Spouse', () => {
            const rels = calc(data, 'HUSB', 'WIFE');
            expect(rels[0].type).toBe('UNION');
            expect(rels[0].target).toBe('WIFE');
        });
    });

    // ==========================================
    // 4. Cousins
    // ==========================================
    describe('Cousins', () => {
        const data = `
ID: G-PA
CHILD: DAD
CHILD: UNCLE

ID: DAD
PARENT: G-PA | BIO
CHILD: ME

ID: UNCLE
PARENT: G-PA | BIO
CHILD: COUSIN

ID: ME
PARENT: DAD | BIO

ID: COUSIN
PARENT: UNCLE | BIO
CHILD: COUSIN-KID

ID: COUSIN-KID
PARENT: COUSIN | BIO
`;

        it('should identify 1st Cousins', () => {
            // ME -> DAD -> G-PA
            // COUSIN -> UNCLE -> G-PA
            // Both are dist 2 from G-PA
            const rels = calc(data, 'ME', 'COUSIN');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2);
            expect(rels[0].distB).toBe(2);
        });

        it('should identify 1st Cousin 1x Removed', () => {
            const rels = calc(data, 'ME', 'COUSIN-KID');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2);
            expect(rels[0].distB).toBe(3);
        });
    });

    // ==========================================
    // 5. Affinal (In-Laws)
    // ==========================================
    describe('Affinal', () => {
        const data = `
ID: HUSB
SEX: M
UNION: WIFE | MARR

ID: WIFE
SEX: F
UNION: HUSB | MARR
PARENT: FIL | BIO
PARENT: MIL | BIO

ID: FIL
SEX: M
CHILD: WIFE
CHILD: BIL

ID: MIL
SEX: F
CHILD: WIFE

ID: BIL
SEX: M
PARENT: FIL | BIO
`;

        it('should identify Father-in-Law (VIA_SPOUSE)', () => {
            // HUSB -> Spouse(WIFE) -> Father(FIL)
            const rels = calc(data, 'HUSB', 'FIL');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(1); // FIL is father of WIFE
        });

        it('should identify Son-in-Law (VIA_BLOOD_SPOUSE)', () => {
            // FIL -> Daughter(WIFE) -> Spouse(HUSB)
            const rels = calc(data, 'FIL', 'HUSB');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_BLOOD_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(0); // FIL is ancestor of WIFE
        });

        it('should identify Brother-in-Law', () => {
            const rels = calc(data, 'HUSB', 'BIL');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(1); // BIL is sibling of WIFE
            expect(rels[0].bloodRel.distB).toBe(1);
        });
    });

    // ==========================================
    // 6. Step Relationships
    // ==========================================
    describe('Step Relationships', () => {
        const data = `
ID: STEP-DAD
SEX: M
UNION: MOM | MARR

ID: MOM
SEX: F
UNION: STEP-DAD | MARR
CHILD: STEP-SON

ID: STEP-SON
SEX: M
PARENT: MOM | BIO
# No bio link to STEP-DAD
`;

        it('should identify Step-Father', () => {
            const rels = calc(data, 'STEP-DAD', 'STEP-SON');
            expect(rels[0].type).toBe('STEP_PARENT');
            expect(rels[0].parentId).toBe('MOM');
        });

        it('should identify Step-Son', () => {
            const rels = calc(data, 'STEP-SON', 'STEP-DAD');
            expect(rels[0].type).toBe('STEP_CHILD');
            expect(rels[0].parentId).toBe('MOM');
        });
    });

    // ==========================================
    // 7. Step-Siblings
    // ==========================================
    describe('Step Siblings', () => {
        const data = `
ID: DAD
UNION: MOM | MARR
CHILD: SON

ID: MOM
UNION: DAD | MARR
CHILD: DAUGHTER

ID: SON
SEX: M
PARENT: DAD | BIO

ID: DAUGHTER
SEX: F
PARENT: MOM | BIO
# Parents are married, but no shared parents
`;

        it('should identify Step-Siblings', () => {
            const rels = calc(data, 'SON', 'DAUGHTER');
            expect(rels[0].type).toBe('STEP_SIBLING');
        });
    });
});
