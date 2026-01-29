/**
 * implementations/js/tests/GedcomExporter.test.js
 */
import { describe, it, expect, beforeEach } from "vitest";
import GedcomExporter from "../GedcomExporter.js";

describe("GedcomExporter", () => {
    let exporter;

    beforeEach(() => {
        exporter = new GedcomExporter();
    });

    /**
     * Helper to prepend the required FTT Header to snippets.
     * Use this for all functional tests where the header itself isn't the focus.
     */
    const convertWithHeader = (content) => {
        const fullContent = `HEAD_FORMAT: FTT v0.1\n${content}`;
        return exporter.convert(fullContent);
    };

    // ==========================================
    // 1. STRUCTURE & HEADERS (Manual Header Control)
    // ==========================================
    describe("Structure & Headers", () => {
        it("should generate valid GEDCOM 5.5.1 headers", () => {
            const input = `
HEAD_FORMAT: FTT v0.1
ID: I1
NAME: Test
`;
            const gedcom = exporter.convert(input);

            expect(gedcom).toContain("0 HEAD");
            expect(gedcom).toContain("1 SOUR FTT_CONVERTER");
            expect(gedcom).toContain("1 GEDC");
            expect(gedcom).toContain("2 VERS 5.5.1");
            expect(gedcom).toContain("1 CHAR UTF-8");
            expect(gedcom).toContain("0 TRLR");
        });

        it("should throw error on invalid FTT input (Missing Header)", () => {
            const input = `ID: P1\nNAME: No Header`;
            expect(() => exporter.convert(input)).toThrow(/Cannot export invalid FTT/);
        });
    });

    // ==========================================
    // 2. INDIVIDUAL RECORDS
    // ==========================================
    describe("Individual Records", () => {
        it("should export basic individual attributes", () => {
            const input = `
ID: P1
NAME: John Doe | Doe, John
SEX: M
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("0 @P1@ INDI");
            // Standard GEDCOM format: Given /Surname/
            expect(gedcom).toContain("1 NAME John /Doe/");
            expect(gedcom).toContain("1 SEX M");
        });

        it("should handle Vital Events (BIRT, DEAT) with Dates and Places", () => {
            const input = `
ID: P1
BORN: 1980-01-01 | Calgary; Alberta
DIED: 2020-12-31 | Vancouver; BC
`;
            const gedcom = convertWithHeader(input);

            // Birth
            expect(gedcom).toContain("1 BIRT");
            expect(gedcom).toContain("2 DATE 1 JAN 1980");
            expect(gedcom).toContain("2 PLAC Calgary, Alberta"); // Now checks for fixed spacing

            // Death
            expect(gedcom).toContain("1 DEAT");
            expect(gedcom).toContain("2 DATE 31 DEC 2020");
            expect(gedcom).toContain("2 PLAC Vancouver, BC");
        });

        it("should export Map Coordinates", () => {
            const input = `
ID: P1
BORN: 1980 | City <51.05, -114.07>
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("2 PLAC City");
            expect(gedcom).toContain("3 MAP");
            expect(gedcom).toContain("4 LATI 51.05");
            expect(gedcom).toContain("4 LONG -114.07");
        });

        it("should export Historical Place Names as Notes", () => {
            const input = `
ID: P1
BORN: 1900 | Berlin {=Kitchener}; Ontario
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("2 PLAC Berlin, Ontario");
            // The exporter attaches the metadata as a note on the PLAC
            expect(gedcom).toContain("3 NOTE Standardized/Modern Place: Kitchener, Ontario");
        });
    });

    // ==========================================
    // 3. DATE FORMATTING
    // ==========================================
    describe("Date Conversion", () => {
        it("should convert various ISO/EDTF formats to GEDCOM", () => {
            const input = `
ID: P1
# Exact
BORN: 1990-05-12
# Year/Month (Generic Event)
EVENT: EVT1 | 1990-06 || Test
# Range
EVENT: EVT2 | [1900..1910] || Test
# Approx
EVENT: EVT3 | 1950? || Test
# Before/After
EVENT: EVT4 | [..1900] || Test
EVENT: EVT5 | [1900..] || Test
`;
            const gedcom = convertWithHeader(input);

            expect(gedcom).toContain("2 DATE 12 MAY 1990");
            expect(gedcom).toContain("2 DATE JUN 1990");
            expect(gedcom).toContain("2 DATE BET 1900 AND 1910");
            expect(gedcom).toContain("2 DATE ABT 1950");
            expect(gedcom).toContain("2 DATE BEF 1900");
            expect(gedcom).toContain("2 DATE AFT 1900");
        });
    });

    // ==========================================
    // 4. FAMILY RECONSTRUCTION
    // ==========================================
    describe("Family Linking", () => {
        it("should link Spouses (HUSB/WIFE) via UNION", () => {
            const input = `
ID: H1
SEX: M
UNION: W1 | MARR | 2000-01-01

ID: W1
SEX: F
UNION: H1 | MARR | 2000-01-01
`;
            const gedcom = convertWithHeader(input);

            // Check Individual Links
            expect(gedcom).toContain("1 FAMS @F1@"); // Both should point to generated Family ID

            // Check Family Record
            expect(gedcom).toContain("0 @F1@ FAM");
            expect(gedcom).toContain("1 HUSB @H1@");
            expect(gedcom).toContain("1 WIFE @W1@");

            // Check Marriage Event
            expect(gedcom).toContain("1 MARR");
            expect(gedcom).toContain("2 DATE 1 JAN 2000");
        });

        it("should link Children to Parents (FAMC/CHIL)", () => {
            const input = `
ID: DAD
SEX: M
CHILD: KID

ID: KID
PARENT: DAD | BIO
`;
            const gedcom = convertWithHeader(input);

            // Kid points to family
            expect(gedcom).toContain("0 @KID@ INDI");
            expect(gedcom).toContain("1 FAMC @F1@");

            // Family contains kid
            expect(gedcom).toContain("0 @F1@ FAM");
            expect(gedcom).toContain("1 HUSB @DAD@");
            expect(gedcom).toContain("1 CHIL @KID@");
        });

        it("should handle Divorce", () => {
            const input = `
ID: H1
SEX: M
UNION: W1 | MARR | 1990 | 2000 | DIV
ID: W1
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("1 DIV");
            expect(gedcom).toContain("2 DATE 2000");
        });
    });

    // ==========================================
    // 5. SOURCES & CITATIONS
    // ==========================================
    describe("Sources", () => {
        it("should export Source records and link citations", () => {
            const input = `
ID: P1
BORN: 1980
BORN_SRC: ^S1 | Page 55

ID: ^S1
TITLE: Birth Registry
AUTHOR: Gov
`;
            const gedcom = convertWithHeader(input);

            // Source Definition (Strip caret from ID)
            expect(gedcom).toContain("0 @S1@ SOUR");
            expect(gedcom).toContain("1 TITL Birth Registry");
            expect(gedcom).toContain("1 AUTH Gov");

            // Citation on Event
            expect(gedcom).toContain("1 BIRT");
            expect(gedcom).toContain("2 SOUR @S1@");
            expect(gedcom).toContain("3 PAGE Page 55");
        });
    });

    // ==========================================
    // 6. DOWNGRADES & AUDITS
    // ==========================================
    describe("Downgrade Logic", () => {
        it("should convert Placeholders to dummy Individuals if explicit", () => {
            const input = `
ID: P1
PARENT: ?UNK | BIO

# Explicitly define the placeholder so the exporter finds it
ID: ?UNK
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("0 @?UNK@ INDI");
            expect(gedcom).toContain("1 NAME Unknown /Placeholder/");
        });

        it("should create an Audit Note for semantic downgrades (e.g. PART -> MARR)", () => {
            const input = `
ID: P1
UNION: P2 | PART
ID: P2
`;
            const gedcom = convertWithHeader(input);

            // FTT "PART" (Partner) becomes GEDCOM "MARR" with a Type note
            expect(gedcom).toContain("1 MARR");
            expect(gedcom).toContain("2 TYPE Common Law / Partner");

            // Check for Audit Report at the end
            expect(gedcom).toContain("0 @NOTE_AUDIT@ NOTE");
            expect(gedcom).toContain("FTT -> GEDCOM DOWNGRADE REPORT");
            expect(gedcom).toContain("Union Type 'PART' exported as 'MARR'");
        });
    });

    // ==========================================
    // 7. ASSOCIATIONS
    // ==========================================
    describe("Associations", () => {
        it("should export ASSO records", () => {
            const input = `
ID: P1
ASSOC: P2 | GODP | 2000 || Baptism Link
ID: P2
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("1 ASSO @P2@");
            expect(gedcom).toContain("2 RELA GODP");
            expect(gedcom).toContain("2 NOTE Baptism Link");

            // Note: Date on ASSO is stripped in GEDCOM 5.5.1
            expect(gedcom).toContain("Date '2000' stripped");
        });
    });

    // ==========================================
    // 8. NOTES & COMMENTS
    // ==========================================
    describe("Notes & Comments", () => {
        it("should export record-level NOTES for Individuals", () => {
            const input = `
ID: P1
NAME: Note Tester
NOTES: This is a general note about the person.

  It continues on a second line.
`;
            const gedcom = convertWithHeader(input);
            expect(gedcom).toContain("1 NOTE This is a general note about the person.");
            expect(gedcom).toContain("2 CONT It continues on a second line.");
        });

        it("should export record-level NOTES for Sources", () => {
            const input = `
ID: P1
NAME: Src Tester

ID: ^S1
TITLE: Source with Notes
NOTES: This source is questionable.
`;
            const gedcom = convertWithHeader(input);

            expect(gedcom).toContain("0 @S1@ SOUR");
            expect(gedcom).toContain("1 NOTE This source is questionable.");
        });

        it("should export field-level modifiers (_NOTE) on Events", () => {
            const input = `
ID: P1
BORN: 1980 | Hospital
BORN_NOTE: Birth certificate was hard to read.

  Maybe 1981?
`;
            const gedcom = convertWithHeader(input);

            // BIRT is Level 1, so Note should be Level 2
            expect(gedcom).toContain("1 BIRT");
            expect(gedcom).toContain("2 NOTE Birth certificate was hard to read.");
            expect(gedcom).toContain("3 CONT Maybe 1981?");
        });

        it("should export notes on generic inline EVENTS", () => {
            const input = `
ID: P1
EVENT: GRAD | 2000 || College
EVENT_NOTE: Graduated with honors.
`;
            const gedcom = convertWithHeader(input);

            expect(gedcom).toContain("1 EVEN");
            expect(gedcom).toContain("2 TYPE GRAD");
            expect(gedcom).toContain("2 NOTE Graduated with honors.");
        });
    });
});
