# **FamilyTree-Text (FTT) Specification v0.1**

**Status:** Draft / Proposed Standard

**Date:** 2026-01-20

**Core Principle:** Data durability through human-readable, machine-parseable UTF-8 plain text.

---

### **1. File Structure & Integrity**

* **Encoding:** Must be saved in **UTF-8**.
* **File Extension:** `.ftt` (preferred) or `.txt`.
* **Record Separator:** Records are identified by the `ID:` anchor.
* **Comments:** Any line beginning with the hash character `#` at column 0 must be ignored.
* **Visual Separators:** A horizontal rule `---` acts as a **block terminator**. Parsers must terminate the current field/record block immediately upon encountering this line, and then ignore the line itself.
* **Escaping:** The backslash `\` is the escape character. The parser should strip the backslash and treat the following character as a string literal rather than a control character.
* `\|` for literal pipe characters.
* `\\` for literal backslashes.
* `\;` for literal semicolons (Place Hierarchies).
* `\{` and `\}` for literal curly braces (Place Historical Names).
* `\<` and `\>` for literal angle brackets (Place Coordinates).

### **1.1 Strict Indentation & Block Logic**

To ensure unambiguous parsing without complex lookahead requirements, the structure is defined strictly by column position.

* **Key Position:** All Keys (e.g., `NAME:`, `BORN:`) **must** appear at the start of the line (Column 0).
* **Content Indentation:** Any line beginning with exactly **2 spaces** is treated as a continuation of the previous key's value.
* **Blank Lines (Paragraph Breaks):**
* A line that is **empty** or contains **only whitespace** is treated as a Paragraph Break if it occurs between two indented content lines.
* It does **not** terminate the current block.

* **Block Scope & Termination:**
* A field's content block continues as long as subsequent lines are **indented** or **blank**.
* The block is **terminated** immediately upon encountering a line that contains non-whitespace characters at **Column 0** (e.g., a new Key, a Record Separator `ID:`, or a visual separator `---`).

### **1.2 Pipe-Delimited Field Parsing**

When fields use the pipe character `|` to separate values, the position of the data is strictly determined by the number of pipe separators preceding it.

* **Escaping Delimiters:** Literal pipe characters appearing within a field’s content **must be escaped** using a backslash `\|`. Parsers must interpret `\|` as a literal character and not a field separator.
* **Whitespace Trimming:** Parsers **must trim** all leading and trailing whitespace surrounding the content between pipes. `Value A | Value B` parses as `"Value A"` and `"Value B"`.
* **Positional Integrity:** To define a value for a field later in the sequence, **all preceding fields must be represented by a pipe separator**, even if those fields are empty.
* **Syntax:** Use double pipes `||` to indicate an empty field.
* **Trailing Omission:** Trailing pipe separators **may be omitted** if all subsequent fields are empty.

---

## **2. Global Metadata (Header)**

Files begin with global metadata keys *before* the first `ID:` anchor is declared.

| Key | Description | Example |
| --- | --- | --- |
| **HEAD_FORMAT:** | **Required.** Spec version. | `FTT v0.1` |
| **HEAD_TITLE:** | Title of the tree/project. | My Family History |
| **HEAD_ROOT:** | Root ID of the project. | SMITH-1980 |
| **HEAD_AUTHOR:** | Name of the researcher. | Jane Doe |
| **HEAD_DATE:** | Date of export/creation. | 2026-01-10 |
| **HEAD_COPYRIGHT:** | License or copyright info. | CC-BY-SA 4.0 |

---

## **3. The ID System (Namespacing)**

To ensure consistent linking across different parsers and manual data entry, the ID system enforces strict character sets and normalization rules.

### **3.1 Encoding & Normalization**

* **Case Sensitivity:** IDs are **Case-Sensitive**. `smith-1980` is distinct from `SMITH-1980`.
* **Normalization:** To ensure that identical-looking characters result in identical byte sequences, parsers and writers **must** treat all IDs as **Unicode Normalization Form C (NFC)**.
  * *Requirement:* When parsing a file, the parser must normalize all captured IDs to NFC before storing them in memory or performing lookups.
* **Uniqueness:** Every ID within a single `.ftt` file must be unique. An ID serves as a global anchor for a specific entity; therefore, the same ID string cannot be used to initialize multiple record blocks.

* **Forbidden Characters:** To ensure clean parsing, IDs **must not** contain:
  * Whitespace (Spaces, Tabs).
  * Pipe characters `|`.
  * Semicolons `;`.
  * Control characters.
  * Standard IDs: Must not begin with `^`, `&`, `?`.

### **3.2 Character Rules & Sigils**

FTT uses a **Semantic Sigil System** to differentiate between record types. The first character of an ID string strictly determines its type and validation rules.

#### **3.2.1 Standard IDs (People)**

* **Sigil:** None. The ID must start with a valid alphanumeric character.
* **Allowed Characters:** Any Unicode Letter (`\p{L}`), any Unicode Number (`\p{N}`), and the standard Hyphen-Minus (`-`).
* **Scope:** This supports international naming conventions in native scripts.
* **Examples:**
  * `DOUGLAS-1904` (Latin)
  * `ГОРБАЧЕВ-1931` (Cyrillic)
  * `MÜLLER-1890` (Latin Extended)
  * `田中-1950` (CJK)

#### **3.2.2 Source IDs (The `^` Sigil)**

* **Sigil:** `^` (Caret).
* **Meaning:** A bibliographic record or citation.
* **Example:** `^SRC-CENSUS-1921`

#### **3.2.3 Shared Event IDs (The `&` Sigil)**

* **Sigil:** `&` (Ampersand).
* **Meaning:** A shared historical event linking multiple people.
* **Example:** `&EVT-CORONATION-1953`

#### **3.2.4 Placeholder IDs (The `?` Sigil)**

* **Sigil:** `?` (Question Mark).
* **Meaning:** An explicit reference to a missing or unknown record (Safe Harbor).
* **Example:** `?UNK-FATHER` or `?DNA-MATCH-01`

### **3.3 ID Formats**

| ID Type | Sigil | Namespace | Format Recommendation |
| --- | --- | --- | --- |
| **Individual** | (None) | `[\p{L}\p{N}]...` | `[SURNAME]-[YYYY]-[INITIALS]-[NUM]` |
| **Source** | `^` | `^SRC` | `^SRC-[SHORT_TITLE]` |
| **Shared Event** | `&` | `&EVT` | `&EVT-[TYPE]-[YEAR]-[DESC]` |
| **Placeholder** | `?` | `?UNK` | `?UNK-[DESC]` or `?DNA-[MATCH]` |

---

## **4. Individual Record Reference**

| Key | Repeatable | Description | Format / Notes |
| --- | --- | --- | --- |
| **Identity** |  |  |  |
| `ID:` | **No** | Unique Anchor. | `[ID]` |
| `PRIVACY:` | **No** | **Privacy/Living Status.** | `OPEN`, `LIVING`, or `PRIVATE` (Default: `OPEN`) |
| `NAME:` | **Yes** | Name entry. | `[Display_String] \| [Sort_Key] \| [TYPE] \| [STATUS]` |
| `SEX:` | No | Individual sex. | `M`, `F`, `U`, or `O` |
| **Vital Events** |  |  |  |
| `BORN:` | Yes | Date and location of birth. | `[DATE] \| [PLACE]` |
| `DIED:` | Yes | Date and location of death. | `[DATE] \| [PLACE]` |
| **Life & Bio** |  |  |  |
| `EVENT:` | **Yes** | **Inline** Life Event. | `[TYPE] \| [START_DATE] \| [END_DATE] \| [PLACE] \| [DETAILS]` |
| `EVENT_REF:` | **Yes** | **Linked** Shared Event. | `[&EVT-ID] \| [ROLE] \| [DETAILS]` |
| **Relationships** |  |  |  |
| `PARENT:` | **Yes** | Link to parent. | `[ID] \| [TYPE] \| [START_DATE] \| [END_DATE]` |
| `CHILD:` | **Yes** | Link to child (Sequence defined by line order). | `[ID]` |
| `UNION:` | **Yes** | Link to spouse/partner. | `[ID] \| [TYPE] \| [START_DATE] \| [END_DATE] \| [END_REASON]` |
| `ASSOC:` | **Yes** | Link to associate. | `[ID] \| [ROLE] \| [START_DATE] \| [END_DATE] \| [DETAILS]` |
| **Assets/Meta** |  |  |  |
| `MEDIA:` | Yes | **Inline** Media file. | `[RELATIVE_PATH] \| [DATE] \| [CAPTION]` |
| `SRC:` | **Yes** | **Record-Level Source.** | `[^SRC-ID]` |
| `NOTES:` | Yes | **Record-Level Note.** | General narrative/biography. |
| `*_SRC:` | Yes | **Field-Level Citation.** | `[^SRC-ID] \| [Detail]` (See Sec 8.2) |
| `*_NOTE:` | Yes | **Field-Level Note.** | Research notes specific to the preceding field. |
| `_[TAG]:` | Yes | User-Defined Extension. | Custom tags must start with `_`. |

### **4.1 Place Hierarchy Format**

Places must be entered as strings using **semicolons** to denote hierarchy, ordered from the smallest unit to the largest unit.

#### **4.1.1 Historical Accuracy & Geocoding**

To preserve the historical name recorded in source documents while ensuring modern geocodability, use the **Curly Brace Equivalence `{=...}**` syntax.

* **Syntax:** `[Historical Name] {= [Modern Name]}`
* **Behavior:** Parsers must treat text *outside* the braces as the display value, and text *inside* the braces as the target for map lookups.
* **Placement:** The tag applies strictly to the specific hierarchy unit immediately preceding it.

#### **4.1.2 Coordinates**

Exact geographic coordinates may be appended to the end of the string using angle brackets `<Lat, Long>`.

#### **Examples**

| Type | Example Entry |
| --- | --- |
| **Standard** | `Calgary; Alberta; Canada <51.04, -114.07>` |
| **Renamed City** | `Berlin {=Kitchener}; Ontario; Canada` |
| **Border Change** | `Lwów {=Lviv}; Poland {=Ukraine}` |

### **4.2 Child Ordering & Lineage Logic**

To ensure data integrity and prevent graph corruption, FTT strictly separates the **definition** of a relationship from the **display order** of that relationship.

#### **4.2.1 Source of Truth: The PARENT Key**

* **Strict Lineage Definition:** The `PARENT` key located on a Child’s record is the **sole source of truth** for biological or legal lineage.
* **Parsing Rule:** A parent-child graph edge exists **if and only if** the Child record explicitly points to the Parent record via the `PARENT:` key.
* **Parsing Behavior:** Parsers must scan all records in the file to build the list of children for a given individual.

#### **4.2.2 Display Sequence (The CHILD Key)**

The `CHILD` key is an optional **Display Manifest**. It does not create relationships; it only dictates the visual order in which confirmed children should appear (e.g., ensuring the eldest is listed first).

* **Sorting Logic:**
1. **Manifest Match:** If a record listed in the `CHILD` manifest matches a record that *also* claims this individual as a `PARENT`, it is placed in the list at the explicit position defined.
2. **Append:** Any verified children discovered via scan (Section 4.2.1) that are *not* present in the `CHILD` manifest must be appended to the end of the list, sorted chronologically by birth date.

#### **4.2.3 The "Ghost Child" Rule (Strict Validation)**

A "Ghost Child" is an ID listed in a `CHILD` key that **does not** reciprocate the link (i.e., the target record exists but lacks the corresponding `PARENT` key pointing back).

* **Validation Failure:** Parsers **must raise a Validation Error** if a Ghost Child is detected.
* **Rationale:** This indicates data corruption or user error. Allowing "one-way" child links creates ambiguous ancestry that cannot be reliably traversed or exported to other formats.
* **Safe Harbor:** If the intention is to list a child for whom no record exists yet, the user must use a **Placeholder ID** (e.g., `CHILD: ?UNK-CHILD-1`). Placeholders are exempt from reciprocity checks.

### **4.3 Date Format Specification**

To accommodate historical uncertainty, all dates **must** conform to **ISO 8601-2:2019 Level 2** (specifically utilizing the Set/Interval extensions for bounding windows).

#### **4.3.1 EDTF Level 2 Features**

Parsers must support the standard extensions.

| Feature | Syntax | Meaning | Example |
| --- | --- | --- | --- |
| **Precision** | `YYYY` or `YYYY-MM` | Year or Month only. | `1904` (In 1904) |
| **Uncertainty** | `?` | Date is uncertain (possibly correct). | `1904?` (Maybe 1904) |
| **Approximate** | `~` | Date is approximate ("About"). | `1904~` (Circa 1904) |
| **Unspecified** | `X` | Digit is unknown/illegible. | `194X` (The 1940s) |
| **One of a Set** | `[..]` | **Bounding Window** (See 4.3.2). | `[1904..1908]` |
| **Open Interval** | `..` | **Ongoing / Open.** | `1990` to `..` |

#### **4.3.2 The "One of a Set" Rule (Bounding Window)**

FTT uses the standard EDTF Level 2 "One of a set" syntax to define a Bounding Window for a single point in time.

* **Syntax:** `[Earliest_Possible..Latest_Possible]`
* **Meaning:** The specific event occurred at a single, unknown instant located **somewhere between** these two bounds.
* **Differentiation:** Parsers must distinguish this from a duration. This syntax represents a **single date** that the researcher cannot pinpoint efficiently.
* **Example:** `[1904..1908]` means "This single event happened at an unknown time between 1904 and 1908."

#### **4.3.3 Defining Duration**

To define a span of time (Duration), records use distinct **Start Date** and **End Date** fields.

* **Logic:** Duration is the delta between the value in the Start Field and the value in the End Field.
* **Combined Logic (Uncertain Duration):**
* **Start Field:** `[1920..1922]` (Started at one specific moment between '20 and '22).
* **End Field:** `1930` (Ended exactly in 1930).

### **4.4 Name Syntax: Display & Indexing**

To ensure accurate sorting without cluttering the text with delimiters like slashes, the `NAME` key uses a **Display | Sort** logic.

* **Field 1 (Display):** The literal text to display on charts (e.g., "Dr. John Smith").
* **Field 2 (Index/Sort):** (Optional) The strictly formatted sorting key in **"Surname, Given"** format.

**Syntax:**
`NAME: [Display_String] | [Sort_Key] | [TYPE] | [STATUS]`

#### **4.4.1 Sort Key Logic (The Comma Rule)**

To define the Surname and Given Name explicitly, users **must** use the second pipe-delimited field with a **comma separator**.

* **Format:** `Surname, Given Names`
* **Behavior:**
* Text **before** the comma is indexed as the **Surname**.
* Text **after** the comma is indexed as the **Given Name**.
* This field is **never displayed**; it is used strictly for sorting and database indexing.

---

## **5. Source Record Reference**

Records starting with `^SRC` define a reusable bibliography entry.

| Key | Repeatable | Description | Example |
| --- | --- | --- | --- |
| `ID:` | **No** | Source Anchor. | `^SRC-CENSUS-1921` |
| `TITLE:` | No | Title of source. | 1921 Census of Canada |
| `AUTHOR:` | Yes | Author/Agency. | Library and Archives Canada |
| `URL:` | Yes | Direct link. | `https://...` |
| `NOTES:` | Yes | Transcript/Details. | Text |

