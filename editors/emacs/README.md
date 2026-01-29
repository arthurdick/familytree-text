# FTT-Mode for Emacs

`ftt-mode` is a major mode for Emacs designed for the efficient editing of **FamilyTree-Text (FTT)** files. Derived from `text-mode`, it provides a lightweight, high-performance environment suitable for both GUI Emacs and terminal-based `emacs-nox` sessions.

## Features

- **Syntax Highlighting:** Distinctive coloring for IDs, Headers, Keys, Pipe delimiters (`|`), and geographic metadata.
- **Relational Navigation (`M-.`):** Jump instantly from a relationship link (e.g., `PARENT: SMITH-01`) to that record's definition.
- **Categorized Imenu (`M-g i`):** A hierarchical index that organizes your file into **Individuals**, **Sources**, and **Events**.
- **Intelligent Indentation:** Strictly enforces the FTT v0.1 column standard while ensuring `RET` always returns to a new tag position.
- **Boilerplate Skeletons:** Rapidly generate records for people, shared events, and bibliographic sources.

---

## Installation

### 1. Place the file

Download `ftt-mode.el` and place it in a directory that is in your Emacs `load-path`.

### 2. Configure Emacs

Add the following to your `init.el` or `.emacs` file:

```elisp
(require 'ftt-mode)

```

_Note: If you use a custom directory for manual scripts (e.g., `~/.emacs.d/lisp/`), ensure it is added to your path first:_

```elisp
(add-to-list 'load-path "~/.emacs.d/lisp/")
(require 'ftt-mode)

```

### 3. (Optional) Modern Setup with `use-package`

If you prefer `use-package` for lazy loading:

```elisp
(use-package ftt-mode
  :mode "\\.ftt\\'"
  :ensure nil)

```

---

## Keybindings

### Navigation & Graph Traversal

| Key       | Action                                         |
| --------- | ---------------------------------------------- |
| `C-c C-n` | Jump to **next** record (`ID:`)                |
| `C-c C-p` | Jump to **previous** record (`ID:`)            |
| `C-c C-f` | Jump to **next section** (`---`)               |
| `M-.`     | **Go to Definition** (Jump to ID under cursor) |
| `M-,`     | Pop back to previous location                  |
| `M-g i`   | Open **Categorized Index** (Imenu)             |

### Editing & Templates

| Key       | Action                                       |
| --------- | -------------------------------------------- |
| `RET`     | Newline (Always returns to Column 0)         |
| `TAB`     | Cycle indentation (**0** **2** spaces)       |
| `C-c C-i` | Insert **Individual** template               |
| `C-c C-s` | Insert **Source** template (`^SRC`)          |
| `C-c C-e` | Insert **Shared Event** template (`&EVT`)    |
| `C-c C-l` | Insert **Inline Life Event** line (`EVENT:`) |
| `C-c C-d` | Insert **Current Date** (ISO 8601 format)    |
| `C-c TAB` | Complete FTT Keyword                         |

---

## Usage Tips for Terminal (`emacs-nox`) Users

### Minibuffer Navigation

The Imenu command (`M-g i`) allows you to jump to any record in your tree. In a terminal, it will prompt you for a category first (**Individuals**, **Sources**, or **Events**). After selecting a category, hit `RET` to search for the specific ID.

### Keyword Completion

If `M-TAB` is captured by your Window Manager, `ftt-mode` provides **`C-c TAB`** as a dedicated alternative for autocompleting keys like `BORN:`, `PARENT:`, or `UNION:`. You can also use the standard Emacs terminal fallback: **`C-M-i`** (or `ESC` followed by `TAB`).

### Outline Folding

`ftt-mode` integrates with `outline-minor-mode`. To collapse your family tree so only the `ID:` lines are visible:

1. Run `M-x outline-minor-mode`.
2. Use `C-c @ C-t` to hide all record bodies.
3. Use `C-c @ C-a` to show everything again.
