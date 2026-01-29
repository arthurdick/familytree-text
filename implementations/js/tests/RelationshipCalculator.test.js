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

    describe('Siblings', () => {
        const data = `
ID: DAD
CHILD: ME
CHILD: SIS
CHILD: HALF-BRO

ID: MOM
CHILD: ME
CHILD: SIS

ID: OTHER-MOM
CHILD: HALF-BRO

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
PARENT: OTHER-MOM | BIO
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

    describe('Step Siblings', () => {
        it('should identify Step-Siblings', () => {
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
            const rels = calc(data, 'SON', 'DAUGHTER');
            expect(rels[0].type).toBe('STEP_SIBLING');
        });
        
        it('should identify Foster Step-Siblings', () => {
            const data = `
ID: DAD
UNION: STEP-MOM | MARR
CHILD: BIO-SON

ID: STEP-MOM
UNION: DAD | MARR
CHILD: FOSTER-DAUGHTER

ID: BIO-SON
SEX: M
PARENT: DAD | BIO

ID: FOSTER-DAUGHTER
SEX: F
PARENT: STEP-MOM | FOS
# FOS is not in VALID_LINEAGE, so this fails the 'bioB' check in the original code.
`;
            const rels = calc(data, 'BIO-SON', 'FOSTER-DAUGHTER');
            
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('STEP_SIBLING');
            expect(rels[0].parentA).toBe('DAD');
            expect(rels[0].parentB).toBe('STEP-MOM');
        });
    });

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

    describe('Half-Siblings (Missing Parent)', () => {
        const data = `
ID: DAD
CHILD: ME
CHILD: HALF-SIB

ID: ME
PARENT: DAD | BIO
PARENT: ?UNK-MOM-1 | BIO

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
            expect(rels[0].subType).toBe('SPOUSES_ARE_RELATIVES'); 
            expect(rels[0].spouseA).toBe('WIFE1');
            expect(rels[0].spouseB).toBe('WIFE2');
            
            expect(rels[0].bloodRel.distA).toBe(1);
            expect(rels[0].bloodRel.distB).toBe(1);
        });
    });

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

    describe('Step-In-Laws', () => {
        const data = `
HEAD_FORMAT: FTT v0.1
ID: ME
SEX: M
UNION: WIFE | MARR

ID: WIFE
SEX: F
UNION: ME | MARR
PARENT: BIO-MOM | BIO

ID: BIO-MOM
SEX: F
UNION: STEP-FIL | MARR
CHILD: WIFE

ID: STEP-FIL
SEX: M
UNION: BIO-MOM | MARR
`;

        it('should identify Step-Father-in-law', () => {
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            // Path: STEP-FIL (A) -> Spouse (BioMom) -> Child (Wife) <- Spouse (Me, B)
            // A is Relative of B's Spouse. (VIA_BLOOD_SPOUSE)
            // A is Step-Father of Spouse.
            const rels = calculator.calculate('STEP-FIL', 'ME');
            const description = textGen.describe(rels[0], 'M', 'ME', 'STEP-FIL');

            expect(rels[0].type).toBe('AFFINAL');
            expect(description.term).toBe('Step-Father-in-law');
        });

        it('should identify Son-in-law (for step-child\'s spouse)', () => {
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            // Path: ME (A) -> Wife -> Step-Father (B).
            // A is Spouse of B's Relative. (VIA_SPOUSE)
            // Wife is Step-Daughter of B.
            // A is Son-in-law.
            const rels = calculator.calculate('ME', 'STEP-FIL');
            const description = textGen.describe(rels[0], 'M', 'STEP-FIL', 'ME');

            expect(rels[0].type).toBe('AFFINAL');
            expect(description.term).toBe('Son-in-law');
        });
    });

    describe('Ex-In-Laws', () => {
        const data = `
HEAD_FORMAT: FTT v0.1
ID: ME
SEX: M
UNION: EX-WIFE | MARR | 1990 | 2000 | DIV

ID: EX-WIFE
SEX: F
UNION: ME | MARR | 1990 | 2000 | DIV
PARENT: P1 | BIO
PARENT: P2 | BIO
# Merged CHILD: EX-BIL is not strictly needed for sibling logic if parents match

ID: EX-BIL
SEX: M
PARENT: P1 | BIO
PARENT: P2 | BIO

ID: P1
ID: P2
`;

        it('should identify Former Brother-in-law', () => {
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            const rels = calculator.calculate('EX-BIL', 'ME');
            
            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].isExUnion).toBe(true);

            const description = textGen.describe(rels[0], 'M', 'ME', 'EX-BIL');
            expect(description.term).toBe('Former Brother-in-law');
        });
    });

    describe('Combined: Former Step-Mother-in-law', () => {
        const data = `
HEAD_FORMAT: FTT v0.1
ID: ME
SEX: M
UNION: EX-HUSB | MARR | 2000 | 2005 | DIV

ID: EX-HUSB
SEX: M
UNION: ME | MARR | 2000 | 2005 | DIV
PARENT: BIO-DAD | BIO

ID: BIO-DAD
SEX: M
UNION: STEP-MIL | MARR

ID: STEP-MIL
SEX: F
UNION: BIO-DAD | MARR
`;

        it('should identify Former Step-Mother-in-law', () => {
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            // A (STEP-MIL) -> Spouse (Dad) -> Child (Ex-Husb) <- Spouse (Me, B)
            // A is Step-Mother of Ex-Spouse.
            // A is Former Step-Mother-in-law.
            const rels = calculator.calculate('STEP-MIL', 'ME');
            const description = textGen.describe(rels[0], 'F', 'ME', 'STEP-MIL');

            expect(rels[0].type).toBe('AFFINAL');
            expect(rels[0].isExUnion).toBe(true);
            expect(description.term).toBe('Former Step-Mother-in-law');
        });
    });
    
    describe('Half-Blood Logic', () => {
        it('should NOT label siblings as Half-Blood just because one has a missing parent record', () => {
            const data = `
HEAD_FORMAT: FTT v0.1

ID: DAD
ID: MOM

ID: ME
SEX: M
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: BROTHER-INCOMPLETE
SEX: M
PARENT: DAD | BIO
# MOM is missing from record, but not necessarily different
`;
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'BROTHER-INCOMPLETE');
            
            expect(rels[0].type).toBe('LINEAGE');
            // We expect the system to give the benefit of the doubt (Full/Ambiguous)
            // rather than asserting "Half" without proof.
            expect(rels[0].isHalf).toBe(false);
        });
        
        it('should correctly label True Half-Siblings when both sets of parents diverge', () => {
            const data = `
HEAD_FORMAT: FTT v0.1

ID: DAD
ID: MOM
ID: STEPMOM

ID: ME
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: HALF-BRO
PARENT: DAD | BIO
PARENT: STEPMOM | BIO
`;
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'HALF-BRO');
            
            expect(rels[0].isHalf).toBe(true);
        });
    });
    
    describe('Regression: Cousin Half-Blood Logic', () => {
        it('should NOT label cousins as Half-Blood if only one ancestor is recorded (Missing Data)', () => {
            const data = `
HEAD_FORMAT: FTT v0.1

# The Common Ancestor (Only one defined)
ID: GG-PA
# GG-MA is missing from file

# Branch A
ID: G-PA-1
PARENT: GG-PA | BIO
CHILD: PARENT-1

ID: PARENT-1
PARENT: G-PA-1 | BIO
CHILD: ME

ID: ME
PARENT: PARENT-1 | BIO

# Branch B
ID: G-PA-2
PARENT: GG-PA | BIO
CHILD: PARENT-2

ID: PARENT-2
PARENT: G-PA-2 | BIO
CHILD: COUSIN

ID: COUSIN
PARENT: PARENT-2 | BIO
CHILD: COUSIN-KID

ID: COUSIN-KID
PARENT: COUSIN | BIO
`;
            // Relationship: ME <-> COUSIN-KID (2nd Cousin 1x Removed)
            // Ancestor: GG-PA (Count = 1)
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'COUSIN-KID');
            const rel = rels[0];
            
            expect(rel.type).toBe('LINEAGE');
            expect(rel.isHalf).toBe(false); 
        });
        
        it('should label cousins as Half-Blood if the ancestor has MULTIPLE unions', () => {
            const data = `
HEAD_FORMAT: FTT v0.1

ID: SHARED-GP
UNION: WIFE-1 | MARR
UNION: WIFE-2 | MARR

ID: WIFE-1
ID: WIFE-2

ID: PARENT-A
PARENT: SHARED-GP | BIO
PARENT: WIFE-1 | BIO
CHILD: ME

ID: PARENT-B
PARENT: SHARED-GP | BIO
PARENT: WIFE-2 | BIO
CHILD: COUSIN

ID: ME
PARENT: PARENT-A | BIO

ID: COUSIN
PARENT: PARENT-B | BIO
`;
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'COUSIN');
            const rel = rels[0];
            expect(rel.isHalf).toBe(true);
        });
    });
    
    describe('Deep Affinal (Counter-In-Laws)', () => {
        it('should identify the Father of a Brother-in-law', () => {
            const data = `
HEAD_FORMAT: FTT v0.1
# ME -> SIS -> BIL -> BIL-DAD

ID: ME
SEX: M
PARENT: MY-DAD | BIO

ID: MY-DAD
CHILD: ME
CHILD: SIS

ID: SIS
SEX: F
PARENT: MY-DAD | BIO
UNION: BIL | MARR

ID: BIL
SEX: M
UNION: SIS | MARR
PARENT: BIL-DAD | BIO

ID: BIL-DAD
SEX: M
CHILD: BIL
`;
            const parser = new FTTParser();
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            // Path: ME -> SIS (Sibling) -> BIL (Spouse) -> BIL-DAD (Parent)
            const rels = calculator.calculate('BIL-DAD', 'ME');

            expect(rels).not.toHaveLength(0);
            expect(rels[0].type).not.toBe('NONE');
            
            // We want a type that indicates extended affinity
            expect(rels[0].type).toBe('EXTENDED_AFFINAL'); 
            
            const desc = textGen.describe(rels[0], 'M', 'BIL-DAD', 'ME');
            expect(desc.term).toBe('Father of Brother-in-law');
        });
        
        it('should identify the Great-Grandfather of a Brother-in-law', () => {
            // Data Setup: ME -> SIS -> BIL -> BIL-DAD -> BIL-G-DAD -> BIL-GG-DAD
            const data = `
HEAD_FORMAT: FTT v0.1
ID: ME
SEX: M
PARENT: MY-DAD | BIO

ID: MY-DAD
CHILD: ME
CHILD: SIS

ID: SIS
SEX: F
PARENT: MY-DAD | BIO
UNION: BIL | MARR

ID: BIL
SEX: M
PARENT: BIL-DAD | BIO

ID: BIL-DAD
SEX: M
PARENT: BIL-G-DAD | BIO

ID: BIL-G-DAD
SEX: M
PARENT: BIL-GG-DAD | BIO

ID: BIL-GG-DAD
SEX: M
`;
            const parser = new FTTParser();
            const result = parser.parse(data);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);

            // Calculate ME -> Great-Grandfather of BIL
            const rels = calculator.calculate('BIL-GG-DAD', 'ME');
            
            expect(rels).not.toHaveLength(0);
            expect(rels[0].type).toBe('EXTENDED_AFFINAL');
            
            const desc = textGen.describe(rels[0], 'M', 'BIL-GG-DAD', 'ME');
            
            // This proves the logic is generalized to N steps
            expect(desc.term).toBe('Great-Grandfather of Brother-in-law');
        });
    });
    
    describe('Endogamy & Redundancy Filter', () => {
        it('should return BOTH Cousin and In-Law relationships (Collateral)', () => {
            const data = `
# Grandparents share ME and COUSIN-BIL
ID: GP
CHILD: DAD
CHILD: UNCLE

ID: DAD
PARENT: GP | BIO
CHILD: ME

ID: UNCLE
PARENT: GP | BIO
CHILD: COUSIN-BIL

# ME marries WIFE
ID: ME
SEX: M
PARENT: DAD | BIO
UNION: WIFE | MARR

# WIFE is sibling of COUSIN-BIL
ID: WIFE
SEX: F
PARENT: IN-LAW-DAD | BIO

ID: COUSIN-BIL
SEX: M
PARENT: UNCLE | BIO
PARENT: IN-LAW-DAD | BIO

# Connecting the in-law family
ID: IN-LAW-DAD
CHILD: WIFE
CHILD: COUSIN-BIL
`;
            // Relationship:
            // 1. Lineage: 1st Cousin (via GP)
            // 2. Affinal: Brother-in-Law (Wife's Brother)
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'COUSIN-BIL');

            expect(rels).toHaveLength(2);
            
            const types = rels.map(r => r.type).sort();
            expect(types).toEqual(['AFFINAL', 'LINEAGE']);
        });

        it('should suppress In-Law relationship if Direct Lineage exists (Regression)', () => {
            const data = `
ID: DAD
UNION: MOM | MARR

ID: MOM
UNION: DAD | MARR

ID: CHILD
PARENT: DAD | BIO
PARENT: MOM | BIO
`;
            // Relationship:
            // 1. Lineage: Mother (Direct)
            // 2. Affinal: Spouse of Father (Technically true, but socially redundant)
            // EXPECTATION: The calculator should filter out the Affinal link because Direct Lineage exists.
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('CHILD', 'MOM');

            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(1); // Child
            expect(rels[0].distB).toBe(0); // Parent
        });
    });
    
    describe('Ambiguous Sibling Heuristic', () => {
        it('should label siblings as Ambiguous if one has 2 parents and the other has 1', () => {
            const data = `
ID: DAD
ID: MOM
ID: ME
PARENT: DAD | BIO
PARENT: MOM | BIO

ID: BRO-MISSING-DATA
PARENT: DAD | BIO
# MOM is not linked. 
# They share DAD. "ME" has 2 parents. "BRO" has 1.
# This creates ambiguity: Is BRO's mother MOM (Full) or someone else (Half)?
`;
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);
            
            const rels = calculator.calculate('ME', 'BRO-MISSING-DATA');
            const desc = textGen.describe(rels[0], 'M', 'BRO-MISSING-DATA', 'ME');

            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].isHalf).toBe(false);      // Not definitely half
            expect(rels[0].isAmbiguous).toBe(true);  // But definitely ambiguous
            
            // Check Text Output
            expect(desc.term).toContain('Brother (Ambiguous)');
        });
    });
    
    describe('Ambiguous Avuncular Heuristic', () => {
        it('should label Uncle as Ambiguous if he is missing a mother record while the Sibling has one', () => {
            const data = `
ID: GRANDPA
ID: GRANDMA

# Dad has both parents
ID: DAD
PARENT: GRANDPA | BIO
PARENT: GRANDMA | BIO

# Uncle only has Grandpa recorded
ID: UNCLE-MISSING-DATA
PARENT: GRANDPA | BIO

ID: ME
PARENT: DAD | BIO
`;
            const parser = new FTTParser();
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);
            
            const rels = calculator.calculate('UNCLE-MISSING-DATA', 'ME');
            const desc = textGen.describe(rels[0], 'M', 'UNCLE-MISSING-DATA', 'ME');

            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].isHalf).toBe(false);      // Not definitely half
            expect(rels[0].isAmbiguous).toBe(true);  // Definitely ambiguous
            
            expect(desc.term).toBe('Uncle (Ambiguous)');
        });
    });
    
    describe('Implicit Step-Siblings (Shared Sibling Bridge)', () => {
        it('should identify Step-Siblings if parents share a child but have no explicit UNION', () => {
            const data = `
ID: DAD
ID: MOM

ID: ME
PARENT: DAD | BIO

ID: STEP-SIS
PARENT: MOM | BIO

ID: OUR-MUTUAL-HALF-SIB
PARENT: DAD | BIO
PARENT: MOM | BIO
# DAD and MOM are implicitly partners because they share this child.
# Therefore ME and STEP-SIS are step-siblings via this connection.
`;
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'STEP-SIS');
            
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('STEP_SIBLING');
        });
    });
    
    describe('Robustness: Missing Parent + Remarriage', () => {
        const data = `
# Grandpa married twice
ID: GRANDPA
UNION: GRANDMA-1 | MARR
UNION: GRANDMA-2 | MARR

ID: GRANDMA-1
UNION: GRANDPA | MARR | ? | ? | DIV

ID: GRANDMA-2
UNION: GRANDPA | MARR

# DAD is fully linked to both
ID: DAD
PARENT: GRANDPA | BIO
PARENT: GRANDMA-1 | BIO
CHILD: ME

# UNCLE is missing his mother record (Incomplete Data)
# But he is actually full brother to DAD (we just don't know it yet)
ID: UNCLE-INCOMPLETE
PARENT: GRANDPA | BIO
CHILD: COUSIN-AMBIGUOUS

ID: ME
PARENT: DAD | BIO

ID: COUSIN-AMBIGUOUS
PARENT: UNCLE-INCOMPLETE | BIO
`;

        it('should NOT assume Half-Cousin status just because an ancestor remarried (Missing Data)', () => {
            // Shared Ancestors: Only GRANDPA (Count=1)
            // Grandpa has 2 spouses.
            const rels = calc(data, 'ME', 'COUSIN-AMBIGUOUS');
            
            expect(rels[0].type).toBe('LINEAGE');
            // We expect the system to give the benefit of the doubt
            expect(rels[0].isHalf).toBe(false); 
        });
    });
    
    describe('Step and Half-Removed relationships', () => {
        it('should correctly identify Step-Cousins (Recursive Step Logic)', () => {
            const data = `
ID: ME
PARENT: DAD | BIO
ID: DAD
UNION: STEP-MOM | MARR
ID: STEP-MOM
PARENT: STEP-GP | BIO
ID: STEP-UNCLE
PARENT: STEP-GP | BIO
CHILD: STEP-COUSIN
ID: STEP-COUSIN
PARENT: STEP-UNCLE | BIO
ID: STEP-GP
`;
            const rels = calc(data, 'ME', 'STEP-COUSIN');
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].isStep).toBe(true);
            expect(rels[0].distA).toBe(2); // Step-Grandchild
            expect(rels[0].distB).toBe(2); // Grandchild
        });

        it('should correctly textually formatting Half-Cousins with Removal', () => {
             const data = `
ID: SHARED-GP
UNION: W1 | MARR
UNION: W2 | MARR
ID: W1
ID: W2
ID: DAD
PARENT: SHARED-GP | BIO
PARENT: W1 | BIO
CHILD: ME
ID: HALF-AUNT
PARENT: SHARED-GP | BIO
PARENT: W2 | BIO
CHILD: HALF-COZ
ID: HALF-COZ
PARENT: HALF-AUNT | BIO
CHILD: HALF-COZ-KID
ID: ME
PARENT: DAD | BIO
ID: HALF-COZ-KID
PARENT: HALF-COZ | BIO
`;
            const rels = calc(data, 'ME', 'HALF-COZ-KID');
            expect(rels[0].isHalf).toBe(true);
            
            const textGen = new RelationText(parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`).records);
            const desc = textGen.describe(rels[0], 'M', 'HALF-COZ-KID', 'ME');
            
            // Confirms the original string concatenation works as intended
            expect(desc.term).toBe('Half-1st Cousin 1x Removed');
        });
    });
    
    describe('The "Third Parent" Problem (Cousins)', () => {
        it('should identify Full Cousins correctly even if an ancestor has a Step-Parent listed first', () => {
            const data = `
# Ancestors
ID: GRANDMA
UNION: GRANDPA | MARR
UNION: STEP-GRANDPA | MARR

ID: GRANDPA
UNION: GRANDMA | MARR

ID: STEP-GRANDPA
UNION: GRANDMA | MARR

# Parents
ID: MOM
PARENT: GRANDMA | BIO
PARENT: STEP-GRANDPA | STE
PARENT: GRANDPA | BIO
CHILD: ME

ID: AUNT
# Aunt has standard parents
PARENT: GRANDMA | BIO
PARENT: GRANDPA | BIO
CHILD: COUSIN

# Children
ID: ME
PARENT: MOM | BIO

ID: COUSIN
PARENT: AUNT | BIO
`;
            const parser = new FTTParser();
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            
            if (result.errors.length > 0) {
                throw new Error(result.errors[0].message);
            }

            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('ME', 'COUSIN');
            
            // Basic Cousin Check
            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('LINEAGE');
            expect(rels[0].distA).toBe(2); // Grandchild
            expect(rels[0].distB).toBe(2); // Grandchild
            
            // Expected Behavior: isHalf should be false (Full First Cousins).
            expect(rels[0].isHalf).toBe(false); 
        });
    });
    
    describe('Widowed Step-Parent Logic', () => {
        const data = `
ID: BIO-DAD
SEX: M
UNION: STEP-MOM | MARR | 1990 | 2000 | WID
CHILD: ME

ID: STEP-MOM
SEX: F
UNION: BIO-DAD | MARR | 1990 | 2000 | WID

ID: ME
SEX: M
PARENT: BIO-DAD | BIO
# No biological link to STEP-MOM
`;

        it('should identify Widowed Step-Parent as current Step-Parent', () => {
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            if (result.errors.length > 0) throw new Error(result.errors[0].message);

            const calculator = new RelationshipCalculator(result.records);
            const rels = calculator.calculate('STEP-MOM', 'ME');

            expect(rels).toHaveLength(1);
            expect(rels[0].type).toBe('STEP_PARENT');
            expect(rels[0].parentId).toBe('BIO-DAD');

            expect(rels[0].isEx).toBe(false); 
        });

        it('should generate correct "Step-Mother" text instead of "Former"', () => {
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);
            
            const rels = calculator.calculate('STEP-MOM', 'ME');
            const desc = textGen.describe(rels[0], 'F', 'ME', 'STEP-MOM');

            // Should be "Step-Mother", NOT "Former Step-Mother"
            expect(desc.term).toBe('Step-Mother');
        });
    });
    
    describe('"Ghost" Lineage: Intra-Family Adoption', () => {
        const data = `
# The Ancestors
ID: GRANDPA
CHILD: UNCLE-DAD
CHILD: BIO-DAD

# The Brothers
ID: UNCLE-DAD
# He is the biological brother of Bio-Dad
PARENT: GRANDPA | BIO
# He adopts the child
CHILD: CHILD

ID: BIO-DAD
PARENT: GRANDPA | BIO

# The Child
ID: CHILD
# Bio Parent
PARENT: BIO-DAD | BIO
# Adoptive Parent (The Uncle)
PARENT: UNCLE-DAD | ADO
`;

        it('should detect BOTH the Adoptive Father and Natural Uncle relationships', () => {
            const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
            const calculator = new RelationshipCalculator(result.records);
            const textGen = new RelationText(result.records);
            
            const rels = calculator.calculate('UNCLE-DAD', 'CHILD');

            expect(rels).toHaveLength(2);

            const adoPath = rels.find(r => r.distA === 0 && r.distB === 1 && r.isAdoptive);
            expect(adoPath).toBeDefined();

            const unclePath = rels.find(r => r.distA === 1 && r.distB === 2 && !r.isAdoptive);
            expect(unclePath).toBeDefined();
        });
    });
    
    describe('Pedigree Collapse (Double Relationship via Endogamy)', () => {
        const data = `
# Common Ancestor
ID: GGP

# Branch 1 (Paternal Grandparent)
ID: GP1
PARENT: GGP | BIO

# Branch 2 (Maternal Grandparent)
ID: GP2
PARENT: GGP | BIO

# Branch 3 (Cousin's Grandparent)
ID: GP3
PARENT: GGP | BIO

# DAD and MOM are First Cousins (Share GGP)
ID: DAD
PARENT: GP1 | BIO
UNION: MOM | MARR

ID: MOM
PARENT: GP2 | BIO
UNION: DAD | MARR

# ME is the Child of Cousins (Pedigree Collapse)
# ME has two paths to GGP:
# 1. ME -> DAD -> GP1 -> GGP
# 2. ME -> MOM -> GP2 -> GGP
ID: ME
PARENT: DAD | BIO
PARENT: MOM | BIO

# Target Cousin (Standard descent from GGP)
ID: COUSIN-PARENT
PARENT: GP3 | BIO

ID: TARGET-COUSIN
PARENT: COUSIN-PARENT | BIO
`;

        it('A "Double Cousin" relationship requires the individuals to share common ancestors from two distinct lines', () => {
             // Setup
             const result = parser.parse(`HEAD_FORMAT: FTT v0.1\n${data}`);
             const calculator = new RelationshipCalculator(result.records);
             
             // Execution
             const rels = calculator.calculate('ME', 'TARGET-COUSIN');
             
             // Baseline Assertions (Standard 2nd Cousin properties)
             expect(rels).toHaveLength(1);
             expect(rels[0].type).toBe('LINEAGE');
             expect(rels[0].distA).toBe(3); // Great-Grandchild
             expect(rels[0].distB).toBe(3); // Great-Grandchild
             expect(rels[0].isDouble).toBe(false); 
        });
    });
    
    describe('Duplicate Step-Lineage via Spouses', () => {
        const data = `
# The Parents (Married, creating Step-Sibling link between ME and STEP-BRO)
ID: DAD
UNION: STEP-MOM | MARR
ID: STEP-MOM
UNION: DAD | MARR

ID: ME
PARENT: DAD | BIO

ID: STEP-BRO
PARENT: STEP-MOM | BIO
CHILD: STEP-NEPHEW

ID: STEP-NEPHEW
PARENT: STEP-BRO | BIO
CHILD: STEP-GREAT-NEPHEW

ID: STEP-GREAT-NEPHEW
PARENT: STEP-NEPHEW | BIO
`;

        it('should return a single deduplicated Step-Relationship for Step-Grand-Nephew', () => {
            // Calculate relationship from STEP-GREAT-NEPHEW to ME
            const rels = calc(data, 'STEP-GREAT-NEPHEW', 'ME');

            expect(rels).toHaveLength(1);

            const rel = rels[0];
            expect(rel.type).toBe('LINEAGE');
            expect(rel.isStep).toBe(true);
            
            // Verify Distances
            // STEP-GREAT-NEPHEW is 3 generations down from Common Ancestor Pair (STEP-MOM/DAD)
            expect(rel.distA).toBe(3); 
            // ME is 1 generation down from Common Ancestor Pair
            expect(rel.distB).toBe(1);
        });
    });
    
    describe('Mixed Lineage Pruning (Adoptive Grandparents)', () => {
        const data = `
ID: ME
SEX: M
PARENT: DAD | BIO

ID: DAD
SEX: M
# Dad is connected to me biologically
# But Dad himself is adopted by his parents
PARENT: GRANDPA-ADOPTIVE | ADO
PARENT: GRANDMA-ADOPTIVE | ADO

ID: GRANDPA-ADOPTIVE
SEX: M
UNION: GRANDMA-ADOPTIVE | MARR

ID: GRANDMA-ADOPTIVE
SEX: F
`;

        it('should identify DAD only as Father, pruning the redundant Adoptive Uncle relationship', () => {
            // Without the fix, the calculator sees two paths:
            // 1. Direct: DAD -> ME (Bio)
            // 2. Common Ancestor (Grandpa): DAD is Child (Ado) & ME is Grandchild (Ado pathway).
            //    This creates a false "Adoptive Uncle" relationship if not pruned.
            const rels = calc(data, 'DAD', 'ME');

            expect(rels).toHaveLength(1);
            
            const rel = rels[0];
            expect(rel.type).toBe('LINEAGE');
            expect(rel.distA).toBe(0); // DAD is Ancestor (0 steps up)
            expect(rel.distB).toBe(1); // ME is Descendant (1 step down)
            
            // Ensure the primary relationship is purely recognized as biological father
            // The fact that Dad *has* adoptive parents shouldn't make him an "Adoptive Father" to ME.
            expect(rel.isAdoptive).toBe(false);
        });
    });
});