---

## **6. Shared Event Reference (The &EVT Namespace)**

Records starting with `&EVT` define complex shared historical events to avoid duplication.

| Key | Repeatable | Description | Example |
| --- | --- | --- | --- |
| `ID:` | **No** | Event Anchor. | `&EVT-WWI` |
| `TYPE:` | No | Classification. | `War`, `Conference` |
| `START_DATE:` | **No** | **Start Date** (Point or Bound). | `1914-07-28` |
| `END_DATE:` | **No** | **End Date** (Point or Bound). | `1918-11-11` |
| `PLACE:` | No | Location. | `Europe` |
| `SRC:` | Yes | Event-Level Source. | `[^SRC-ID]` |

---

## **7. Pipe-Delimited Formats**

### **7.1 Event vs. Event Reference**

To avoid parsing ambiguity, events are split into two distinct keys with strict field positions.

* **Inline Definition (`EVENT:`):** Used for person-specific facts not covered by main keys (like `BORN` or `DIED`).
* **Structure:** `EVENT: [TYPE] | [START_DATE] | [END_DATE] | [PLACE] | [DETAILS]`

| Scenario | End Date Entry | Semantic Meaning | Example |
| --- | --- | --- | --- |
| **Point-in-Time** | **Empty** | The event happened at a single moment.  | `EVENT: Graduation \| 1980-05-12 \|\| Oxford; UK` |
| **Closed Duration** | **Date** `1990` | The event lasted from Start to End. | `EVENT: Residence \| 1920 \| 1925 \| Berlin; DE` |
| **Ongoing Duration** | **Double Dot** `..` | The event started and is currently ongoing (Open Interval). | `EVENT: Employment \| 1990 \| .. \| Calgary; AB` |

