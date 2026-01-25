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
        const fullData = `HEAD_FORMAT: FTT v0.1\n${fttData}`;
        const result = parser.parse(fullData);
        
        if (result.errors.length > 0) {
            throw new Error(`Parser Error: ${result.errors[0].message} (Line ${result.errors[0].line})`);
        }

        const calculator = new RelationshipCalculator(result.records);
        const rels = calculator.calculate(idA, idB);
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
            const rels = calc(data, 'HUSB', 'FIL');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(1); 
        });

        it('should identify Son-in-Law (VIA_BLOOD_SPOUSE)', () => {
            const rels = calc(data, 'FIL', 'HUSB');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_BLOOD_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(0); 
        });

        it('should identify Brother-in-Law', () => {
            const rels = calc(data, 'HUSB', 'BIL');
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].subType).toBe('VIA_SPOUSE');
            expect(rels[0].bloodRel.distA).toBe(1); 
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

    // ==========================================
    // 8. Temporal Logic (Ex-Spouses)
    // ==========================================
    describe('Temporal Logic', () => {
        const data = `
ID: HUSB
SEX: M
UNION: EX-WIFE | MARR | 1990 | 2000 | DIV
UNION: WIFE | MARR | 2005 | .. |

ID: EX-WIFE
SEX: F
UNION: HUSB | MARR | 1990 | 2000 | DIV

ID: WIFE
SEX: F
UNION: HUSB | MARR | 2005 | .. |
`;

        it('should identify Current Spouse correctly', () => {
            const rels = calc(data, 'HUSB', 'WIFE');
            expect(rels[0].type).toBe('UNION');
            expect(rels[0].target).toBe('WIFE');
        });

        it('should identify Former Spouse correctly', () => {
            const rels = calc(data, 'HUSB', 'EX-WIFE');
            expect(rels[0].type).toBe('FORMER_UNION');
            expect(rels[0].target).toBe('EX-WIFE');
            expect(rels[0].reason).toBe('DIV');
        });
    });

    // ==========================================
    // 9. Deep Step-Relationships
    // ==========================================
    describe('Deep Step-Traversal', () => {
        const data = `
ID: ME
PARENT: MOM | BIO

ID: MOM
UNION: STEP-DAD | MARR

ID: STEP-DAD
PARENT: STEP-GRANDPA | BIO

ID: STEP-GRANDPA
SEX: M
CHILD: STEP-DAD
`;

        it('should identify Step-Grandfather', () => {
            // Path: ME -> MOM -> (Spouse) STEP-DAD -> (Bio) STEP-GRANDPA
            const rels = calc(data, 'STEP-GRANDPA', 'ME');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].isStep).toBe(true);
            expect(rels[0].distA).toBe(0); // Ancestor
            expect(rels[0].distB).toBe(2); // 2 generations down (Grandparent level)
        });
    });

    // ==========================================
    // 10. Topology-Based Double Cousins
    // ==========================================
    describe('Double Cousins (Topology Check)', () => {
        it('should NOT identify as Double for standard 2nd Cousin 1x Removed', () => {
            const data = `
ID: GG-PA
UNION: GG-MA | MARR
CHILD: G-PA-1
CHILD: G-PA-2

ID: GG-MA
UNION: GG-PA | MARR

ID: G-PA-1
PARENT: GG-PA | BIO
PARENT: GG-MA | BIO
CHILD: PARENT-1

ID: G-PA-2
PARENT: GG-PA | BIO
PARENT: GG-MA | BIO
CHILD: PARENT-2

ID: PARENT-1
PARENT: G-PA-1 | BIO
CHILD: ME

ID: PARENT-2
PARENT: G-PA-2 | BIO
CHILD: COUSIN

ID: ME
PARENT: PARENT-1 | BIO

ID: COUSIN
PARENT: PARENT-2 | BIO
CHILD: COUSIN-KID

ID: COUSIN-KID
PARENT: COUSIN | BIO
            `;
            const rels = calc(data, 'ME', 'COUSIN-KID');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(3); 
            expect(rels[0].distB).toBe(4);
            expect(rels[0].isDouble).toBe(false); 
        });

        it('should identify Double 1st Cousins (4 shared ancestors)', () => {
             const data = `
# Family A Grandparents
ID: GP1
UNION: GP2 | MARR
CHILD: DAD
CHILD: UNCLE

ID: GP2
UNION: GP1 | MARR

# Family B Grandparents
ID: GP3
UNION: GP4 | MARR
CHILD: MOM
CHILD: AUNT

ID: GP4
UNION: GP3 | MARR

# DAD (Fam A) marries MOM (Fam B)
ID: DAD
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: MOM | MARR
CHILD: ME

ID: MOM
PARENT: GP3 | BIO
PARENT: GP4 | BIO
UNION: DAD | MARR

# UNCLE (Fam A) marries AUNT (Fam B)
ID: UNCLE
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: AUNT | MARR
CHILD: DOUBLE-COZ

ID: AUNT
PARENT: GP3 | BIO
PARENT: GP4 | BIO
UNION: UNCLE | MARR

ID: ME
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: DOUBLE-COZ
PARENT: UNCLE | BIO
PARENT: AUNT | BIO
             `;
             const rels = calc(data, 'ME', 'DOUBLE-COZ');
             expect(rels[0].type).toBe('LINEAGE');
             expect(rels[0].isDouble).toBe(true);
        });

        const topologyData = `
# Two brothers marrying two sisters
ID: BRO1
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: SIS1 | MARR
CHILD: ME

ID: BRO2
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: SIS2 | MARR
CHILD: COUSIN

ID: SIS1
PARENT: GP3 | BIO
PARENT: GP4 | BIO
UNION: BRO1 | MARR

ID: SIS2
PARENT: GP3 | BIO
PARENT: GP4 | BIO
UNION: BRO2 | MARR

ID: ME
PARENT: BRO1 | BIO
PARENT: SIS1 | BIO

ID: COUSIN
PARENT: BRO2 | BIO
PARENT: SIS2 | BIO

# Ancestors
ID: GP1
UNION: GP2 | MARR
ID: GP2
UNION: GP1 | MARR

ID: GP3
UNION: GP4 | MARR
ID: GP4
UNION: GP3 | MARR
`;

        it('should identify Double First Cousins (Legacy Test)', () => {
            const rels = calc(topologyData, 'ME', 'COUSIN');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2);
            expect(rels[0].distB).toBe(2);
            expect(rels[0].isDouble).toBe(true);
        });
    });

    // ==========================================
    // 11. Robust Half-Sibling Logic
    // ==========================================
    describe('Half-Siblings (Missing Parent)', () => {
        const data = `
ID: DAD
CHILD: ME
CHILD: HALF-SIB

ID: ME
PARENT: DAD | BIO
# Mom is unknown/missing

ID: HALF-SIB
PARENT: DAD | BIO
PARENT: OTHER-MOM | BIO

ID: OTHER-MOM
CHILD: HALF-SIB
`;

        it('should identify Half-Sibling even with missing data', () => {
            const rels = calc(data, 'ME', 'HALF-SIB');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(1);
            expect(rels[0].distB).toBe(1);
            expect(rels[0].isHalf).toBe(true);
        });
    });

    // ==========================================
    // 12. Step-Siblings (Divorced Parents)
    // ==========================================
    describe('Step-Siblings (Divorced Parents)', () => {
        const data = `
ID: DAD
UNION: MOM | MARR | 1990 | 1995 | DIV
CHILD: SON

ID: MOM
UNION: DAD | MARR | 1990 | 1995 | DIV
CHILD: DAUGHTER

ID: SON
PARENT: DAD | BIO
# No relation to MOM

ID: DAUGHTER
PARENT: MOM | BIO
# No relation to DAD
`;

        it('should identify Step-Siblings via Former Union', () => {
            const rels = calc(data, 'SON', 'DAUGHTER');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('STEP_SIBLING');
            expect(rels[0].parentsDivorced).toBe(true);
        });
    });

    // ==========================================
    // 13. Complex Double Cousins (Half-Sibling Parents)
    // ==========================================
    describe('Complex Double Cousins', () => {
        const data = `
ID: GP1
UNION: GP2 | MARR

ID: GP2
UNION: GP1 | MARR

ID: GP3
UNION: GP4 | MARR
UNION: GP5 | MARR

ID: GP4
UNION: GP3 | MARR
ID: GP5
UNION: GP3 | MARR

# Brothers (Share GP1 & GP2)
ID: BRO1
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: HALF-SIS1 | MARR
CHILD: ME

ID: BRO2
PARENT: GP1 | BIO
PARENT: GP2 | BIO
UNION: HALF-SIS2 | MARR
CHILD: COUSIN

# Half-Sisters (Share GP3)
ID: HALF-SIS1
PARENT: GP3 | BIO
PARENT: GP4 | BIO
UNION: BRO1 | MARR

ID: HALF-SIS2
PARENT: GP3 | BIO
PARENT: GP5 | BIO
UNION: BRO2 | MARR

ID: ME
PARENT: BRO1 | BIO
PARENT: HALF-SIS1 | BIO

ID: COUSIN
PARENT: BRO2 | BIO
PARENT: HALF-SIS2 | BIO
`;
        it('should identify Double Cousins sharing 3 grandparents', () => {
            const rels = calc(data, 'ME', 'COUSIN');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2);
            expect(rels[0].ancestorIds.length).toBe(3); 
            expect(rels[0].isDouble).toBe(true);
        });
    });

    // ==========================================
    // 14. Widowhood vs Divorce (Step-Siblings)
    // ==========================================
    describe('Widowhood Step-Siblings', () => {
        const data = `
ID: DAD
UNION: MOM | MARR | 1990 | 2000 | WID
CHILD: SON

ID: MOM
UNION: DAD | MARR | 1990 | 2000 | WID
CHILD: DAUGHTER

ID: SON
PARENT: DAD | BIO
# Mom is step-parent

ID: DAUGHTER
PARENT: MOM | BIO
# Dad is step-parent
`;
        it('should correctly identify Widowhood instead of Divorce', () => {
            const rels = calc(data, 'SON', 'DAUGHTER');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('STEP_SIBLING');
            expect(rels[0].parentsDivorced).toBe(false);
            expect(rels[0].unionReason).toBe('WID');
        });
    });

    // ==========================================
    // 15. Co-Affinal Relationships
    // ==========================================
    describe('Co-Affinal (Co-In-Laws)', () => {
        const data = `
ID: HUSB1
UNION: WIFE1 | MARR

ID: WIFE1
UNION: HUSB1 | MARR
PARENT: GP1 | BIO

ID: WIFE2
UNION: HUSB2 | MARR
PARENT: GP1 | BIO

ID: HUSB2
UNION: WIFE2 | MARR

ID: GP1
CHILD: WIFE1
CHILD: WIFE2
`;
        it('should identify Co-Brothers-in-Law (Spouses of Sisters)', () => {
            const rels = calc(data, 'HUSB1', 'HUSB2');
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('CO_AFFINAL');
            expect(rels[0].subType).toBe('SPOUSES_ARE_SIBLINGS');
            expect(rels[0].spouseA).toBe('WIFE1');
            expect(rels[0].spouseB).toBe('WIFE2');
        });
    });

    // ==========================================
    // 16. Multi-Path Lineage (Bio + Adoptive)
    // ==========================================
    describe('Multi-Path Lineage', () => {
        const data = `
ID: CHILD
PARENT: BIO-MOM | BIO
PARENT: ADO-DAD | ADO

ID: BIO-MOM
PARENT: GRANDMA | BIO
UNION: ADO-DAD | MARR

ID: ADO-DAD
PARENT: GRANDMA | BIO
UNION: BIO-MOM | MARR
# Scenario: Child adopted by Uncle (Mother's Brother)

ID: GRANDMA
CHILD: BIO-MOM
CHILD: ADO-DAD
`;
        it('should distinguish Biological and Adoptive paths to ancestor', () => {
            const rels = calc(data, 'GRANDMA', 'CHILD');
            
            const bioPath = rels.find(r => r.lineageB === 'BIO');
            const adoPath = rels.find(r => r.lineageB === 'ADO');
            
            expect(bioPath).toBeDefined();
            expect(bioPath.distA).toBe(0);
            expect(bioPath.distB).toBe(2);
            
            expect(adoPath).toBeDefined();
            expect(adoPath.distA).toBe(0);
            expect(adoPath.distB).toBe(2);
            expect(adoPath.isAdoptive).toBe(true);
        });
    });

    // ==========================================
    // 17. Adoptive Parent Text Gen
    // ==========================================
    describe('Adoptive Parent Terminology', () => {
        const data = `
ID: DAD
NAME: DAD
SEX: M
PARENT: GRANDPA | ADO

ID: GRANDPA
NAME: Grandpa
SEX: M
`;
        it('should label Adoptive Parent correctly (not "Adopted Father")', () => {
            const rels = calc(data, 'GRANDPA', 'DAD');
            
            // Check Relationship Object
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(0);
            expect(rels[0].distB).toBe(1);
            expect(rels[0].isAdoptive).toBe(true);

            // Check Text Generation
            const textGen = new RelationText(parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`).records);
            const desc = textGen.describe(rels[0], 'M', 'DAD', 'Grandpa');
            
            expect(desc.term).toBe('Adoptive Father');
            expect(desc.term).not.toContain('Adopted');
        });

        it('should label Adopted Child correctly', () => {
            const rels = calc(data, 'DAD', 'GRANDPA');
            const textGen = new RelationText(parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`).records);
            const desc = textGen.describe(rels[0], 'M', 'Grandpa', 'DAD');
            
            expect(desc.term).toBe('Adopted Son');
        });
    });
    
    // ==========================================
    // 18. REGRESSION TEST: Uncoupled Ancestor Bug
    // ==========================================
    describe('Double Cousins (Uncoupled Ancestors)', () => {
        const data = `
ID: TEST-ME
NAME: Test Subject
SEX: M
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: COUSIN-X
NAME: Double Cousin X
SEX: F
PARENT: UNCLE-PAT | BIO
PARENT: AUNT-MAT | BIO

# --- The Parents ---
ID: DAD
SEX: M
PARENT: GP-PATERNAL | BIO

ID: UNCLE-PAT
SEX: M
PARENT: GP-PATERNAL | BIO

ID: MOM
SEX: F
PARENT: GP-MATERNAL | BIO

ID: AUNT-MAT
SEX: F
PARENT: GP-MATERNAL | BIO

# --- The Uncoupled Grandparents ---
# They share grandchildren (me & cousin) but are NOT partners.
ID: GP-PATERNAL
SEX: M

ID: GP-MATERNAL
SEX: F
`;
        it('should identify Double Cousins when ancestors are NOT partners', () => {
            const rels = calc(data, 'TEST-ME', 'COUSIN-X');
            
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2); // Grandchild
            expect(rels[0].distB).toBe(2); // Grandchild
            expect(rels[0].isDouble).toBe(true); 
            
            // Ensure we captured both ancestors
            expect(rels[0].ancestorIds).toHaveLength(2);
            expect(rels[0].ancestorIds).toContain('GP-PATERNAL');
            expect(rels[0].ancestorIds).toContain('GP-MATERNAL');
        });
    });
    
    // ==========================================
    // 19. Half-Avuncular (Half-Uncle)
    // ==========================================
    describe('Half-Avuncular (Half-Uncle)', () => {
        const data = `
ID: GRANDPA
SEX: M
UNION: GRANDMA-1 | MARR
UNION: GRANDMA-2 | MARR

ID: GRANDMA-1
SEX: F
UNION: GRANDPA | MARR

ID: GRANDMA-2
SEX: F
UNION: GRANDPA | MARR

ID: UNCLE-HALF
SEX: M
PARENT: GRANDPA | BIO
PARENT: GRANDMA-1 | BIO

ID: DAD
SEX: M
PARENT: GRANDPA | BIO
PARENT: GRANDMA-2 | BIO

ID: ME
SEX: M
PARENT: DAD | BIO
`;
        it('should identify Half-Uncle correctly', () => {
            // Path: ME -> DAD -> GRANDPA -> UNCLE-HALF
            // They share GRANDPA, but have different grandmothers (GRANDMA-1 vs GRANDMA-2)
            const rels = calc(data, 'UNCLE-HALF', 'ME');
            
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            // Uncle is 1 generation down from Grandpa
            expect(rels[0].distA).toBe(1); 
            // Me is 2 generations down from Grandpa
            expect(rels[0].distB).toBe(2); 
            
            // CRITICAL CHECK: Must be identified as Half-Uncle
            expect(rels[0].isHalf).toBe(true);
            
            // Ensure we identified only the single common ancestor
            expect(rels[0].ancestorIds).toHaveLength(1);
            expect(rels[0].ancestorIds[0]).toBe('GRANDPA');
        });

        it('should generate correct text for Half-Uncle', () => {
            const rels = calc(data, 'UNCLE-HALF', 'ME');
            const textGen = new RelationText(parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`).records);
            const desc = textGen.describe(rels[0], 'M', 'ME', 'UNCLE-HALF');
            
            expect(desc.term).toBe('Half-Uncle');
        });
    });
    
    // ==========================================
    // 20. REGRESSION TEST: The "Half-Mother" Bug
    // ==========================================
    describe('Direct Lineage vs Half-Blood', () => {
        const data = `
ID: POLY-DAD
SEX: M
UNION: WIFE-1 | MARR | 1990 | 1992 | DIV
UNION: WIFE-2 | MARR | 1993 | 1995 | DIV
UNION: BIO-MOM | MARR | 2000 | .. |

ID: BIO-MOM
SEX: F

ID: POOR-KID
SEX: M
PARENT: POLY-DAD | BIO
PARENT: BIO-MOM | BIO

ID: WIFE-1
SEX: F
ID: WIFE-2
SEX: F
`;
        it('should NOT flag direct parents as Half, even with multiple step-parents', () => {
            const rels = calc(data, 'BIO-MOM', 'POOR-KID');
            
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(0); // Ancestor
            expect(rels[0].distB).toBe(1); // Descendant
            
            // CRITICAL CHECK: Must be false
            expect(rels[0].isHalf).toBe(false); 
        });

        it('should generate correct text "Mother"', () => {
            const rels = calc(data, 'BIO-MOM', 'POOR-KID');
            const textGen = new RelationText(parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`).records);
            const desc = textGen.describe(rels[0], 'F', 'POOR-KID', 'BIO-MOM');
            
            expect(desc.term).toBe('Mother');
        });
    });
});
