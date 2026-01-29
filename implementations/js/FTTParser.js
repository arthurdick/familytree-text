/**
 * FamilyTree-Text (FTT) Reference Parser v0.1.4
 * const parser = new FTTParser();
 * const result = parser.parse(fileContentString);
 */

const STANDARD_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_\.-]*$/u;
const KEY_PATTERN = /^([A-Z0-9_]+):(?:\s+(.*))?$/;

// Errors defined as Critical/Fatal in FTT Spec v0.1
const FATAL_CODES = new Set([
    'SYNTAX_INDENT',
    'SYNTAX_INVALID',
    'CTX_HEADER',
    'CTX_ORPHAN',
    'CTX_MODIFIER',
    'ID_FORMAT',
    'DUPLICATE_ID',
    'MISSING_HEADER',
    'VERSION_MISMATCH',
    'GHOST_CHILD',       // Spec 8.3.1: "Critical Error"
    'CIRCULAR_LINEAGE',  // Spec 8.3.3: "Critical Lineage Error"
    'DANGLING_REF',      // Spec 8.3.4: "Critical Validation Error"
    'DANGLING_SRC'       // Spec 8.3.4: "Critical Validation Error"
]);

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
 * Internal Error for halting execution immediately
 */
class FTTFatalError extends Error {
    constructor(fttError) {
        super(fttError.message);
        this.name = "FTTFatalError";
        this.errorObj = fttError;
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
        try {
            // Iterate via generator (Memory Optimization)
            for (const { line, lineNum } of lineIterator) {
                this._processLine(line, lineNum);
            }

            this._flushBuffer();
            this._postProcess();
            this._validateGraph();

        } catch (e) {
            // Catch Fatal Errors and halt parsing immediately
            if (e instanceof FTTFatalError) {
                this.errors.push(e.errorObj);
                
                // Return NO records on fatal error to prevent data corruption
                return {
                    headers: this.headers, // Headers parsed so far might be useful for debugging
                    records: {},
                    errors: this.errors,
                    warnings: this.warnings
                };
            }
            throw e; // Re-throw unexpected system errors
        }

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
                return; // Logic stops if fatal
            }
            const content = line.substring(2);

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
        this.bufferStartLine = lineNum;

        if (inlineValue) this.buffer.push(inlineValue);

        // Global Headers
        if (key.startsWith('HEAD_')) {
            if (this.currentRecordId) {
                this._error('CTX_HEADER', `Header ${key} found inside a record block.`, lineNum);
            }
            return;
        }

        // Record ID
        if (key === 'ID') {
            const id = inlineValue.trim().normalize('NFC');
            this._validateID(id, lineNum);

            // Strict Collision Intolerance
            if (this.records.has(id)) {
                const originalLine = this.records.get(id).line;
                this._error(
                    'DUPLICATE_ID', 
                    `Duplicate Record ID "${id}" detected. Originally defined on Line ${originalLine}.`, 
                    lineNum
                );
            }

            this.currentRecordId = id;
            this.records.set(id, {
                id: id,
                type: this._determineRecordType(id),
                line: lineNum,
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
            line: lineNum
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
        this._reconcileChildLists();
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

                let reciprocalField = null;
                if (partnerRecord.data['UNION']) {
                    reciprocalField = partnerRecord.data['UNION'].find(u => u.parsed[0] === id);
                }

                if (reciprocalField) {
                    for (let i = 1; i <= 4; i++) {
                        const valA = (unionField.parsed[i] || '').trim();
                        const valB = (reciprocalField.parsed[i] || '').trim();
                        if (valA !== valB) {
                            this._warning('DATA_CONSISTENCY', `Union mismatch between ${id} and ${partnerId} at index ${i} ("${valA}" vs "${valB}").`, unionField.line);
                        }
                    }
                } else {
                    if (!partnerRecord.data['UNION']) partnerRecord.data['UNION'] = [];
                    const implicitParsed = [...unionField.parsed];
                    implicitParsed[0] = id;
                    partnerRecord.data['UNION'].push({
                        raw: `(Implicit Reciprocal of ${id})`,
                        parsed: implicitParsed,
                        modifiers: {},
                        line: partnerRecord.line,
                        isImplicit: true
                    });
                }
            }
        }
    }
    
    _reconcileChildLists() {
        const parentToKidsMap = new Map();

        for (const [childId, childRec] of this.records) {
            if (childRec.data['PARENT']) {
                childRec.data['PARENT'].forEach(pField => {
                    const parentId = pField.parsed[0];
                    if (!this.records.has(parentId)) return;

                    if (!parentToKidsMap.has(parentId)) {
                        parentToKidsMap.set(parentId, []);
                    }
                    parentToKidsMap.get(parentId).push(childRec);
                });
            }
        }

        for (const [parentId, parentRec] of this.records) {
            const actualChildren = parentToKidsMap.get(parentId) || [];
            const manifestFields = parentRec.data['CHILD'] || [];
            
            const manifestIds = new Set();
            const finalList = [];

            manifestFields.forEach(field => {
                const childId = field.parsed[0];
                if (this.records.has(childId)) {
                    finalList.push(field);
                    manifestIds.add(childId);
                }
            });

            const forgottenChildren = actualChildren.filter(c => !manifestIds.has(c.id));
            forgottenChildren.sort((a, b) => {
                const dateA = this._getSortableDate(a);
                const dateB = this._getSortableDate(b);
                return dateA.localeCompare(dateB);
            });

            forgottenChildren.forEach(childRec => {
                finalList.push({
                    raw: `CHILD: ${childRec.id}`,
                    parsed: [childRec.id],
                    modifiers: {},
                    line: parentRec.line,
                    isImplicit: true
                });
            });

            if (finalList.length > 0) {
                parentRec.data['CHILD'] = finalList;
            }
        }
    }