**Examples:**

```text
# Point-in-Time (Graduation)
# Event happened exactly on May 12, 1980.
EVENT: Graduation | 1980-05-12 || Oxford; UK | BA History

# Uncertain Point-in-Time (Naturalization)
# Event happened at one moment between 1905 and 1907.
# Uses EDTF "One of a set" syntax.
EVENT: Naturalization | [1905..1907] || New York; NY | Certificate #12345

# Closed Duration (Residence)
# Lived there from 1920 to 1925.
EVENT: Residence | 1920 | 1925 | Berlin; DE | Apartment 4B

# Ongoing Duration (Employment)
# Started in 1990, ongoing.
EVENT: Employment | 1990 | .. | Calgary; AB | Senior Engineer

```

### **7.2 Parent (With Standard Types)**

* **Key:** `PARENT:`
* **Format:** `[ID] | [TYPE] | [START_DATE] | [END_DATE]`
* **Required Vocabulary:** Types must match the **Relationship Vocabulary (Appendix A)**.
* **Example:** `PARENT: SMITH-1950 | BIO`

### **7.3 Union (Definition & Duration)**

Relationships are defined by a specific type, a start date, and optionally, an end date and termination reason.

* **Key:** `UNION:`
* **Format:** `[ID] | [TYPE] | [START_DATE] | [END_DATE] | [END_REASON]`

