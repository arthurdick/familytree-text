/**
 * FamilyTree-Text (FTT) Reference Parser v0.1.2
 * const parser = new FTTParser();
 * const result = parser.parse(fileContentString);
 */

const STANDARD_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;
const KEY_PATTERN = /^([A-Z0-9_]+):(?:\s+(.*))?$/;
const DATE_PATTERN = /^(\?|\.\.|\[.*\.\..*\]|-?[\dX]+(?:-\d{2})?(?:-\d{2})?[?~]?)$/;

export default class FTTParser {
    constructor() {
        this.SUPPORTED_VERSION = 0.1;
    }

    /**
     * Main Entry Point
     * @param {string} rawText
     * @returns {object} { headers, records, errors, warnings }
     */
    parse(rawText) {
        const session = new ParseSession(this.SUPPORTED_VERSION);
        // Optimization: Pass an iterator instead of splitting the entire string into an array.
        // This reduces memory pressure on large files.
        return session.run(this._createLineIterator(rawText));
    }

    /**
     * Generator to yield lines one by one without creating a massive array.
     * @param {string} text 
     */
    * _createLineIterator(text) {
        let start = 0;
        let lineNum = 1;
        const length = text.length;

        while (start <= length) {
            let end = text.indexOf('\n', start);
            if (end === -1) {
                end = length;
            }

            let line = text.slice(start, end);
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }

            // If we are at the end of the file and the text didn't end with a newline,
            // we yield the last chunk. If it did end with a newline, we yield an empty string
            // (mimicking split behavior), though FTT logic largely ignores trailing blank lines.
            if (start <= length) {
                yield { line, lineNum: lineNum++ };
            }

            if (end === length) break;
            start = end + 1;
        }
    }
}

/**
 * Structured Error Object
 */
class FTTError {
    constructor(code, message, line, severity = 'ERROR') {
        this.code = code;
        this.message = message;
        this.line = line;
        this.severity = severity;
        this.timestamp = new Date().toISOString();
    }

    toString() {
        return `[${this.severity}] Line ${this.line}: ${this.message} (${this.code})`;
    }
}

/**
 * Internal Parse Session
 */
class ParseSession {
    constructor(version) {
        this.SUPPORTED_VERSION = version;

        // Output Data
        this.headers = {};
        this.records = new Map();
        this.ids = new Set();

        // Structured Logs
        this.errors = [];   // Array<FTTError>
        this.warnings = []; // Array<FTTError>

        // State
        this.currentRecordId = null;
        this.currentKey = null;
        this.buffer = [];
        this.lastFieldRef = null;
        this.currentModifierTarget = null;
        
        // Track current line for buffer flushing
        this.bufferStartLine = 0;
    }

    run(lineIterator) {
        // Iterate via generator (Memory Optimization)
        for (const { line, lineNum } of lineIterator) {
            this._processLine(line, lineNum);
        }

        this._flushBuffer();
        this._postProcess();
        this._validateGraph();

        return {
            headers: this.headers,
            records: Object.fromEntries(this.records),
            errors: this.errors,
            warnings: this.warnings
        };
    }

    // =========================================================================
    // 1. Line Processing
    // =========================================================================

    _processLine(line, lineNum) {
        if (line.startsWith('#')) return;
        
        // 1. Block Termination Check
        if (line.startsWith('---')) {
            this._flushBuffer();
            this.currentRecordId = null;
            return;
        }

        // 2. Blank Line Check (Paragraph logic)
        // MUST happen before Indentation Check to catch indented blank lines.
        if (!line.trim()) {
            if (this.currentKey) {
                this.buffer.push('\n');
            }
            return;
        }

        // 3. Indentation Check (Continuation)
        if (line.startsWith('  ')) {
            if (!this.currentKey) {
                this._error('SYNTAX_INDENT', 'Indented content without a preceding key.', lineNum);
                return;
            }
            const content = line.substring(2);

            // Folding Rule: Only append a space if there is existing content 
            // and the last element in the buffer is NOT an explicit newline (\n).
            if (this.buffer.length > 0) {
                const lastEntry = this.buffer[this.buffer.length - 1];
                if (lastEntry !== '\n') {
                    this.buffer.push(' ');
                }
            }
            this.buffer.push(content);
            return;
        }

        // 4. New Key Detection
        const keyMatch = line.match(KEY_PATTERN);
        if (keyMatch) {
            this._flushBuffer();
            this._handleNewKey(keyMatch[1], keyMatch[2] || '', lineNum);
            return;
        }

        this._error('SYNTAX_INVALID', 'Invalid syntax at Column 0. Expected Key or Indentation.', lineNum);
    }