    _getSortableDate(record) {
        if (!record.data['BORN'] || !record.data['BORN'][0]) return "9999";
        const rawDate = record.data['BORN'][0].parsed[0];
        if (!rawDate) return "9999";
        const match = rawDate.match(/([0-9]{4}(?:-[0-9]{2})?(?:-[0-9]{2})?)/);
        return match ? match[1] : "9999";
    }

    _processPlaceHierarchies() {
        const PLACE_INDICES = {
            'BORN': 1, 'DIED': 1, 'EVENT': 3, 'PLACE': 0
        };

        for (const record of this.records.values()) {
            for (const [key, fields] of Object.entries(record.data)) {
                const placeIdx = PLACE_INDICES[key];
                if (placeIdx === undefined) continue;

                for (const field of fields) {
                    if (field.parsed.length > placeIdx) {
                        const rawPlace = field.parsed[placeIdx];
                        if (rawPlace && (rawPlace.includes('{=') || rawPlace.includes('<'))) {
                            const { display, geo, coords } = this._parsePlaceString(rawPlace);
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
        let display = str.replace(/\s*\{=.*?\}/g, '').replace(coordsRegex, '').trim();
        const geoRaw = str.replace(/([^{;]+?)\s*\{=([^}]+)\}/g, '$2');
        const geo = geoRaw.replace(coordsRegex, '').trim();
        return { display, geo, coords };
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

        // 2. Ghost Child Check (Defined as Critical Error in Spec 8.3.1)
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

        // 3. Cycle Detection
        const visited = new Set();
        for (const rootId of this.ids) {
            if (this._determineRecordType(rootId) !== 'INDIVIDUAL') continue;
            if (visited.has(rootId)) continue;

            const stack = [{ id: rootId, path: [], processed: false }];

            while (stack.length > 0) {
                const frame = stack[stack.length - 1];
                if (frame.processed) {
                    visited.add(frame.id);
                    stack.pop();
                    continue;
                }
                frame.processed = true;
                const { id, path } = frame;

                if (path.includes(id)) {
                    const cyclePath = [...path, id].join(' -> ');
                    this._error('CIRCULAR_LINEAGE', `Circular Lineage Detected: ${cyclePath}`, this.records.get(id)?.line || 0);
                    stack.pop();
                    continue;
                }

                if (visited.has(id)) {
                    stack.pop();
                    continue;
                }

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

        // 4. Vocabulary & Date (Non-Fatal Validation)
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
                if (f.isImplicit) return;
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
            'BORN': [0], 'DIED': [0], 'EVENT': [1, 2], 'UNION': [2, 3],
            'ASSOC': [2, 3], 'MEDIA': [1], 'START_DATE': [0], 'END_DATE': [0]
        };

        for (const record of this.records.values()) {
            for (const [key, fields] of Object.entries(record.data)) {
                if (DATE_KEYS[key]) {
                    const indicesToCheck = DATE_KEYS[key];
                    fields.forEach(field => {
                        indicesToCheck.forEach(idx => {
                            if (field.parsed.length > idx) {
                                const dateVal = field.parsed[idx];
                                if (dateVal && !isValidFTTDate(dateVal)) {
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

    _error(code, msg, line) {
        const error = new FTTError(code, msg, line, FATAL_CODES.has(code) ? 'FATAL' : 'ERROR');
        
        // Immediate Halt if Fatal
        if (FATAL_CODES.has(code)) {
            throw new FTTFatalError(error);
        }
        
        this.errors.push(error);
    }

    _warning(code, msg, line) {
        this.warnings.push(new FTTError(code, msg, line, 'WARNING'));
    }
}

/**
 * EDTF / ISO 8601-2 Level 2 Validator for FTT
 */
function isValidFTTDate(dateStr) {
    if (!dateStr) return false;
    const str = dateStr.trim();
    if (str === '?' || str === '..') return true; 

    if (str.startsWith('[') && str.endsWith(']')) {
        const content = str.slice(1, -1);
        if (!content.includes('..')) return false; 
        const parts = content.split('..');
        if (parts.length !== 2) return false; 
        const [start, end] = parts;
        const validStart = !start || validateSimpleDate(start.trim());
        const validEnd = !end || validateSimpleDate(end.trim());
        return validStart && validEnd && (start || end); 
    }
    return validateSimpleDate(str);
}

function validateSimpleDate(str) {
    const match = str.match(/^(-?)([\dX]{4})(?:-([\dX]{2})(?:-([\dX]{2}))?)?([?~]+)?$/);
    if (!match) return false;
    const [, neg, year, month, day, suffix] = match;
    let isSeason = false;
    if (month) {
        if (!month.includes('X')) {
            const m = parseInt(month, 10);
            const isStandard = m >= 1 && m <= 12;
            isSeason = m >= 21 && m <= 24;
            if (!isStandard && !isSeason) return false;
        }
    }
    if (day) {
        if (isSeason) return false;
        if (!day.includes('X')) {
            const d = parseInt(day, 10);
            if (d < 1 || d > 31) return false;
            if (month && !month.includes('X')) {
                const m = parseInt(month, 10);
                const maxDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
                if (m <= 12 && d > maxDays[m]) return false;
            }
        }
    }
    return true;
}