**Parsing Rules:**

* **[START_DATE]:** The date the relationship began. Use `[Start..End]` only for uncertainty (Bounding Window).
* **[END_DATE]:**
* **Empty (`||`):** Invalid for Unions (implies Point-in-Time). Unions are inherently durational. Use `..` or `?` instead.
* **Double Dot (`..`):** Relationship is **Ongoing** (e.g., current marriage).
* **Question Mark (`?`):** Relationship has ended, but date is **Unknown**.
* **Date:** Relationship ended at this specific point (or Bounding Window).

**Examples:**

```text
# Ongoing Marriage
UNION: SMITH-02 | MARR | 1990 | .. |

# Divorced, date unknown
UNION: JONES-55 | MARR | 1985 | ? | DIV

# Marriage Date Uncertain (Window), Ended 1950
UNION: DOE-99 | MARR | [1940..1942] | 1950 | WID

```

### **7.4 Media**

* **Key:** `MEDIA:`
* **Format:** `[RELATIVE_PATH] | [DATE] | [CAPTION]`
* **Path Specification:**
* **Separator:** All paths **must** use the forward slash `/` as the directory separator, regardless of the operating system (e.g., Windows). Parsers on systems requiring backslashes must normalize the path internally for file access but preserve the forward slash for data portability.
* **Relative Origin:** Paths are relative to the directory containing the `.ftt` file.
* **Forbidden Syntax:** Absolute paths (e.g., `C:\Users\...` or `/home/...`) and UNC paths (e.g., `\\Server\...`) are **forbidden**. Paths must not begin with a slash.


