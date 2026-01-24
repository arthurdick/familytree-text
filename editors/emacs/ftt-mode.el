;;; ftt-mode.el --- Major mode for FamilyTree-Text (FTT) files -*- lexical-binding: t; -*-

;; Author: Arthur Dick (Ref: FTT v0.1 Spec)
;; Version: 0.1
;; Keywords: genealogy, data, text
;; URL: https://github.com/arthurdick/familytree-text

;;; Commentary:

;; This mode provides syntax highlighting, indentation, navigation,
;; and templates for the FamilyTree-Text (FTT) format.
;;
;; Keybindings:
;;   RET      : Newline (Always Column 0)
;;   TAB      : Cycle Indentation (0 <-> 2 spaces)
;;
;;   C-c C-n  : Jump to next record (ID:)
;;   C-c C-p  : Jump to previous record (ID:)
;;   C-c C-f  : Jump to next section (---)
;;
;;   M-.      : Go to Definition (Jump to ID under cursor)
;;   M-,      : Pop back
;;   M-g i    : Imenu (Categorized by Type)
;;
;;   C-c C-i  : Insert Individual Skeleton
;;   C-c C-s  : Insert Source Skeleton
;;   C-c C-e  : Insert Shared Event Skeleton (&EVT)
;;   C-c C-l  : Insert Inline Life Event (EVENT:)
;;   C-c C-d  : Insert Current Date (ISO 8601)
;;   C-c TAB  : Complete Keyword

;;; Code:

