import { describe, it, expect, beforeEach } from "vitest";
import FTTParser from "../FTTParser.js";

describe("FTTParser v0.1", () => {
    let parser;

    beforeEach(() => {
        parser = new FTTParser();
    });

    // ==========================================
    // 1. BASIC SYNTAX & PARSING
    // ==========================================
    describe("Basic Syntax", () => {
        it("should parse global headers", () => {
            const input = `
HEAD_FORMAT: FTT v0.1
HEAD_TITLE: My Family Tree
HEAD_ROOT:  I1
`;
            const result = parser.parse(input);
            expect(result.headers["HEAD_FORMAT"]).toBe("FTT v0.1");
            expect(result.headers["HEAD_TITLE"]).toBe("My Family Tree");
            expect(result.headers["HEAD_ROOT"]).toBe("I1");
            expect(result.errors).toHaveLength(0);
        });

        it("should parse a simple individual record", () => {
            const input = `
HEAD_FORMAT: FTT v0.1
ID: PERSON-01
NAME: John Doe | Doe, John
SEX:  M
`;
            const result = parser.parse(input);
            const rec = result.records["PERSON-01"];

            expect(rec).toBeDefined();
            expect(rec.type).toBe("INDIVIDUAL");
            expect(rec.data.NAME[0].parsed[0]).toBe("John Doe");
            expect(rec.data.SEX[0].parsed[0]).toBe("M");
        });

        it("should handle pipe delimiters and empty fields", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
# Format: Display | Sort | Type | Status
NAME: John ||| PREF
`;
            const result = parser.parse(input);
            const name = result.records["A"].data.NAME[0].parsed;

            expect(name[0]).toBe("John");
            expect(name[1]).toBe(""); // Empty
            expect(name[2]).toBe(""); // Empty
            expect(name[3]).toBe("PREF");
        });

        it("should handle escaped pipes", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
NOTES: This is a pipe \\| character
`;
            const result = parser.parse(input);
            const note = result.records["A"].data.NOTES[0].parsed[0];
            expect(note).toBe("This is a pipe | character");
        });

        it("should handle multiline indentation (folding)", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
NOTES: Line 1.
  Line 2.
  Line 3.
`;
            const result = parser.parse(input);
            const raw = result.records["A"].data.NOTES[0].raw;
            expect(raw).toBe("Line 1. Line 2. Line 3.");
        });

        it("should preserve indentation beyond the first 2 spaces (Poetry Support)", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: POET-01
NOTES: The first line.
  
    An indented second line.
  
      A doubly-indented third line.
`;
            const result = parser.parse(input);
            const notes = result.records["POET-01"].data.NOTES[0].raw;

            // Verification:
            // 1. Newlines preserved via blank lines
            // 2. Extra spaces (2 and 4 respectively) are preserved
            expect(notes).toContain(
                "The first line.\n  An indented second line.\n    A doubly-indented third line."
            );
        });

        it("should demonstrate how explicit paragraph breaks are handled", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: PARAGRAPH-TEST
NOTES: Paragraph one.
  
  Paragraph two.
`;
            const result = parser.parse(input);
            const notes = result.records["PARAGRAPH-TEST"].data.NOTES[0].raw;

            // According to Spec 8.1, a blank line should inject a newline marker
            expect(notes).toContain("Paragraph one.\nParagraph two.");
        });
    });

    // ==========================================
    // 2. MODIFIERS & CITATIONS
    // ==========================================
    describe("Modifiers (Adjacency Logic)", () => {
        it("should attach citations to the immediately preceding field", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: 1980
BORN_SRC: ^SRC-1
DIED: 2020

ID: ^SRC-1
`;
            const result = parser.parse(input);
            const born = result.records["A"].data.BORN[0];
            const died = result.records["A"].data.DIED[0];

            expect(born.modifiers["BORN_SRC"]).toBeDefined();
            expect(born.modifiers["BORN_SRC"][0].parsed[0]).toBe("^SRC-1");

            // Ensure it didn't leak to DIED
            expect(died.modifiers).toEqual({});
        });

        it("should error if modifier has no predecessor", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN_SRC: ^SRC-1
`;
            const result = parser.parse(input);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0].code).toBe("CTX_MODIFIER");
        });

        it("should error if modifier type mismatch (BORN_SRC after DIED)", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
DIED: 2020
BORN_SRC: ^SRC-1
`;
            const result = parser.parse(input);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0].code).toBe("CTX_MODIFIER");
        });
    });

    // ==========================================
    // 3. PLACE HIERARCHIES & GEO
    // ==========================================
    describe("Place Parsing", () => {
        it("should parse standard place strings", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: 1980 | City; Region; Country
`;
            const result = parser.parse(input);
            const place = result.records["A"].data.BORN[0].parsed[1];
            expect(place).toBe("City; Region; Country");
        });

        it("should extract historical name metadata {=Modern}", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: 1980 | Berlin {=Kitchener}; Ontario
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];

            expect(field.parsed[1]).toBe("Berlin; Ontario");
            expect(field.metadata.geo).toBe("Kitchener; Ontario");
        });

        it("should extract coordinates <lat, long>", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: 1980 | City <51.5, -0.1>
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];
            expect(field.parsed[1]).toBe("City");
            expect(field.metadata.coords).toBe("51.5, -0.1");
        });
    });

    // ==========================================
    // 4. GRAPH LOGIC (IMPLICIT UNIONS)
    // ==========================================
    describe("Graph Logic", () => {
        it("should inject implicit reciprocal unions", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: HUSB
UNION: WIFE | MARR

ID: WIFE
# No explicit UNION line back to HUSB
`;
            const result = parser.parse(input);
            const wifeRec = result.records["WIFE"];

            expect(wifeRec.data.UNION).toBeDefined();
            expect(wifeRec.data.UNION[0].parsed[0]).toBe("HUSB");
            expect(wifeRec.data.UNION[0].isImplicit).toBe(true);
        });

        it("should warn on inconsistent reciprocal unions", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
UNION: B | MARR

ID: B
UNION: A | PART
`;
            const result = parser.parse(input);
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings[0].code).toBe("DATA_CONSISTENCY");
        });
    });

    // ==========================================
    // 5. VALIDATION & ERRORS
    // ==========================================
    describe("Validation", () => {
        it("should detect dangling references", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
PARENT: MISSING_ID | BIO
`;
            const result = parser.parse(input);
            expect(result.errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "DANGLING_REF" })])
            );
        });

        it("should allow references to Placeholder IDs (?)", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
PARENT: ?UNK-FATHER | BIO
`;
            const result = parser.parse(input);
            expect(result.errors).toHaveLength(0);
        });

        it("should detect Ghost Children (Child not reciprocating Parent)", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: PARENT
CHILD: KID

ID: KID
# Missing PARENT: PARENT
`;
            const result = parser.parse(input);
            expect(result.errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "GHOST_CHILD" })])
            );
        });

        it("should detect Circular Lineage", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
PARENT: B | BIO

ID: B
PARENT: A | BIO
`;
            const result = parser.parse(input);
            expect(result.errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "CIRCULAR_LINEAGE" })])
            );
        });

        it("should detect Circular Lineage involving Placeholder records", () => {
            // Regression test: Placeholders (?) should not block cycle detection
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
PARENT: B | BIO

ID: B
PARENT: ?C | BIO

ID: ?C
PARENT: A | BIO
`;
            const result = parser.parse(input);
            expect(result.errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "CIRCULAR_LINEAGE" })])
            );
        });

        it("should validate ISO 8601 / EDTF dates", () => {
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

        it("should error on invalid dates", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: May 12, 1980
`;
            const result = parser.parse(input);
            expect(result.errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "INVALID_DATE" })])
            );
        });

        it("should normalize IDs to NFC to ensure cross-compatibility between different Unicode forms", () => {
            // "Müller" written in two different ways:
            // 1. Composed (NFC): \u00dc (Ü)
            // 2. Decomposed (NFD): U + \u0308 (U + diaeresis)
            const idNFC = "M\u00dcLLER-1890";
            const idNFD = "MU\u0308LLER-1890";

            const input = `
HEAD_FORMAT: FTT v0.1
ID: ${idNFD}
NAME: Hans Müller

ID: CHILD-01
PARENT: ${idNFC} | BIO
`;

            const result = parser.parse(input);

            // 1. Verify the defined ID was normalized to NFC in the records map
            expect(result.records[idNFC]).toBeDefined();

            // 2. Verify that the NFD input was not stored as a separate unique key
            expect(Object.keys(result.records)).toContain(idNFC);

            // 3. Verify the PARENT link (provided as NFC) matches the NFD definition
            // because both were normalized to the same NFC string during parsing.
            expect(result.errors).toHaveLength(0);

            const childRecord = result.records["CHILD-01"];
            const parentRef = childRecord.data.PARENT[0].parsed[0];

            // The reference inside the data should also be normalized NFC
            expect(parentRef).toBe(idNFC);
        });

        it("should respect CHILD tag order and append sorted implicit children", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: PARENT
NAME: The Parent
# Explicit Order: Youngest first (User preference)
CHILD: CHILD-EX-2
CHILD: CHILD-EX-1

# Explicit Child 1 (Older)
ID: CHILD-EX-1
NAME: Explicit 1
BORN: 1980
PARENT: PARENT

# Explicit Child 2 (Younger)
ID: CHILD-EX-2
NAME: Explicit 2
BORN: 1985
PARENT: PARENT

# Implicit Child (Forgotten in manifest, born LAST)
ID: CHILD-IM-LATE
NAME: Implicit Late
BORN: 2000
PARENT: PARENT

# Implicit Child (Forgotten in manifest, born EARLIEST)
ID: CHILD-IM-EARLY
NAME: Implicit Early
BORN: 1970
PARENT: PARENT
`;

            const parser = new FTTParser();
            const result = parser.parse(input);

            const parent = result.records["PARENT"];
            expect(parent).toBeDefined();
            expect(parent.data.CHILD).toBeDefined();

            // Map the CHILD objects to their IDs for easy checking
            const childIds = parent.data.CHILD.map((c) => c.parsed[0]);

            // EXPECTED LOGIC:
            // 1. Explicit tags come first, strictly in the order listed in the file (EX-2, then EX-1)
            // 2. Implicit children come after, sorted by Birth Date (EARLY 1970, then LATE 2000)

            const expectedOrder = [
                "CHILD-EX-2", // Explicit #1
                "CHILD-EX-1", // Explicit #2
                "CHILD-IM-EARLY", // Implicit (1970)
                "CHILD-IM-LATE" // Implicit (2000)
            ];

            expect(childIds).toEqual(expectedOrder);
        });
    });

    describe("Advanced Graph Integrity", () => {
        it("should detect complex multi-generational and placeholder-inclusive circular lineages", () => {
            /**
             * Scenario: 4-Generation Loop with a Placeholder
             * A -> B -> ?C -> D -> A
             */
            const input = `
HEAD_FORMAT: FTT v0.1

ID: RECORD-A
PARENT: RECORD-B | BIO

ID: RECORD-B
PARENT: ?PLACEHOLDER-C | BIO

ID: RECORD-D
PARENT: RECORD-A | BIO

# The link that closes the loop
ID: ?PLACEHOLDER-C
PARENT: RECORD-D | BIO
`;

            const result = parser.parse(input);

            // Verify parser flags CIRCULAR_LINEAGE [cite: 1201, 1205]
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "CIRCULAR_LINEAGE",
                        message: expect.stringContaining(
                            "RECORD-A -> RECORD-B -> ?PLACEHOLDER-C -> RECORD-D -> RECORD-A"
                        )
                    })
                ])
            );
        });

        it("should not flag legitimate endogamy (multiple paths to one ancestor) as a cycle", () => {
            /**
             * Scenario: Pedigree Collapse (Standard in genealogy)
             * ME -> DAD -> GP
             * ME -> MOM -> GP
             * This is a "Diamond" shape, not a circle. [cite: 993, 997]
             */
            const input = `
HEAD_FORMAT: FTT v0.1

ID: GP
NAME: Common Ancestor

ID: DAD
PARENT: GP | BIO

ID: MOM
PARENT: GP | BIO

ID: ME
PARENT: DAD | BIO
PARENT: MOM | BIO
`;

            const result = parser.parse(input);

            // Validation should pass as it is a Directed Acyclic Graph
            expect(result.errors.filter((e) => e.code === "CIRCULAR_LINEAGE")).toHaveLength(0);
        });
    });

    describe("Strict Syntax (Unknown Keys)", () => {
        it("should throw a fatal SYNTAX_INVALID error when an unknown key is encountered", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: PERSON-01
NAME: John Doe
INVALID_KEY: Some data here
`;
            const result = parser.parse(input);

            // 1. Check for the specific error code defined in the spec
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "SYNTAX_INVALID",
                        severity: "FATAL"
                    })
                ])
            );

            // 2. Ensure parsing halted and no records were returned (Fatal Error behavior)
            expect(Object.keys(result.records)).toHaveLength(0);
        });

        it("should allow user-defined extension keys starting with an underscore", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: PERSON-01
NAME: John Doe
_EYE_COLOR: Blue
`;
            const result = parser.parse(input);

            // Extensions should not trigger syntax errors
            expect(result.errors).toHaveLength(0);
            expect(result.records["PERSON-01"].data["_EYE_COLOR"]).toBeDefined();
            expect(result.records["PERSON-01"].data["_EYE_COLOR"][0].raw).toBe("Blue");
        });

        it("should allow valid modifier keys (SRC/NOTE) immediately following their target", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
BORN: 1980
BORN_SRC: ^SRC-1
BORN_NOTE: Research note

ID: ^SRC-1
`;
            const result = parser.parse(input);

            // Modifiers are part of the recognized key logic
            expect(result.errors).toHaveLength(0);
            const born = result.records["A"].data.BORN[0];
            expect(born.modifiers["BORN_SRC"]).toBeDefined();
            expect(born.modifiers["BORN_NOTE"]).toBeDefined();
        });
    });

    // ==========================================
    // 6. Location Escaping
    // ==========================================
    describe("Location Escaping Tests", () => {
        it("should handle escaped syntax characters in Place Hierarchies", () => {
            // Bug: Previous parser stripped backslashes too early, causing \{ to be parsed as {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
# Literal braces should NOT trigger geocoding logic
BORN: 1980 | Old Name \\{=Modern Name\\}; Region
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];

            // Should display literal curly braces
            expect(field.parsed[1]).toBe("Old Name {=Modern Name}; Region");
            // Should NOT have extracted "Modern Name" as the geo override
            expect(field.metadata.geo).toBeUndefined();
        });

        it("should handle escaped angle brackets in Place Hierarchies", () => {
            // Bug: Previous parser regex treated \<...\> as coordinates
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
# Literal angle brackets should NOT trigger coordinate logic
BORN: 1980 | The Pub \\<Old\\>; London
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];

            expect(field.parsed[1]).toBe("The Pub <Old>; London");
            expect(field.metadata.coords).toBeUndefined();
        });

        it("should parse complex mixed escaping and syntax in Places", () => {
            // Complex case: Real coords mixed with escaped brackets and pipe separation
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
# "City {=Modern} <10,10>" (Valid Syntax) + "; Literal \\<Part\\>" (Escaped)
BORN: 1980 | City {=Modern} <10.0, 10.0>; Literal \\<Part\\>
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];

            // 1. Display String: "City" (stripped Modern) + "; Literal <Part>" (Unescaped)
            expect(field.parsed[1]).toBe("City; Literal <Part>");

            // 2. Geo Metadata: "Modern" (extracted) + "; Literal <Part>" (Unescaped)
            expect(field.metadata.geo).toBe("Modern; Literal <Part>");

            // 3. Coords: Extracted from the first segment
            expect(field.metadata.coords).toBe("10.0, 10.0");
        });

        it("should handle escaped pipes within escaped place strings", () => {
            const input = `
HEAD_FORMAT: FTT v0.1

ID: A
# Pipe inside place name: "City | Name"
BORN: 1980 | City \\| Name; Country
`;
            const result = parser.parse(input);
            const field = result.records["A"].data.BORN[0];

            expect(field.parsed[1]).toBe("City | Name; Country");
        });
    });
});