* **Example:** `MEDIA: photos/1990/family_pic.jpg | 1990-12-25 | Christmas Morning`

### **7.5 Associates (`ASSOC:`)**

The `ASSOC` key defines non-familial or extended relationships.

* **Key:** `ASSOC:`
* **Format:** `[ID] | [ROLE] | [START_DATE] | [END_DATE] | [DETAILS]`

**Parsing Rules:**

* **[END_DATE]:**
* **Empty (`||`):** **Point-in-Time Association.** (e.g., Witnessing a document).
* **Double Dot (`..`):** **Ongoing Association.**
* **Date:** **Duration Association** (e.g., Apprenticeship).



**Examples:**

```text
# Point-in-Time (Witness at a wedding)
ASSOC: SMITH-05 | WITN | 1920-06-01 || Wedding of Sister

# Duration (Apprenticeship - Closed)
ASSOC: MILLER-99 | APPR | 1900 | 1907 | Blacksmithing

# Ongoing (Godparent)
ASSOC: DOE-01 | GODP | 2010 | .. |

```

---

## **8. Implementation Guidance**

### **8.1 Parser Logic: Order of Operations**

To correctly handle keys, multi-line content, and inline delimiters, parsers must follow this check for every line:

1. **Block Termination Check:**
* Does the line start with `---`? **Terminate current block, then Skip.**
* Does the line start with a Key (e.g., `NAME:`, `_TAG:`) at Column 0? **Terminate current block, Start new Field.**
* Does the line start with `#`? **Skip (Comment).**

2. **Blank Line Check (Paragraph logic):**
* Is the line empty or does it contain *only* whitespace?
* **If YES:**
* If a field buffer is currently open: Inject a **New Paragraph Marker** (e.g., `\n` or `\n\n` depending on internal representation) into the buffer.
* *Note:* Do not close the buffer. The block is still active.

3. **Indentation Check (Continuation):**
* Does the line begin with **2 spaces**?
* **If YES (Continuation):**
* Strip the leading 2 spaces.
* *Space Folding Rule:* Check the last character in the current buffer. If it is not a newline marker, append a single **Space character**.
* Append the remaining line content.

4. **Fall-through (Safety):**
* If a line contains non-whitespace text at Column 0 but was not recognized as a Key in Step 1, raise a **Syntax Error** (Invalid Indentation or Unknown Key).

#### **Example Parsing Result**

**Input:**

```text
NOTES: First sentence of the intro.
  Second sentence of the intro.

  Start of the second paragraph.

```

**Parser Buffer:**
`"First sentence of the intro. Second sentence of the intro.\nStart of the second paragraph."`

### **8.2 Field Attributes & Modifiers (Scoping Logic)**