(require 'xref)

(defgroup ftt nil
  "Major mode for editing FamilyTree-Text files."
  :group 'data)

(defcustom ftt-indent-offset 2
  "Indentation spaces for FTT continuation lines."
  :type 'integer
  :group 'ftt)

;;; Faces

(defface ftt-header-face
  '((t :inherit font-lock-preprocessor-face :weight bold))
  "Face for global headers (HEAD_TITLE, etc)."
  :group 'ftt)

(defface ftt-id-tag-face
  '((t :inherit font-lock-keyword-face :weight bold))
  "Face for the 'ID:' keyword."
  :group 'ftt)

(defface ftt-id-value-face
  '((t :inherit font-lock-function-name-face :weight bold))
  "Face for the actual ID value."
  :group 'ftt)

(defface ftt-key-face
  '((t :inherit font-lock-variable-name-face))
  "Face for standard keys (NAME:, BORN:, etc)."
  :group 'ftt)

(defface ftt-separator-face
  '((t :inherit shadow))
  "Face for the pipe separator |."
  :group 'ftt)

(defface ftt-block-break-face
  '((t :inherit font-lock-comment-face :strike-through t))
  "Face for the --- block separator."
  :group 'ftt)

(defface ftt-special-ref-face
  '((t :inherit font-lock-constant-face))
  "Face for special IDs (Sources ^SRC, Events &EVT)."
  :group 'ftt)

;;; Syntax Table

(defvar ftt-mode-syntax-table
  (let ((st (make-syntax-table)))
    ;; Comments start with #
    (modify-syntax-entry ?# "<" st)
    (modify-syntax-entry ?\n ">" st)
    ;; IDs use hyphens, so treat them as word parts
    (modify-syntax-entry ?- "w" st)
    ;; Underscores in HEAD_TITLE
    (modify-syntax-entry ?_ "w" st)
    ;; Pipes are punctuation
    (modify-syntax-entry ?| "." st)
    st)
  "Syntax table for ftt-mode.")

;;; Font Lock

(defconst ftt-font-lock-keywords
  (list
   ;; 1. Block Separator (---)
   '("^---.*$" . 'ftt-block-break-face)

   ;; 2. Global Headers
   '("^HEAD_[A-Z0-9_]+:" . 'ftt-header-face)

   ;; 3. Record ID Definition
   '("^\\(ID:\\)\\s-*\\([^ \t\n]+\\)"
     (1 'ftt-id-tag-face)
     (2 'ftt-id-value-face))

   ;; 4. Modifiers (*_SRC, *_NOTE)
   '("^[A-Z0-9_]+_\\(SRC\\|NOTE\\):" . font-lock-doc-face)

   ;; 5. Standard Keys
   '("^[A-Z0-9_]+:" . 'ftt-key-face)

   ;; 6. Pipe Separators
   '("|" . 'ftt-separator-face)

   ;; 7. Special References (^SRC, &EVT, ?UNK)
   '("\\(\\^SRC\\|&EVT\\|\\?UNK\\)-[A-Z0-9-]+" . 'ftt-special-ref-face)
   
   ;; 8. Place Hierarchies {=Modern}
   '("{=[^}]+}" . font-lock-string-face)
   
   ;; 9. Coordinates <Lat, Long>
   '("<[^>]+>" . font-lock-constant-face)
   )
  "Highlighting rules for FTT mode.")

;;; Indentation

(defun ftt-indent-line ()
  "Toggle indentation between 0 and 2 spaces."
  (interactive)
  (let ((current-col (current-column)))
    (if (= current-col 0)
        (indent-line-to ftt-indent-offset)
      (indent-line-to 0))))

;;; Navigation & Structure

(defun ftt-next-record ()
  "Move point to the next ID: definition."
  (interactive)
  (end-of-line) ; FIX: Step past current match to avoid getting stuck
  (if (re-search-forward "^ID:" nil t)
      (beginning-of-line)
    (message "No more records found.")))

(defun ftt-prev-record ()
  "Move point to the previous ID: definition."
  (interactive)
  (beginning-of-line) ; FIX: Ensure we search from start of current line backwards
  (if (re-search-backward "^ID:" nil t)
      (beginning-of-line)
    (message "No previous records found.")))

(defun ftt-next-section ()
  "Move point to the next --- separator."
  (interactive)
  (end-of-line)
  (if (re-search-forward "^---" nil t)
      (beginning-of-line)
    (message "No more sections found.")))

;;; Xref Backend (Go to Definition)

(defun ftt-xref-backend () 'ftt)

(cl-defmethod xref-backend-identifier-at-point ((_backend (eql ftt)))
  (thing-at-point 'symbol))

(cl-defmethod xref-backend-definitions ((_backend (eql ftt)) identifier)
  "Find definition of ID."
  (let ((results '()))
    (save-excursion
      (goto-char (point-min))
      ;; Search for "ID: <identifier>" at start of line
      (while (re-search-forward (concat "^ID:[ \t]*" (regexp-quote identifier) "\\s-*$") nil t)
        (push (xref-make identifier (xref-make-buffer-location (current-buffer) (match-beginning 0)))
              results)))
    results))

;;; Imenu (Hierarchical)

(defun ftt-imenu-create-index ()
  "Create a categorized index of IDs."
  (let ((sources '())
        (events '())
        (people '()))
    (save-excursion ; FIX: Prevent cursor from jumping to EOF
      (goto-char (point-min))
      (while (re-search-forward "^ID:\\s-*\\([^ \t\n]+\\)" nil t)
        (let* ((name (match-string 1))
               (pos (match-beginning 1))
               (item (cons name pos)))
          (cond
           ((string-prefix-p "^SRC" name) (push item sources))
           ((string-prefix-p "&EVT" name) (push item events))
           (t (push item people))))))
    ;; Return alist for Imenu
    `(("Individuals" . ,(nreverse people))
      ("Sources" . ,(nreverse sources))
      ("Events" . ,(nreverse events)))))

;;; Skeletons (Templates)

(define-skeleton ftt-insert-individual
  "Insert standard Individual template."
  "ID: "
  "ID: " _ "\n"
  "NAME: Name | SortKey | BIRTH | PREF\n"
  "SEX:  U\n"
  "BORN: YYYY-MM-DD | City; Region; Country\n"
  "DIED: \n"
  "PARENT: \n"
  "UNION: \n")

(define-skeleton ftt-insert-source
  "Insert standard Source template."
  "ID: ^SRC-"
  "ID: ^SRC-" _ "\n"
  "TITLE: \n"
  "AUTHOR: \n"
  "URL: \n")

(define-skeleton ftt-insert-shared-event
  "Insert Shared Event (&EVT) block."
  "Event ID (e.g. WWII): "
  "ID: &EVT-" str "\n"
  "TYPE: \n"
  "START_DATE: \n"
  "END_DATE: \n"
  "PLACE: \n"
  "SRC: \n")

(define-skeleton ftt-insert-inline-event
  "Insert Inline Event line."
  "Type (e.g. OCC): "
  "EVENT: " str " | YYYY-MM-DD | YYYY-MM-DD | Place | Details")

;;; Keyword Completion

(defvar ftt-keywords
  '("HEAD_FORMAT:" "HEAD_TITLE:" "HEAD_ROOT:" "HEAD_AUTHOR:" "HEAD_DATE:"
    "ID:" "NAME:" "SEX:" "BORN:" "DIED:" "PRIVACY:"
    "PARENT:" "CHILD:" "UNION:" "ASSOC:"
    "EVENT:" "EVENT_REF:" "MEDIA:" "SRC:" "NOTES:"
    "TITLE:" "AUTHOR:" "URL:" "START_DATE:" "END_DATE:" "PLACE:")
  "List of standard FTT keys.")

(defun ftt-completion-at-point ()
  "Backend for completion."
  (let ((bounds (bounds-of-thing-at-point 'symbol)))
    (when bounds
      (list (car bounds) (cdr bounds) ftt-keywords :exclusive 'no))))

(defun ftt-insert-date ()
  "Insert the current date in ISO 8601 format."
  (interactive)
  (insert (format-time-string "%Y-%m-%d")))

;;; Keymap

(defvar ftt-mode-map
  (let ((map (make-sparse-keymap)))
    ;; The Fix: Force RET to be a plain newline
    (define-key map (kbd "RET") 'newline)
    ;; Manual Indent Cycle
    (define-key map (kbd "TAB") 'ftt-indent-line)
    
    ;; Navigation
    (define-key map (kbd "C-c C-n") 'ftt-next-record)
    (define-key map (kbd "C-c C-p") 'ftt-prev-record)
    (define-key map (kbd "C-c C-f") 'ftt-next-section)
    
    ;; Templates
    (define-key map (kbd "C-c C-i") 'ftt-insert-individual)
    (define-key map (kbd "C-c C-s") 'ftt-insert-source)
    (define-key map (kbd "C-c C-e") 'ftt-insert-shared-event)
    (define-key map (kbd "C-c C-l") 'ftt-insert-inline-event)
    
    ;; Utilities
    (define-key map (kbd "C-c C-d") 'ftt-insert-date)
    (define-key map (kbd "C-c TAB") 'completion-at-point)
    map)
  "Keymap for ftt-mode.")

;;; Main Mode Definition

;;;###autoload
(define-derived-mode ftt-mode text-mode "FTT"
  "Major mode for FamilyTree-Text files.
\\{ftt-mode-map}"
  :group 'ftt
  
  (setq font-lock-defaults '(ftt-font-lock-keywords))
  
  ;; Indentation Settings
  (set (make-local-variable 'indent-line-function) 'ftt-indent-line)
  (set (make-local-variable 'tab-width) 2)
  
  ;; FIX: Proper way to disable electric indent in recent Emacs
  (when (fboundp 'electric-indent-local-mode)
    (electric-indent-local-mode -1))
  
  ;; Comments
  (set (make-local-variable 'comment-start) "# ")
  (set (make-local-variable 'comment-end) "")
  
  ;; Xref Hook
  (add-hook 'xref-backend-functions #'ftt-xref-backend nil t)
  
  ;; Completion Hook
  (add-hook 'completion-at-point-functions 'ftt-completion-at-point nil 'local)
  
  ;; Imenu & Folding
  (set (make-local-variable 'imenu-create-index-function) 'ftt-imenu-create-index)
  (set (make-local-variable 'outline-regexp) "^ID:\\|^HEAD_")
  
  (set (make-local-variable 'require-final-newline) t))

;;;###autoload
(add-to-list 'auto-mode-alist '("\\.ftt\\'" . ftt-mode))

(provide 'ftt-mode)
;;; ftt-mode.el ends here
