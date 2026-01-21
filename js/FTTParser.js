/**
 * FamilyTree-Text (FTT) Reference Parser v0.1
 * * Usage:
 * const parser = new FTTParser();
 * const result = parser.parse(fileContentString);
 * console.log(result);
 */

class FTTParser {
    constructor() {
        this.reset();
    }

    reset() {
        this.headers = {};
        this.records = new Map(); // Map<ID, RecordObject>
        this.ids = new Set();     // Fast lookup for existence
        this.errors = [];         // Validation errors
        
        // Internal Parsing State
        this.currentRecordId = null;
        this.currentKey = null;
        this.buffer = []; // Line buffer for multi-line content
        this.lastFieldRef = null; // Pointer to the last created field object (for Modifiers)
    }

    /**
     * Main Entry Point
     * @param {string} rawText - The UTF-8 file content.
     * @returns {object} - { headers, records, errors }
     */
    parse(rawText) {
        this.reset();
        
        // Normalize line endings and split
        const lines = rawText.replace(/\r\n/g, '\n').split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            this._processLine(line, i + 1);
        }

        // Flush final buffer
        this._flushBuffer();

        // Post-Parse Validation (Section 8.3)
        this._validateGraph();

        return {
            headers: this.headers,
            records: Object.fromEntries(this.records),
            errors: this.errors
        };
    }

    // =========================================================================
    // 1. Line Processing Logic (Section 8.1)
    // =========================================================================

    _processLine(line, lineNum) {
        // 1. Comment Check
        if (line.startsWith('#')) return;

        // 2. Visual Separator Check (Block Terminator)
        if (line.startsWith('---')) {
            this._flushBuffer();
            this.currentRecordId = null;
            return;
        }

        // 3. Indentation Check (Continuation)
        if (line.startsWith('  ')) {
            if (!this.currentKey) {
                // Orphaned indentation (Validation Error)
                this._error(`Line ${lineNum}: Indented content without a preceding key.`);
                return;
            }
            
            // Strip exactly 2 spaces
            const content = line.substring(2);
            
            // Space Folding Rule: If buffer has content and doesn't end in newline, add space
            if (this.buffer.length > 0 && this.buffer[this.buffer.length - 1] !== '\n') {
                this.buffer.push(' '); 
            }
            this.buffer.push(content);
            return;
        }

        // 4. Blank Line Check (Paragraph Break)
        if (!line.trim()) {
            if (this.currentKey) {
                // Inject paragraph marker into buffer, but don't close block yet
                this.buffer.push('\n'); 
            }
            return;
        }

        // 5. New Key Detection (Column 0)
        const keyMatch = line.match(/^([A-Z0-9_]+):(?:\s+(.*))?$/);
        if (keyMatch) {
            // Terminate previous block
            this._flushBuffer();

            const key = keyMatch[1];
            const inlineValue = keyMatch[2] || '';

            this._handleNewKey(key, inlineValue, lineNum);
            return;
        }

        // 6. Fall-through (Syntax Error)
        this._error(`Line ${lineNum}: Invalid syntax at Column 0. Expected Key or Indentation.`);
    }

    // =========================================================================
    // 2. Key Handling & Modifier Logic (Section 8.2)
    // =========================================================================

    _handleNewKey(key, inlineValue, lineNum) {
        this.currentKey = key;
        if (inlineValue) this.buffer.push(inlineValue);

        // Handle Global Headers (Before any ID)
        if (key.startsWith('HEAD_')) {
            if (this.currentRecordId) {
                this._error(`Line ${lineNum}: Header ${key} found inside a record block.`);
            }
            // Headers are single strings, usually not repeatable, but we store raw
            this.headers[key] = inlineValue; 
            // We set currentKey to null immediately for headers to prevent multiline buffering 
            // strictly, though the spec allows multiline headers if indented. 
            // Keeping currentKey active allows the buffer flush to handle it.
            return;
        }

        // Handle Record ID (Start of new record)
        if (key === 'ID') {
            const id = inlineValue.trim();
            this._validateID(id, lineNum);
            this.currentRecordId = id;
            
            this.records.set(id, {
                id: id,
                type: this._determineRecordType(id),
                data: {}
            });
            this.ids.add(id);
            this.lastFieldRef = null; // Reset field context
            return;
        }

        // Handle Data Keys inside a Record
        if (this.currentRecordId) {
            const record = this.records.get(this.currentRecordId);

            // Check if this is a Modifier (ends in _SRC or _NOTE)
            if (key.endsWith('_SRC') || key.endsWith('_NOTE')) {
                this._attachModifier(record, key, lineNum);
            } else {
                // It is a primary field
                this._createField(record, key);
            }
        } else {
             // Key found outside header and outside record
             this._error(`Line ${lineNum}: Key ${key} found outside of a record block.`);
        }
    }

    _createField(record, key) {
        if (!record.data[key]) {
            record.data[key] = [];
        }

        // Create a new field object. 
        // We store it as an object so modifiers can attach to it by reference.
        const newFieldObj = {
            raw: '',
            parsed: [], // Will hold split pipe values
            modifiers: {}
        };

        record.data[key].push(newFieldObj);
        this.lastFieldRef = { key: key, obj: newFieldObj }; // Update pointer
    }

    _attachModifier(record, modKey, lineNum) {
        // Validation: Modifier must follow a valid target (Section 8.2.4)
        // e.g., BORN_SRC must follow BORN
        const baseKey = modKey.replace(/_(SRC|NOTE)$/, '');
        
        if (!this.lastFieldRef || this.lastFieldRef.key !== baseKey) {
            this._error(`Line ${lineNum}: Modifier ${modKey} does not immediately follow a ${baseKey} field.`);
            return;
        }

        // Attach to the specific field instance
        if (!this.lastFieldRef.obj.modifiers[modKey]) {
            this.lastFieldRef.obj.modifiers[modKey] = [];
        }
        
        // We create a container for the modifier value
        // Modifiers themselves are just strings, but we buffer them to handle multiline
        const modObj = { raw: '' }; 
        this.lastFieldRef.obj.modifiers[modKey].push(modObj);
        
        // Hijack the flush logic to update this specific modifier object
        // We use a temporary property on the parser to know where to flush the buffer
        this.currentModifierTarget = modObj;
    }

    // =========================================================================
    // 3. Buffer Flushing & Parsing (Pipe Splitting)
    // =========================================================================

    _flushBuffer() {
        if (!this.currentKey || this.buffer.length === 0) {
            this.currentKey = null;
            this.buffer = [];
            this.currentModifierTarget = null;
            return;
        }

        const fullText = this.buffer.join('').trim();
        
        // Scenario A: flushing a Modifier
        if (this.currentModifierTarget) {
            this.currentModifierTarget.raw = fullText;
            // Modifiers might have pipe structures too (e.g. citations), allow parsing
            this.currentModifierTarget.parsed = this._parsePipes(fullText);
            this.currentModifierTarget = null;
        } 
        // Scenario B: flushing a Global Header
        else if (this.currentKey.startsWith('HEAD_')) {
            this.headers[this.currentKey] = fullText;
        }
        // Scenario C: flushing a Record Field
        else if (this.currentRecordId && this.lastFieldRef) {
            // Update the object created in _createField
            this.lastFieldRef.obj.raw = fullText;
            this.lastFieldRef.obj.parsed = this._parsePipes(fullText);
        }

        // Reset
        this.buffer = [];
        this.currentKey = null;
    }

    /**
     * Splits string by pipe `|` but respects escaped `\|`
     */
    _parsePipes(text) {
        const values = [];
        let currentVal = '';
        let isEscaped = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            if (isEscaped) {
                currentVal += char;
                isEscaped = false;
            } else if (char === '\\') {
                isEscaped = true;
            } else if (char === '|') {
                // Pipe delimiter
                values.push(currentVal.trim());
                currentVal = '';
            } else {
                currentVal += char;
            }
        }
        values.push(currentVal.trim()); // Push last value
        
        // Handle trailing omission: "A|B|" -> ["A", "B", ""]
        // The spec says trailing separators may be omitted if subsequent fields are empty.
        // But if explicitly present "||", it implies empty field. 
        // Our logic naturally handles "||" as empty string.
        
        return values;
    }

    // =========================================================================
    // 4. Validation & Types (Section 3 & 8.3)
    // =========================================================================

    _determineRecordType(id) {
        if (id.startsWith('^')) return 'SOURCE';
        if (id.startsWith('&')) return 'EVENT';
        if (id.startsWith('?')) return 'PLACEHOLDER';
        return 'INDIVIDUAL';
    }

    _validateID(id, lineNum) {
        // 1. Global Forbidden Characters (Section 3.1)
        // IDs must not contain Whitespace, Pipe, Semicolons, or Control characters.
        if (/[\s|;\p{C}]/u.test(id)) {
            this._error(`Line ${lineNum}: ID "${id}" contains forbidden characters (Whitespace, Pipe, Semicolon, or Control).`);
            return; 
        }

        const firstChar = id.charAt(0);
        
        // 2. Standard ID Validation (Section 3.2.1)
        // If it DOES NOT start with a sigil (^, &, ?), it is a Standard ID.
        if (!['^', '&', '?'].includes(firstChar)) {
            // Rule: Must start with Alphanumeric (\p{L} or \p{N})
            // Rule: Allowed characters are \p{L}, \p{N}, and Hyphen (-)
            const standardIdPattern = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;
            
            if (!standardIdPattern.test(id)) {
                this._error(`Line ${lineNum}: Invalid Standard ID "${id}". Must start with alphanumeric and contain only alphanumeric or hyphens.`);
            }
        }
        // Note: Sigil IDs are implicitly validated by the exclusion of "Standard" chars and the global forbidden list.
    }

    _validateGraph() {
        // 1. Dangling Reference Check (Section 8.3.4)
        // We scan every parsed field for references to IDs
        this.records.forEach((record, id) => {
            this._checkReferences(record);
        });

        // 2. Ghost Child Check (Section 8.3.1)
        this.records.forEach((record, parentId) => {
            if (record.data['CHILD']) {
                record.data['CHILD'].forEach(childField => {
                    const childId = childField.parsed[0]; // Child ID is index 0
                    if (!childId) return;

                    // If placeholder, skip check
                    if (childId.startsWith('?')) return;

                    const childRecord = this.records.get(childId);
                    if (!childRecord) {
                        // Handled by dangling ref check, but strictly for Ghost Child logic:
                        return; 
                    }

                    // Does child point back to parent?
                    let pointsBack = false;
                    if (childRecord.data['PARENT']) {
                        pointsBack = childRecord.data['PARENT'].some(p => p.parsed[0] === parentId);
                    }

                    if (!pointsBack) {
                        this._error(`Ghost Child Error: Record ${parentId} claims ${childId} is a CHILD, but ${childId} does not list ${parentId} as a PARENT.`);
                    }
                });
            }
        });

        // 3. Cycle Detection (Section 8.3.3)
        // Run DFS on every node to detect back-edges
        const visited = new Set();
        const recursionStack = new Set();

        const detectCycle = (currId) => {
            if (recursionStack.has(currId)) return true; // Cycle found
            if (visited.has(currId)) return false;

            visited.add(currId);
            recursionStack.add(currId);

            const record = this.records.get(currId);
            if (record && record.data['PARENT']) {
                for (const pField of record.data['PARENT']) {
                    const parentId = pField.parsed[0];
                    // Skip placeholders in cycle check
                    if (parentId && !parentId.startsWith('?') && this.records.has(parentId)) {
                        if (detectCycle(parentId)) {
                            this._error(`Circular Lineage detected involving ${currId} and ${parentId}.`);
                            return true;
                        }
                    }
                }
            }

            recursionStack.delete(currId);
            return false;
        };

        for (const id of this.ids) {
            if (this._determineRecordType(id) === 'INDIVIDUAL') {
                if (!visited.has(id)) detectCycle(id);
            }
        }
    }

    _checkReferences(record) {
        // Iterate all fields to find standard reference keys
        // PARENT, CHILD, UNION, ASSOC, SRC, EVENT_REF keys contain IDs at index 0
        const refKeys = ['PARENT', 'CHILD', 'UNION', 'ASSOC', 'SRC', 'EVENT_REF'];
        
        refKeys.forEach(key => {
            if (record.data[key]) {
                record.data[key].forEach(field => {
                    const targetId = field.parsed[0];
                    if (targetId && !this._idExists(targetId)) {
                        this._error(`Dangling Reference: ${record.id} points to missing ID ${targetId} in ${key}.`);
                    }
                });
            }
        });

        // Check Modifiers for Sources
        Object.values(record.data).forEach(fieldList => {
            fieldList.forEach(field => {
                // Check *_SRC modifiers
                for (const modKey in field.modifiers) {
                    if (modKey.endsWith('_SRC')) {
                        field.modifiers[modKey].forEach(mod => {
                            const srcId = mod.parsed[0];
                            if (srcId && !this._idExists(srcId)) {
                                this._error(`Dangling Reference: ${record.id} cites missing Source ${srcId} in ${modKey}.`);
                            }
                        });
                    }
                }
            });
        });
    }

    _idExists(id) {
        // Always return true for Placeholders (?)
        if (id.startsWith('?')) return true;
        return this.ids.has(id);
    }

    _error(msg) {
        this.errors.push(msg);
    }
}

// Export for Node.js or Browser
if (typeof module !== 'undefined') module.exports = FTTParser;