To ensure consistent data interpretation and prevent "floating" metadata, attributes such as citations and technical notes are attached to data fields based on **Strict Adjacency Logic**.

#### **8.2.1 Record-Level Attributes (`SRC:` & `NOTES:`)**

* **Scope:** Applies to the **entire record** currently being parsed.
* **Placement:** May appear anywhere within the record block.
* **Behavior:**
* `SRC:` entries are aggregated into the record's global bibliography list.
* `NOTES:` entries are concatenated into the main biographical narrative.



#### **8.2.2 Field-Level Modifiers (`*_SRC` & `*_NOTE`)**

Specific fields (e.g., `BORN`, `NAME`, `OCC`) may be modified by Citation keys and Note keys. These are collectively known as **Modifiers**.

* **Naming Convention:**
* **Citation:** The key must match the target key + `_SRC` (e.g., `BORN` → `BORN_SRC`).
* **Note:** The key must match the target key + `_NOTE` (e.g., `BORN` → `BORN_NOTE`).


* **Repeatability (Stacking):**
* Modifiers are **Repeatable**. Users may attach multiple sources or multiple notes to a single field instance.
* **Aggregation Rule:** Parsers must collect *all* valid modifiers found in the block and attach them as a list to the target field. Valid modifiers are not mutually exclusive; they accumulate.


* **The Modifier Block Rule:**
A field and its modifiers form a single logical unit. A Modifier Key is valid **if and only if** it appears in the contiguous block of lines immediately following the target field.
1. **Chaining:** Multiple modifiers (sources and notes) may be mixed and chained in any order immediately after the target field.
2. **Ignored Elements:** Parsers must ignore **Comments** (`#`) and **Whitespace** (blank lines) when checking for adjacency.
3. **Termination:** The Modifier Block is **terminated** immediately upon encountering a new Data Key (e.g., encountering `DIED:` closes the `BORN` block).



#### **8.2.3 Parsing Example (Stacked Modifiers)**

**Valid Structure (Multiple Sources):**
In this example, the birth event is supported by two distinct citations and has a specific note attached.

```text
BORN: 1980-05-12 | Calgary; AB
BORN_SRC: ^SRC-BIRTH-CERT | Certificate #12345
BORN_SRC: ^SRC-FAMILY-BIBLE | Page 42, Row 3
BORN_NOTE: Date calculated from age at death in bible record.

DIED: ...

```

**Valid Structure (Repeated Fields with Unique Modifiers):**
Because adjacency is strict, modifiers automatically attach only to the specific instance of a repeatable field directly above them.

```text
EVENT: OCC | 1920 || Carpenter
EVENT_SRC: ^SRC-CENSUS-1920
EVENT_NOTE: Listed as "Apprentice"

```

#### **8.2.4 Validation Errors**

Parsers **must** raise a **Validation Error** if:

1. A Modifier Key is encountered without a matching predecessor Key.
2. A Modifier Key matches the predecessor structurally but has the wrong prefix (e.g., `DIED_SRC` appearing immediately after `BORN:`).

#### **8.2.5 Duplicate ID Handling (Collision Policy)**

To maintain data integrity and prevent the accidental overwriting of genealogical data, parsers must implement a "First-Win" collision policy.

1. **Detection:** When a parser encounters an `ID:` key, it must check if that ID has already been indexed in the current session.
2. **Error Reporting:** If the ID already exists, the parser **must raise a Validation Error** indicating the line number of the duplicate attempt.
3. **Preservation:** The parser must ignore the second (duplicate) record block entirely to preserve the data of the original record.
4. **Block Recovery:** To prevent subsequent fields (like `NAME:` or `BORN:`) from being incorrectly attached to the previous valid record or the global header, the parser should enter an "error state" for that block until a new valid `ID:` or block terminator (`---`) is encountered.

### **8.3 Graph Integrity: Relationship Resolution**

#### **8.3.1 Asymmetric Lineage Resolution**

* **Unidirectional Authority:** Parent-Child relationships are defined unidirectionally by the child.
* `PARENT: [ID]`  **Creates Edge** (Child is linked to Parent).
* `CHILD: [ID]`  **No Edge Created**. It acts solely as a sorting weight.

* **Validation Logic (The Integrity Check):**
During the parsing phase, the parser must verify that every ID listed in a `CHILD` block effectively "votes back" for the parent.
1. **Iterate** through every ID in `Record A`'s `CHILD` list.
2. **Check** `Record B` (the child). Does `Record B` contain `PARENT: Record A`?
3. **Result:**
* **Yes:** Valid. Add to ordered list.
* **No:** **Critical Error.** `Record A` claims `Record B` is a child, but `Record B` denies it. The parser must halt or flag the file as corrupt.

