# FamilyTree-Text (FTT)

**Status:** Draft / Experimental (v0.1)  

**Core Principle:** Data durability through human-readable, machine-parseable UTF-8 plain text.

[**🌐 Live Visualizer / Editor**](https://arthurdick.github.io/familytree-text/tools/visualizer.html)

---

## 📖 What is FTT?

**FamilyTree-Text (FTT)** is a proposed standard for storing genealogical data. Unlike GEDCOM (which can be verbose and archaic) or database blobs (which are opaque), FTT is designed to be written and read like a simple text document.

It prioritizes:
1.  **Human Readability:** You can open an `.ftt` file in Notepad and understand it without software.
2.  **Git Friendliness:** The line-based structure allows for clean "diffs," making it perfect for version-controlling family history.
3.  **Data Durability:** No binary encoding or complex XML schemas. Just UTF-8 text.

## ⚡ Quick Example

```text
HEAD_FORMAT: FTT v0.1

ID: SMITH-1950-A
NAME: Arthur Smith | Smith, Arthur | BIRTH | PREF
SEX: M
BORN: 1950-01-01 | Calgary; AB
UNION: DOE-1952-S | MARR | 1975-06-01 | .. |
CHILD: SMITH-1980-J

ID: DOE-1952-S
NAME: Sarah Doe | Doe, Sarah | BIRTH
NAME: Sarah Smith | Smith, Sarah | MARR | PREF
SEX: F
BORN: 1952-08-15 | Toronto; ON
UNION: SMITH-1950-A | MARR | 1975-06-01 | .. |
CHILD: SMITH-1980-J

ID: SMITH-1980-J
NAME: John Smith | Smith, John | BIRTH | PREF
SEX: M
BORN: 1980-05-12 | Vancouver; BC
PARENT: SMITH-1950-A | BIO
PARENT: DOE-1952-S | BIO
```

## 🚀 Usage

### Using the Visualizer

This repository is hosted via GitHub Pages. You can access the reference implementation visualizer here:
**[Launch FTT Visualizer](https://arthurdick.github.io/familytree-text/tools/visualizer.html)**

### Using the Parser (JavaScript)

The reference parser (`js/FTTParser.js`) is a dependency-free ES6 class.

```javascript
const parser = new FTTParser();
const fttData = `
HEAD_FORMAT: FTT v0.1
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

### 🛠 Development Setup

The JavaScript reference implementation uses **Node.js** and **Vite** to bundle dependencies.

1. **Install Dependencies:**
```bash
npm install
```

2. **Start the Local Server:**
Run the development server with hot-reloading:
```bash
npm run dev
```

3. **Build for Production:**
To generate the static `dist/` folder (used for GitHub Pages):
```bash
npm run build
```

## 📄 License

This project is licensed under the **MIT License**.
