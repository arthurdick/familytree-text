import { describe, it, expect, beforeEach } from "vitest";
import GedcomImporter from "../GedcomImporter.js";

describe("GedcomImporter", () => {
    let importer;

    beforeEach(() => {
        importer = new GedcomImporter();
    });

    // ==========================================
    // 1. BASIC STRUCTURE & ENCODING
    // ==========================================
    describe("Basic Structure & Encoding", () => {
        it("should generate valid FTT global headers", () => {
            const input = `0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n0 TRLR`;
            const result = importer.convert(input);

            expect(result).toContain("HEAD_FORMAT: FTT v0.1");
            expect(result).toContain("HEAD_TITLE: GEDCOM Import");
            expect(result).toContain("ID: I1");
        });

        it("should throw error on unsupported encoding (ANSEL)", () => {
            const input = `0 HEAD\n1 CHAR ANSEL\n0 TRLR`;
            expect(() => importer.convert(input)).toThrow(/Unsupported Encoding/);
        });

        it("should ignore structural tags (HEAD, TRLR) in loss report", () => {
            const input = `0 HEAD\n1 CHAR UTF-8\n0 TRLR`;
            const result = importer.convert(input);
            // Should not see "[HEAD] Unhandled" in the output
            expect(result).not.toContain("Unhandled HEAD");
            expect(result).not.toContain("Unhandled TRLR");
        });
    });

    // ==========================================
    // 2. INDIVIDUAL PARSING
    // ==========================================
    describe("Individual Records", () => {
        it("should parse basic identity fields (ID, NAME, SEX)", () => {
            const input = `
0 @I1@ INDI
1 NAME John /Doe/
1 SEX M
      `;
            const result = importer.convert(input);

            expect(result).toContain("ID: I1");
            // FTT Format: Display | Sort | Type | Status
            expect(result).toContain("NAME: John Doe | Doe, John | BIRTH | PREF");
            expect(result).toContain("SEX:  M");
        });

        it("should handle complex names with SURN/GIVN sub-tags", () => {
            const input = `
0 @I1@ INDI
1 NAME John /Doe/
2 SURN Doe
2 GIVN John
2 TYPE BIRTH
      `;
            const result = importer.convert(input);
            // Should mark SURN/GIVN as handled and not report loss
            expect(result).toContain("NAME: John Doe | Doe, John | BIRTH | PREF");
            expect(result).not.toContain("Unhandled SURN");
        });

        it("should extract Nicknames into separate records", () => {
            const input = `
0 @I1@ INDI
1 NAME Robert /Smith/
2 NICK Bob
      `;
            const result = importer.convert(input);
            expect(result).toContain("NAME: Bob || NICK |");
        });

        it("should handle multiline Notes (CONT/CONC)", () => {
            const input = `
0 @I1@ INDI
1 NOTE This is line 1.
2 CONT This is line 2 (New Paragraph).
2 CONC This is concatenated to line 2.
      `;
            const result = importer.convert(input);
            expect(result).toContain("NOTES: This is line 1.");
            expect(result).toContain(
                "  This is line 2 (New Paragraph).This is concatenated to line 2."
            );
        });
    });

    // ==========================================
    // 3. EVENTS, DATES & PLACES
    // ==========================================
    describe("Events & attributes", () => {
        it("should map BIRT/DEAT to BORN/DIED with dates", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 DATE 10 JAN 1980
1 DEAT
2 DATE 2020
      `;
            const result = importer.convert(input);
            expect(result).toContain("BORN: 1980-01-10 |");
            expect(result).toContain("DIED: 2020 |");
        });

        it("should convert GEDCOM date modifiers (ABT, BEF, BET)", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 DATE ABT 1900
1 DEAT
2 DATE BET 1980 AND 1990
      `;
            const result = importer.convert(input);
            expect(result).toContain("BORN: 1900~ |");
            expect(result).toContain("DIED: [1980..1990] |");
        });

        it("should normalize places and handle coordinates (MAP)", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 PLAC Berlin, Germany
3 MAP
4 LATI 52.5
4 LONG 13.4
      `;
            const result = importer.convert(input);
            // FTT expects semicolon separators for places and <lat, long>
            expect(result).toContain("BORN:  | Berlin; Germany <52.5, 13.4>");
        });
    });

    // ==========================================
    // 4. FAMILY LINKAGE
    // ==========================================
    describe("Family Linking", () => {
        const familyData = `
0 @HUSB@ INDI
1 NAME Father /./
1 SEX M
1 FAMS @F1@

0 @WIFE@ INDI
1 NAME Mother /./
1 SEX F
1 FAMS @F1@

0 @CHILD@ INDI
1 NAME Kid /./
1 FAMC @F1@

0 @F1@ FAM
1 HUSB @HUSB@
1 WIFE @WIFE@
1 CHIL @CHILD@
1 MARR
2 DATE 1990
    `;

        it("should create UNION records on spouses", () => {
            const result = importer.convert(familyData);
            // HUSB should link to WIFE
            expect(result).toMatch(/ID: HUSB[\s\S]*UNION: WIFE \| MARR \| 1990 \| {2}\|/);
            // WIFE should link to HUSB
            expect(result).toMatch(/ID: WIFE[\s\S]*UNION: HUSB \| MARR \| 1990 \| {2}\|/);
        });

        it("should create PARENT links on the child", () => {
            const result = importer.convert(familyData);
            expect(result).toMatch(/ID: CHILD[\s\S]*PARENT: HUSB \| BIO/);
            expect(result).toMatch(/ID: CHILD[\s\S]*PARENT: WIFE \| BIO/);
        });

        it("should create explicit CHILD lists on parents (Order Preservation)", () => {
            const result = importer.convert(familyData);
            expect(result).toMatch(/ID: HUSB[\s\S]*CHILD: CHILD/);
            expect(result).toMatch(/ID: WIFE[\s\S]*CHILD: CHILD/);
        });

        it("should handle Divorces", () => {
            const divData = `
0 @I1@ INDI
1 FAMS @F1@
0 @I2@ INDI
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 DIV
2 DATE 2000
      `;
            const result = importer.convert(divData);
            // Expectation: Should map to DIV reason with empty start date
            // Output format: | Start | End | Reason
            expect(result).toContain("UNION: I2 | MARR |  | 2000 | DIV");
        });

        it("should import Common Law unions from generic EVEN tags", () => {
            const input = `
0 @I1@ INDI
1 FAMS @F1@
0 @I2@ INDI
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 EVEN
2 TYPE Common Law
2 DATE 1999
`;
            const ftt = importer.convert(input);

            // Expectation: Should detect TYPE "Common Law" and use PART
            // Output format: | Start | End | Reason
            expect(ftt).toContain("UNION: I2 | PART | 1999 |  |");
            expect(ftt).toContain("UNION: I1 | PART | 1999 |  |");

            // Should NOT default to MARR
            expect(ftt).not.toContain("| MARR |");
        });

        it("should auto-repair 'Ghost Children' (Missing FAMC tags)", () => {
            // GEDCOM where Family lists Child, but Child doesn't list Family
            const ghostData = `
0 @P1@ INDI
1 NAME Dad /./
1 SEX M
1 FAMS @F1@

0 @C1@ INDI
1 NAME Ghost /Child/
// Intentionally missing: 1 FAMC @F1@

0 @F1@ FAM
1 HUSB @P1@
1 CHIL @C1@
`;
            const result = importer.convert(ghostData);

            // The importer should have detected the one-way link
            // and injected the PARENT tag into C1's record.
            expect(result).toMatch(/ID: C1[\s\S]*PARENT: P1 \| BIO/);

            // It should NOT treat this valid repair as data loss
            expect(result).not.toContain("Unhandled CHIL");
        });
    });

    // ==========================================
    // 5. SOURCES & CITATIONS
    // ==========================================
    describe("Sources", () => {
        it("should extract Source Records (SOUR)", () => {
            const input = `
0 @S1@ SOUR
1 TITL 1900 US Census
1 AUTH US Govt
0 @I1@ INDI
      `;
            const result = importer.convert(input);
            expect(result).toContain("ID: ^S1");
            expect(result).toContain("TITLE: 1900 US Census");
            expect(result).toContain("AUTHOR: US Govt");
        });

        it("should handle inline citations on events", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 DATE 1900
2 SOUR @S1@
3 PAGE p. 45
0 @S1@ SOUR
      `;
            const result = importer.convert(input);
            expect(result).toContain("BORN: 1900 |");
            expect(result).toContain("BORN_SRC: ^S1 | p. 45");
        });
    });

    // ==========================================
    // 6. AUDIT & LOSS REPORTING
    // ==========================================
    describe("Loss Reporting", () => {
        it("should generate a report at the bottom of the file", () => {
            const input = `
0 @I1@ INDI
1 NAME Test /Person/
1 _CUSTOM_TAG Some Value
      `;
            const result = importer.convert(input);

            const lines = result.split("\n");
            const reportStart = lines.findIndex((l) => l.includes("IMPORT WARNINGS"));

            expect(reportStart).toBeGreaterThan(0);
            expect(result).toContain('Unhandled _CUSTOM_TAG = "Some Value"');
        });

        it("should not report handled nested tags (like PLAC/MAP)", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 PLAC City
3 MAP
4 LATI 1
4 LONG 2
      `;
            const result = importer.convert(input);
            expect(result).not.toContain("Unhandled MAP");
            expect(result).not.toContain("Unhandled LATI");
        });

        it("should report unhandled tags inside known structures", () => {
            const input = `
0 @I1@ INDI
1 BIRT
2 DATE 1900
2 _UNKNOWN_TAG 123
        `;
            const result = importer.convert(input);
            expect(result).toContain('Unhandled _UNKNOWN_TAG = "123"');
        });
    });
});