#### **8.3.2 Symmetric Relationships (Union)**

* **Principle of Inference:** Symmetric relationships (specifically `UNION`) need only be defined on **one** of the participating records.
* **Runtime Logic:**
1. If Record A contains `UNION: Record B`, the parser **must** automatically inject Record A as a union of Record B in the runtime memory model.
2. It is **valid** for a file to contain the link on only one record (One-way definition).
3. It is **valid** for a file to contain the link on both records (Explicit Bidirectionality).

* **Conflict Resolution:** If both records explicitly define the relationship but contain conflicting metadata (e.g., Record A claims the marriage was `1900`, but Record B claims `1901`), the parser **should** raise a **Consistency Warning**.

#### **8.3.3 Cycle Detection (Validation)**

To ensure the graph remains a Directed Acyclic Graph (DAG) with respect to lineage, parsers **must** validate against circular ancestry during import.

* **The Ancestry Rule:** An individual cannot be their own ancestor.
* **Validation Logic:** When parsing `PARENT` keys, the parser must trace the lineage upward. If `Record A` claims `Record B` is a parent, but `Record B` is already an existing descendant of `Record A`, the parser must:
1. **Reject** the specific `PARENT` link causing the loop.
2. **Report** a critical "Circular Lineage Error" referencing the involved IDs.

#### **8.3.4 Dangling Reference Policy (Strict Validity)**

To prevent data corruption, parsers **must** validate every linked ID against the file's index.

1. **Target Exists:** The link is valid. Proceed.
2. **Target Missing (Standard, Source `^`, or Event `&`):**
* If a link points to a Standard ID (e.g., `SMITH-1`), a Source (e.g., `^SRC-1`), or an Event (e.g., `&EVT-1`) that is not defined in the file, the parser **must raise a Critical Validation Error**.
* *Rule:* You cannot cite a source or link to an event that does not exist.

3. **Target Missing (Placeholder `?`):**
* If a link points to a valid Placeholder ID (e.g., `?UNK-FATHER`), the parser **must allow** the link even if no record definition exists.
* *Runtime Behavior:* Treat as a valid edge to a "Null/Unknown" node.

---

## **Appendix A: Standard Relationship Vocabulary**

To ensure interoperability, the `[TYPE]` field in `PARENT` keys and the `[TYPE]` / `[END_REASON]` fields in `UNION` keys must use the following standard codes.

### **A.1 Parent / Child Types**

| Type | Meaning | Description |
| --- | --- | --- |
| `BIO` | **Biological** | Genetic parent-child relationship. |
| `ADO` | **Adopted** | Legal adoption. |
| `STE` | **Step** | Parent is the spouse of a biological parent. |
| `FOS` | **Foster** | Temporary legal guardianship. |
| `UNK` | **Unknown** | Nature of the relationship is unspecified. |

### **A.2 Union Types ([TYPE])**

These codes define the **nature** of the union.

| Type | Meaning | Description |
| --- | --- | --- |
| `MARR` | **Married** | Legal marriage. |
| `PART` | **Partner** | Unmarried romantic partner, common law, or domestic partnership. |
| `UNK` | **Unknown** | Relationship nature is unspecified. |

### **A.3 Relationship Termination Codes ([END_REASON])**

These codes define **why** a union ended.

| Type | Meaning | Description |
| --- | --- | --- |
| `DIV` | **Divorced** | Marriage ended by legal decree. |
| `SEP` | **Separated** | Couple is living apart; legal bond may still exist. |
| `WID` | **Widowed** | Relationship ended due to the death of the partner. |
| `ANN` | **Annulled** | Legal declaration that the marriage never existed. |

---

### **Appendix B: Standard Name Vocabulary**

To ensure consistent sorting and filtering of names, the `[Type]` and `[Status]` fields in the `NAME:` key must use the following standard codes.

### **B.1 Name Type Codes ([TYPE])**

| Type | Meaning | Description |
| --- | --- | --- |
| `BIRTH` | **Birth Name** | The name given to the individual at birth (Maiden Name). |
| `MARR` | **Married Name** | A name assumed upon marriage. |
| `AKA` | **Also Known As** | An alias or alternate spelling found in records. |
| `NICK` | **Nickname** | A diminutive or familiar name (e.g., "Bob" for Robert). |
| `PROF` | **Professional** | A stage name, pen name, or professional title. |
| `REL` | **Religious** | A name taken for religious reasons (e.g., confirmation, monastic). |
| `UNK` | **Unknown** | The type of name is unspecified (Default). |

