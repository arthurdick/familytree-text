# FamilyTree-Text (FTT)

**Status:** Draft / Experimental (v0.1)  

**Core Principle:** Data durability through human-readable, machine-parseable UTF-8 plain text.

[**🌐 Live Visualizer / Editor**](https://arthurdick.github.io/familytree-text/)

---

## 📖 What is FTT?

**FamilyTree-Text (FTT)** is a proposed standard for storing genealogical data. Unlike GEDCOM (which can be verbose and archaic) or database blobs (which are opaque), FTT is designed to be written and read like a simple text document.

It prioritizes:
1.  **Human Readability:** You can open an `.ftt` file in Notepad and understand it without software.
2.  **Git Friendliness:** The line-based structure allows for clean "diffs," making it perfect for version-controlling family history.
3.  **Data Durability:** No binary encoding or complex XML schemas. Just UTF-8 text.

## ⚡ Quick Example

```text
ID: SMITH-01
NAME: John Smith | Smith, John
BORN: 1980-05-12 | Calgary; AB
PARENT: SMITH-DAD | BIO ||
UNION: DOE-01 | MARR | 2005-06-01 ||

ID: DOE-01
NAME: Jane Doe
BORN: 1982-08-15 | Toronto; ON

```

## 🚀 Usage

### using the Visualizer

This repository is hosted via GitHub Pages. You can access the reference implementation visualizer here:
**[Launch FTT Visualizer](https://arthurdick.github.io/familytree-text/)**

### Using the Parser (JavaScript)

The reference parser (`js/FTTParser.js`) is a dependency-free ES6 class.

```javascript
const parser = new FTTParser();
const fttData = `
ID: ME-01
NAME: My Name
`;

const result = parser.parse(fttData);
console.log(result.records);

```

## 📂 Project Structure

* **`spec/`**: Contains the formal **FamilyTree-Text Specification v0.1**.
* **`js/`**: Contains the reference `FTTParser` class.
* **`index.html`**: The web-based graph visualizer and editor (uses Cytoscape.js).
* **`examples/`**: Sample `.ftt` files for testing.

## 🛠 specification Highlights

* **Strict Indentation:** 2-space indentation defines block scope.
* **Pipe Delimiters:** Fields are separated by `|`.
* **Semantic IDs:** IDs like `^SRC` (Source) and `&EVT` (Event) act as namespaces.
* **ISO 8601 Dates:** Partial support for EDTF Level 2 (e.g., `1904?`, `[1900..1910]`).

## 🤝 Contributing

This is an open draft. We welcome:

* Pull Requests for the Specification.
* Improvements to the JS Parser.
* New renderers (Python, Rust, etc.).

## 📄 License

This project is licensed under the **MIT License**.