    // =========================================================================
    // 2. Key Handling
    // =========================================================================

    _handleNewKey(key, inlineValue, lineNum) {
        this.currentKey = key;
        this.bufferStartLine = lineNum; // Track where this block started

        if (inlineValue) this.buffer.push(inlineValue);

        // Global Headers
        if (key.startsWith('HEAD_')) {
            if (this.currentRecordId) {
                this._error('CTX_HEADER', `Header ${key} found inside a record block.`, lineNum);
            }
            // Note: We don't commit to headers object until flush
            return;
        }

        // Record ID
        if (key === 'ID') {
            const id = inlineValue.trim().normalize('NFC');
            this._validateID(id, lineNum);

            if (this.records.has(id)) {
                this._error('DUPLICATE_ID', `Duplicate Record ID "${id}". Ignoring definition.`, lineNum);
                this.currentRecordId = null;
                return;
            }

            this.currentRecordId = id;
            this.records.set(id, {
                id: id,
                type: this._determineRecordType(id),
                line: lineNum, // Store definition line for later validation
                data: {}
            });
            this.ids.add(id);
            this.lastFieldRef = null;
            return;
        }

        // Data Keys
        if (this.currentRecordId) {
            const record = this.records.get(this.currentRecordId);
            
            if (key.endsWith('_SRC') || key.endsWith('_NOTE')) {
                this._attachModifier(record, key, lineNum);
            } else {
                this._createField(record, key, lineNum);
            }
        } else {
            this._error('CTX_ORPHAN', `Key ${key} found outside of a record block.`, lineNum);
        }
    }

    _createField(record, key, lineNum) {
        if (!record.data[key]) {
            record.data[key] = [];
        }

        const newFieldObj = {
            raw: '',
            parsed: [],
            modifiers: {},
            line: lineNum // Critical for validation reporting
        };

        record.data[key].push(newFieldObj);
        this.lastFieldRef = {
            key,
            obj: newFieldObj
        };
    }

    _attachModifier(record, modKey, lineNum) {
        const baseKey = modKey.replace(/_(SRC|NOTE)$/, '');

        if (!this.lastFieldRef || this.lastFieldRef.key !== baseKey) {
            this._error('CTX_MODIFIER', `Modifier ${modKey} does not immediately follow a ${baseKey} field.`, lineNum);
            return;
        }

        if (!this.lastFieldRef.obj.modifiers[modKey]) {
            this.lastFieldRef.obj.modifiers[modKey] = [];
        }

        const modObj = {
            raw: '',
            line: lineNum
        };

        this.lastFieldRef.obj.modifiers[modKey].push(modObj);
        this.currentModifierTarget = modObj;
    }

    // =========================================================================
    // 3. Buffer Flushing
    // =========================================================================