**Parser Rule:** If a parser encounters a `[Type]` that is not in this list, it **must** treat the value as a custom user-defined string (e.g., "Tribal Name").

### **B.2 Name Status Codes ([STATUS])**

This optional third field defines how the name is treated by the application.

| Type | Meaning | Description |
| --- | --- | --- |
| `PREF` | **Preferred** | This name should be used as the primary label in visual charts. |
| *Empty* | **Standard** | No special status (Default). |

---

## **Appendix C: Standard Event Vocabulary**

The `[TYPE]` field in `EVENT:` (Inline) and the `&EVT` (Shared) records should prioritize these standard codes to facilitate data exchange.

### **C.1 Rites & Religious Events**

| Type | Meaning | Description |
| --- | --- | --- |
| `BAP` | **Baptism** | Water baptism (typically adult or child). |
| `CONF` | **Confirmation** | Religious confirmation of faith. |
| `BUR` | **Burial** | Physical interment of remains. |
| `CREM` | **Cremation** | Cremation of remains. |

### **C.2 Legal & Civic**

| Type | Meaning | Description |
| --- | --- | --- |
| `CENS` | **Census** | Appearance in a census record. |
| `PROB` | **Probate** | Legal distribution of estate after death. |
| `WILL` | **Will** | The execution or filing of a Last Will. |
| `NAT` | **Naturalization** | Obtaining citizenship in a new country. |
| `IMM` | **Immigration** | Entering a new country to reside. |
| `EMIG` | **Emigration** | Leaving a country of residence. |

### **C.3 Personal History**

| Type | Meaning | Description |
| --- | --- | --- |
| `EDUC` | **Education** | Graduation, degree, or school attendance. |
| `OCC` | **Occupation** | A specific career event (e.g., "Apprenticeship"). |
| `MIL` | **Military** | Enlistment, discharge, or service record. |
| `RET` | **Retirement** | Concluding a working career. |
| `ANEC` | **Anecdote** | A generic story or interesting fact not covered by other types. |

**Implementation Note:**
Vital events (`BORN`, `DIED`) and relationship events (`MARR`, `DIV`) are handled by their specific keys (`BORN:`, `DIED:`, `UNION:`) and should **not** be duplicated as generic `EVENT:` entries unless documenting a specific sub-event (e.g., `EVENT: Funeral` separate from `DIED`).

---

### **Appendix D: Privacy Levels**

The `PRIVACY:` key dictates how parsers and exporters must handle the record during serialization (e.g., exporting to the web or sharing files).

| Type | Meaning | Export Behavior |
| --- | --- | --- |
| `OPEN` | **Public** | **Default.** All data is exported and visible. |
| `LIVING` | **Living** | Treat as a living person. **Mask** all birth/marriage dates and places. **Show** only the Preferred Name and kinship links. |
| `PRIVATE` | **Restricted** | **Exclude** the entire record from public exports, or render strictly as "Private Record" with no identifiable data. |

---

### **Appendix E: Associate Role Vocabulary**

Parsers should recognize these standard codes to enable interoperability (e.g., translation or iconography). If a relationship does not fit these codes, the user may enter any **Custom String**.

#### **E.1 Religious & Rites**

| Code | Label | Description |
| --- | --- | --- |
| `GODP` | **Godparent** | Godparent or Sponsor at baptism. |
| `GODC` | **Godchild** | The recipient of the godparenting. |
| `SPON` | **Sponsor** | Confirmation sponsor or other religious guarantor. |
| `OFFI` | **Officiant** | Clergy or official who performed a rite for the subject. |

#### **E.2 Legal & Civil**

| Code | Label | Description |
| --- | --- | --- |
| `WITN` | **Witness** | Witness to a legal event (marriage, will, deed). |
| `EXEC` | **Executor** | Executor of the subject's estate/will. |
| `GUAR` | **Guardian** | Legal guardian (non-parental). |
| `WARD` | **Ward** | Subject was a ward of the target ID. |
| `INFO` | **Informant** | The person who provided info on a Death Certificate. |

#### **E.3 Professional & Social**

| Code | Label | Description |
| --- | --- | --- |
| `MAST` | **Master** | The master in an indentured/apprentice bond. |
| `APPR` | **Apprentice** | The apprentice in the bond. |
| `SERV` | **Servant** | Domestic or civil servant. |
| `NEIG` | **Neighbor** | Individual enumerated adjacently in a census/record. |
| `ENSL` | **Enslaved By** | The subject was enslaved by the target ID. |
| `OWNR` | **Enslaver** | The subject held the target ID in slavery. |
