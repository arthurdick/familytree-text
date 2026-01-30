# **FTT v0.1 Quick Reference Guide**

**Core Syntax:** UTF-8 Plain Text | Indentation (2 spaces) | Pipe (`|`) Separators.

## **1. File Structure & Header**

Every file must start with Global Metadata before the first ID.

**Syntax Rules:**

- **Comments:** `# This is a comment` (Ignored).
- **Separators:** `ID:` starts a new record. `---` acts as an **optional** visual separator to improve readability.
- **Indentation:** Multiline values must be indented by **2 spaces**.

```text
HEAD_FORMAT:    FTT v0.1
HEAD_TITLE:     My Family History
HEAD_ROOT:      SMITH-01
HEAD_AUTHOR:    Jane Doe
HEAD_DATE:      2026-01-20
---

```

---

## **2. ID System & Sigils**

IDs are **Case-Sensitive**.

- **ID Persistence:** Once an ID is used in a published tree, **it should never change**.
- **Forbidden:** Spaces, tabs, pipes (`|`), semicolons (`;`), and control characters.
- **Standard IDs:** Must start with alphanumeric; letters, numbers, hyphens (`-`), underscores (`_`), and periods (`.`) allowed.
- **Recommendation:** Use `[SURNAME]-[YYYY]-[INITIALS]` (e.g., `SMITH-1980-JS`).

| Type        | Sigil    | Prefix Example | Usage                                         |
| ----------- | -------- | -------------- | --------------------------------------------- |
| **Person**  | _(None)_ | `SMITH-1980`   | Standard individual record.                   |
| **Source**  | `^`      | `^SRC-CENSUS`  | Bibliographic citation.                       |
| **Event**   | `&`      | `&EVT-WWII`    | Shared historical event.                      |
| **Unknown** | `?`      | `?UNK-FATHER`  | Placeholder (Exempt from reciprocity checks). |

---

## **3. Individual Record Basics**

**Note:** Use double pipes `||` to skip empty fields in the sequence.

| Key          | Syntax / Format                                 |
| ------------ | ----------------------------------------------- |
| **ID:**      | `[Unique_ID]`                                   |
| **NAME:**    | `[Display] \| [Sort_Key] \| [TYPE] \| [STATUS]` |
| **SEX:**     | `M`, `F`, `U` (Unknown), `O` (Other)            |
| **BORN:**    | `[Date] \| [Place] \| [STATUS]`                 |
| **DIED:**    | `[Date] \| [Place] \| [STATUS]`                 |
| **PRIVACY:** | `OPEN` (Default), `LIVING`, `PRIVATE`           |

**Example:**

```text
ID: SMITH-01
NAME: Dr. John Smith | Smith, John | BIRTH | PREF
SEX:  M
BORN: 1980-05-12 | Calgary; Alberta; Canada | PREF
DIED: 2020-01-01

```

---

## **4. Relationships**

### **Parent / Child**

- **PARENT:** The **Source of Truth**. Defines the link _to_ the ancestor.
- **CHILD:** Display order only. _Must_ contain a `PARENT` link pointing back (No "Ghost Children").

```text
PARENT: [ID] | [TYPE] | [START] | [END]
CHILD:  [ID]

```

### **Unions (Spouses)**

Defines marriage or partnership. Can be defined on one or both records.

```text
UNION: [ID] | [TYPE] | [START] | [END] | [END_REASON]

```

- _Ongoing Union:_ Use `..` in the End Date field.
- _Uncertain End:_ Use `?` in the End Date field.

### **Associates**

Non-familial links (Godparents, Witnesses, Neighbors).

```text
ASSOC: [ID] | [ROLE] | [START] | [END] | [DETAILS]

```

---

## **5. Dates (ISO 8601-2 / EDTF)**

FTT uses specific syntax to handle historical uncertainty.

| Concept       | Syntax         | Meaning                                                       |
| ------------- | -------------- | ------------------------------------------------------------- |
| **Exact**     | `1904-05-12`   | Specific date.                                                |
| **Approx**    | `1904~`        | About/Circa 1904.                                             |
| **Uncertain** | `1904?`        | Maybe 1904 (Questionable).                                    |
| **Bounds**    | `[1904..1908]` | **One single event** happened _sometime_ between these dates. |

---

## **6. Places & Coordinates**

Use semicolons `;` for hierarchy ordered from the smallest unit to the largest.

- **Standardizing (Bottom-Up):** Always start with the most specific location and move to the most general.
- _Example:_ `Specific Site; City; County; State; Country`.

- **Historical/Renamed:** `Berlin {=Kitchener}; Ontario; Canada`.
- _Logic:_ Use the jurisdiction name as it existed at the time of the event. Text inside `{}` is for modern geocoding; text outside is for display.

- **Coordinates:** `City; Country <51.04, -114.07>`.

---

## **7. Sources & Modifiers**

Citations and Notes are attached to specific fields by **strict adjacency**.

### **Defining a Source**

```text
ID:     ^SRC-CENSUS-21
TITLE:  1921 Census of Canada
REPO:   Library and Archives Canada
URL:    https://...
```

### **Citing a Source (Inline)**

Place `*_SRC` or `*_NOTE` lines **immediately** after the field they modify.

```text
BORN: 1980-05-12 | Calgary; AB
BORN_SRC: ^SRC-BIRTH-CERT | Certificate #12345
BORN_NOTE: Date is calculated from age listed in certificate.

```

---

## **Appendix: Standard Codes**

### **Relationship Types**

- **Parent:** `BIO` (Biological), `ADO` (Adopted), `STE` (Step), `FOS` (Foster).
- **Union:** `MARR` (Married), `PART` (Partner/Common Law).
- **Union End:** `DIV` (Divorced), `SEP` (Separated), `WID` (Widowed), `ANN` (Annulled).

### **Vital & Name Status**

- **Status:** `PREF` (Preferred/Primary fact), `QUES` (Questionable/Disproven).

### **Name Types**

`BIRTH` (Maiden), `MARR` (Married), `ADO` (Adopted), `IMM` (Immigrant), `TRAN` (Transliterated), `AKA` (Alias), `NICK` (Nickname), `PROF` (Professional), `REL` (Religious).

### **Associate Roles**

- **Religious:** `GODP` (Godparent), `OFFI` (Officiant).
- **Legal:** `WITN` (Witness), `EXEC` (Executor), `GUAR` (Guardian).
- **Social:** `NEIG` (Neighbor), `MAST` (Master), `APPR` (Apprentice).

### **Event Types**

`BAP` (Baptism), `BUR` (Burial), `CENS` (Census), `WILL` (Will), `IMM` (Immigration), `EDUC` (Education), `OCC` (Occupation).