    _flushBuffer() {
        if (!this.currentKey || this.buffer.length === 0) {
            this.currentKey = null;
            this.buffer = [];
            this.currentModifierTarget = null;
            return;
        }

        // Join exactly as is; trim only the outer bounds of the block.
        const fullText = this.buffer.join('').trim();

        if (this.currentModifierTarget) {
            this.currentModifierTarget.raw = fullText;
            this.currentModifierTarget.parsed = this._parsePipes(fullText);
            this.currentModifierTarget = null;
        } else if (this.currentKey.startsWith('HEAD_')) {
            this.headers[this.currentKey] = fullText.normalize('NFC');
        } else if (this.currentRecordId && this.lastFieldRef) {
            this.lastFieldRef.obj.raw = fullText;
            this.lastFieldRef.obj.parsed = this._parsePipes(fullText);
        }

        this.buffer = [];
        this.currentKey = null;
    }

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
                values.push(currentVal.trim().normalize('NFC'));
                currentVal = '';
            } else {
                currentVal += char;
            }
        }
        values.push(currentVal.trim().normalize('NFC'));
        return values;
    }

    // =========================================================================
    // 4. Post-Processing
    // =========================================================================

    _postProcess() {
        this._injectImplicitUnions();
        this._processPlaceHierarchies();
    }

    _injectImplicitUnions() {
        for (const [id, record] of this.records) {
            if (!record.data['UNION']) continue;

            for (const unionField of record.data['UNION']) {
                const partnerId = unionField.parsed[0];
                if (!partnerId) continue;

                const partnerRecord = this.records.get(partnerId);
                if (!partnerRecord) continue;

                // Check reciprocals
                let reciprocalField = null;
                if (partnerRecord.data['UNION']) {
                    reciprocalField = partnerRecord.data['UNION'].find(u => u.parsed[0] === id);
                }

                if (reciprocalField) {
                    // Consistency Check
                    for (let i = 1; i <= 4; i++) {
                        const valA = (unionField.parsed[i] || '').trim();
                        const valB = (reciprocalField.parsed[i] || '').trim();
                        if (valA !== valB) {
                            this._warning('DATA_CONSISTENCY', `Union mismatch between ${id} and ${partnerId} at index ${i} ("${valA}" vs "${valB}").`, unionField.line);
                        }
                    }
                } else {
                    // Inject implicit
                    if (!partnerRecord.data['UNION']) partnerRecord.data['UNION'] = [];

                    const implicitParsed = [...unionField.parsed];
                    implicitParsed[0] = id; // Swap ID

                    partnerRecord.data['UNION'].push({
                        raw: `(Implicit Reciprocal of ${id})`,
                        parsed: implicitParsed,
                        modifiers: {},
                        line: partnerRecord.line, // Attribute to record start since it's implicit
                        isImplicit: true
                    });
                }
            }
        }
    }

    _processPlaceHierarchies() {
        const PLACE_INDICES = {
            'BORN': 1,
            'DIED': 1,
            'EVENT': 3,
            'PLACE': 0
        };

        for (const record of this.records.values()) {
            for (const [key, fields] of Object.entries(record.data)) {
                const placeIdx = PLACE_INDICES[key];
                if (placeIdx === undefined) continue;

                for (const field of fields) {
                    if (field.parsed.length > placeIdx) {
                        const rawPlace = field.parsed[placeIdx];
                        
                        if (rawPlace && (rawPlace.includes('{=') || rawPlace.includes('<'))) {
                            const {
                                display,
                                geo,
                                coords
                            } = this._parsePlaceString(rawPlace);
                            
                            field.parsed[placeIdx] = display;
                            if (!field.metadata) field.metadata = {};
                            if (geo) field.metadata.geo = geo;
                            if (coords) field.metadata.coords = coords;
                        }
                    }
                }
            }
        }
    }

    _parsePlaceString(str) {
        const coordsRegex = /<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>/;
        const coordsMatch = str.match(coordsRegex);
        let coords = null;
        if (coordsMatch) {
            coords = `${coordsMatch[1]}, ${coordsMatch[2]}`;
        }

        let display = str
            .replace(/\s*\{=.*?\}/g, '')
            .replace(coordsRegex, '')
            .trim();

        const geoRaw = str.replace(/([^{;]+?)\s*\{=([^}]+)\}/g, '$2');
        const geo = geoRaw.replace(coordsRegex, '').trim();

        return {
            display,
            geo,
            coords
        };
    }

    // =========================================================================
    // 5. Validation
    // =========================================================================

    _determineRecordType(id) {
        if (id.startsWith('^')) return 'SOURCE';
        if (id.startsWith('&')) return 'EVENT';
        if (id.startsWith('?')) return 'PLACEHOLDER';
        return 'INDIVIDUAL';
    }

    _validateID(id, lineNum) {
        if (/[\s|;\p{C}]/u.test(id)) {
            this._error('ID_FORMAT', `ID "${id}" contains forbidden characters.`, lineNum);
            return;
        }
        const firstChar = id.charAt(0);
        if (!['^', '&', '?'].includes(firstChar)) {
            if (!STANDARD_ID_PATTERN.test(id)) {
                this._error('ID_FORMAT', `Invalid Standard ID "${id}".`, lineNum);
            }
        }
    }

    _validateGraph() {
        // Version Check
        const formatHeader = this.headers['HEAD_FORMAT'];
        if (!formatHeader) {
            this._error('MISSING_HEADER', 'Missing Header: HEAD_FORMAT', 1);
        } else {
            const match = formatHeader.match(/v(\d+(\.\d+)?)/);
            if (match && parseFloat(match[1]) > this.SUPPORTED_VERSION) {
                this._error('VERSION_MISMATCH', `File (v${match[1]}) > Supported (v${this.SUPPORTED_VERSION}).`, 1);
            }
        }

        // 1. Dangling Reference Check
        this.records.forEach((record) => this._checkReferences(record));

        // 2. Ghost Child Check
        // Ensures that if A lists B as a child, B actually lists A as a parent.
        this.records.forEach((record, parentId) => {
            if (record.data['CHILD']) {
                record.data['CHILD'].forEach(childField => {
                    const childId = childField.parsed[0];
                    if (!childId || childId.startsWith('?')) return;

                    const childRecord = this.records.get(childId);
                    if (!childRecord) return;

                    const pointsBack = childRecord.data['PARENT']?.some(p => p.parsed[0] === parentId);
                    if (!pointsBack) {
                        this._error('GHOST_CHILD', `${parentId} -> ${childId} (Child does not reciprocate PARENT link).`, childField.line);
                    }
                });
            }
        });

        // 3. Cycle Detection (Iterative DFS with Post-Order Visited)
        // 'visited' must only track nodes that are fully processed (Black set), 
        // not just discovered (Gray set), to prevent premature skipping.
        const visited = new Set();
        for (const rootId of this.ids) {
            // Only process Individuals for lineage cycles
            if (this._determineRecordType(rootId) !== 'INDIVIDUAL') continue;
            if (visited.has(rootId)) continue;

            // Stack stores: { id, path, processed }
            // processed = false (Expand/Visit), true (Post-visit/Mark Safe)
            const stack = [{ id: rootId, path: [], processed: false }];

            while (stack.length > 0) {
                const frame = stack[stack.length - 1];

                if (frame.processed) {
                    // Post-order: We are done with this node
                    visited.add(frame.id);
                    stack.pop();
                    continue;
                }

                // Mark as processed so next time we see this frame, we pop it (Post-order)
                frame.processed = true;
                const { id, path } = frame;

                // Cycle Check (Gray Set Logic via Path)
                if (path.includes(id)) {
                    const cyclePath = [...path, id].join(' -> ');
                    this._error(
                        'CIRCULAR_LINEAGE',
                        `Circular Lineage Detected: ${cyclePath}`,
                        this.records.get(id)?.line || 0
                    );
                    stack.pop(); // Remove faulty node to continue processing stack
                    continue;
                }

                // If globally visited (Black Set), we know it's safe
                if (visited.has(id)) {
                    stack.pop();
                    continue;
                }

                // Expand Parents (Add to stack)
                const record = this.records.get(id);
                if (record && record.data['PARENT']) {
                    const nextPath = [...path, id];

                    for (const pField of record.data['PARENT']) {
                        const parentId = pField.parsed[0];
                        if (parentId && this.records.has(parentId)) {
                            stack.push({ id: parentId, path: nextPath, processed: false });
                        }
                    }
                }
            }
        }

        // 4. Vocabulary & Date Validation
        this._validateVocabulary();
        this._validateDates();
    }

    _checkReferences(record) {
        const refKeys = ['PARENT', 'CHILD', 'UNION', 'ASSOC', 'SRC', 'EVENT_REF'];
        refKeys.forEach(key => {
            record.data[key]?.forEach(field => {
                const targetId = field.parsed[0];
                if (targetId && !this._idExists(targetId)) {
                    this._error('DANGLING_REF', `Reference to missing ID: ${targetId}`, field.line);
                }
            });
        });

        // Check Citation modifiers
        Object.values(record.data).forEach(fieldList => {
            fieldList.forEach(field => {
                for (const modKey in field.modifiers) {
                    if (modKey.endsWith('_SRC')) {
                        field.modifiers[modKey].forEach(mod => {
                            const srcId = mod.parsed[0];
                            if (srcId && !this._idExists(srcId)) {
                                this._error('DANGLING_SRC', `Citation of missing Source: ${srcId}`, mod.line);
                            }
                        });
                    }
                }
            });
        });
    }

    _validateVocabulary() {
        const VALID = {
            PARENT_TYPES: new Set(['BIO', 'ADO', 'STE', 'FOS', 'DONR', 'SURR', 'LEGL', 'UNK']),
            UNION_TYPES: new Set(['MARR', 'CIVL', 'PART', 'UNK']),
            UNION_REASONS: new Set(['DIV', 'SEP', 'WID', 'ANN', 'VOID']),
            NAME_TYPES: new Set(['BIRTH', 'MARR', 'ADO', 'IMM', 'TRAN', 'AKA', 'NICK', 'PROF', 'REL', 'UNK']),
            NAME_STATUS: new Set(['PREF']),
            ASSOC_ROLES: new Set(['GODP', 'GODC', 'SPON', 'OFFI', 'WITN', 'EXEC', 'GUAR', 'WARD', 'INFO', 'MAST', 'APPR', 'SERV', 'NEIG', 'ENSL', 'OWNR'])
        };

        for (const record of this.records.values()) {
            record.data['PARENT']?.forEach(f => {
                const type = (f.parsed[1] || '').trim();
                if (type && !VALID.PARENT_TYPES.has(type)) this._error('INVALID_VOCAB', `Invalid PARENT Type "${type}"`, f.line);
            });

            record.data['UNION']?.forEach(f => {
                if (f.isImplicit) return; // Don't validate generated implicit records
                const type = (f.parsed[1] || '').trim();
                const reason = (f.parsed[4] || '').trim();
                if (type && !VALID.UNION_TYPES.has(type)) this._error('INVALID_VOCAB', `Invalid UNION Type "${type}"`, f.line);
                if (reason && !VALID.UNION_REASONS.has(reason)) this._error('INVALID_VOCAB', `Invalid UNION Reason "${reason}"`, f.line);
            });

            record.data['NAME']?.forEach(f => {
                const type = (f.parsed[2] || '').trim();
                const status = (f.parsed[3] || '').trim();
                if (type && !VALID.NAME_TYPES.has(type)) this._warning('NONSTD_VOCAB', `Non-standard NAME Type "${type}"`, f.line);
                if (status && !VALID.NAME_STATUS.has(status)) this._error('INVALID_VOCAB', `Invalid NAME Status "${status}"`, f.line);
            });

            record.data['ASSOC']?.forEach(f => {
                const role = (f.parsed[1] || '').trim();
                if (role && !VALID.ASSOC_ROLES.has(role)) this._warning('NONSTD_VOCAB', `Non-standard ASSOC Role "${role}"`, f.line);
            });
        }
    }

    _validateDates() {
        const DATE_KEYS = {
            'BORN': [0],
            'DIED': [0],
            'EVENT': [1, 2],
            'UNION': [2, 3],
            'ASSOC': [2, 3],
            'MEDIA': [1],
            'START_DATE': [0],
            'END_DATE': [0]
        };

        for (const record of this.records.values()) {
            for (const [key, fields] of Object.entries(record.data)) {
                if (DATE_KEYS[key]) {
                    const indicesToCheck = DATE_KEYS[key];
                    fields.forEach(field => {
                        indicesToCheck.forEach(idx => {
                            if (field.parsed.length > idx) {
                                const dateVal = field.parsed[idx];
                                if (dateVal && !DATE_PATTERN.test(dateVal)) {
                                    this._error('INVALID_DATE', `Invalid ISO 8601/EDTF Date "${dateVal}"`, field.line);
                                }
                            }
                        });
                    });
                }
            }
        }
    }

    _idExists(id) {
        if (id.startsWith('?')) return true;
        return this.ids.has(id);
    }

    // =========================================================================
    // 6. Logging Helpers
    // =========================================================================

    _error(code, msg, line) {
        this.errors.push(new FTTError(code, msg, line, 'ERROR'));
    }

    _warning(code, msg, line) {
        this.warnings.push(new FTTError(code, msg, line, 'WARNING'));
    }
}
