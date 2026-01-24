/**
 * FamilyTree-Text (FTT) Reference Parser v0.1
 * Usage:
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
     * Creates a fresh session for every parse to ensure no shared state side-effects.
     * @param {string} rawText - The UTF-8 file content.
     * @returns {object} - { headers, records, errors, warnings }
     */
    parse(rawText) {
        const session = new ParseSession(this.SUPPORTED_VERSION);
        return session.run(rawText);
    }
}

/**
 * Internal Class: Encapsulates the state of a single parse operation.
 */
class ParseSession {
    constructor(version) {
        this.SUPPORTED_VERSION = version;

        // Output Data
        this.headers = {};
        this.records = new Map(); // Map<ID, RecordObject>
        this.ids = new Set(); // Fast lookup for existence
        this.errors = []; // Critical Validation Errors
        this.warnings = []; // Consistency Warnings & Notices

        // Internal Parsing State
        this.currentRecordId = null;
        this.currentKey = null;
        this.buffer = []; // Line buffer for multi-line content
        this.lastFieldRef = null; // Pointer to the last created field object
        this.currentModifierTarget = null;
    }

    run(rawText) {
        // Normalize line endings and split
        const lines = rawText.replace(/\r\n/g, '\n').split('\n');

        for (let i = 0; i < lines.length; i++) {
            this._processLine(lines[i], i + 1);
        }

        // Flush final buffer
        this._flushBuffer();

        // Post-Processing
        this._postProcess();

        // Post-Parse Validation (Section 8.3)
        this._validateGraph();

        return {
            headers: this.headers,
            records: Object.fromEntries(this.records),
            errors: this.errors,
            warnings: this.warnings
        };
    }

    // =========================================================================
    // 1. Line Processing Logic
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
                this._error(`Line ${lineNum}: Indented content without a preceding key.`);
                return;
            }

            const content = line.substring(2);

            // Space Folding Rule
            if (this.buffer.length > 0 && this.buffer[this.buffer.length - 1] !== '\n') {
                this.buffer.push(' ');
            }
            this.buffer.push(content);
            return;
        }

        // 4. Blank Line Check (Paragraph Break)
        if (!line.trim()) {
            if (this.currentKey) {
                this.buffer.push('\n');
            }
            return;
        }

        // 5. New Key Detection (Column 0)
        const keyMatch = line.match(KEY_PATTERN);
        if (keyMatch) {
            this._flushBuffer(); // Terminate previous block
            this._handleNewKey(keyMatch[1], keyMatch[2] || '', lineNum);
            return;
        }

        // 6. Fall-through (Syntax Error)
        this._error(`Line ${lineNum}: Invalid syntax at Column 0. Expected Key or Indentation.`);
    }

    // =========================================================================
    // 2. Key Handling & Modifier Logic
    // =========================================================================

    _handleNewKey(key, inlineValue, lineNum) {
        this.currentKey = key;
        if (inlineValue) this.buffer.push(inlineValue);

        // Global Headers
        if (key.startsWith('HEAD_')) {
            if (this.currentRecordId) {
                this._error(`Line ${lineNum}: Header ${key} found inside a record block.`);
            }
            this.headers[key] = inlineValue.trim().normalize('NFC');
            return;
        }

        // Record ID
        if (key === 'ID') {
            const id = inlineValue.trim().normalize('NFC');
            this._validateID(id, lineNum);

            if (this.records.has(id)) {
                this._error(`Line ${lineNum}: Duplicate Record ID "${id}". Ignoring definition.`);
                this.currentRecordId = null;
                return;
            }

            this.currentRecordId = id;
            this.records.set(id, {
                id: id,
                type: this._determineRecordType(id),
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
                this._createField(record, key);
            }
        } else {
            this._error(`Line ${lineNum}: Key ${key} found outside of a record block.`);
        }
    }

    _createField(record, key) {
        if (!record.data[key]) {
            record.data[key] = [];
        }

        const newFieldObj = {
            raw: '',
            parsed: [],
            modifiers: {}
        };

        record.data[key].push(newFieldObj);
        this.lastFieldRef = {
            key: key,
            obj: newFieldObj
        };
    }

    _attachModifier(record, modKey, lineNum) {
        const baseKey = modKey.replace(/_(SRC|NOTE)$/, '');

        if (!this.lastFieldRef || this.lastFieldRef.key !== baseKey) {
            this._error(`Line ${lineNum}: Modifier ${modKey} does not immediately follow a ${baseKey} field.`);
            return;
        }

        if (!this.lastFieldRef.obj.modifiers[modKey]) {
            this.lastFieldRef.obj.modifiers[modKey] = [];
        }

        const modObj = {
            raw: ''
        };
        this.lastFieldRef.obj.modifiers[modKey].push(modObj);
        this.currentModifierTarget = modObj;
    }

    // =========================================================================
    // 3. Buffer Flushing & Parsing
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
                            this._warning(`Consistency Warning: Union between ${id} and ${partnerId} conflict at index ${i} ("${valA}" vs "${valB}").`);
                        }
                    }
                } else {
                    // Inject implicit union
                    if (!partnerRecord.data['UNION']) {
                        partnerRecord.data['UNION'] = [];
                    }
                    const implicitParsed = [...unionField.parsed];
                    implicitParsed[0] = id;

                    partnerRecord.data['UNION'].push({
                        raw: `(Implicit Reciprocal of ${id})`,
                        parsed: implicitParsed,
                        modifiers: {}
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
    // 5. Validation & Types
    // =========================================================================

    _determineRecordType(id) {
        if (id.startsWith('^')) return 'SOURCE';
        if (id.startsWith('&')) return 'EVENT';
        if (id.startsWith('?')) return 'PLACEHOLDER';
        return 'INDIVIDUAL';
    }

    _validateID(id, lineNum) {
        if (/[\s|;\p{C}]/u.test(id)) {
            this._error(`Line ${lineNum}: ID "${id}" contains forbidden characters.`);
            return;
        }

        const firstChar = id.charAt(0);
        if (!['^', '&', '?'].includes(firstChar)) {
            if (!STANDARD_ID_PATTERN.test(id)) {
                this._error(`Line ${lineNum}: Invalid Standard ID "${id}".`);
            }
        }
    }

    _validateGraph() {
        const formatHeader = this.headers['HEAD_FORMAT'];
        if (!formatHeader) {
            this._error('Missing Header: HEAD_FORMAT');
        } else {
            const match = formatHeader.match(/v(\d+(\.\d+)?)/);
            if (match && parseFloat(match[1]) > this.SUPPORTED_VERSION) {
                this._error(`Version Error: File (v${match[1]}) > Supported (v${this.SUPPORTED_VERSION}).`);
            }
        }

        // 1. Dangling Reference Check
        this.records.forEach((record) => this._checkReferences(record));

        // 2. Ghost Child Check
        this.records.forEach((record, parentId) => {
            if (record.data['CHILD']) {
                record.data['CHILD'].forEach(childField => {
                    const childId = childField.parsed[0];
                    if (!childId || childId.startsWith('?')) return;

                    const childRecord = this.records.get(childId);
                    if (!childRecord) return;

                    const pointsBack = childRecord.data['PARENT']?.some(p => p.parsed[0] === parentId);
                    if (!pointsBack) {
                        this._error(`Ghost Child Error: ${parentId} -> ${childId} (Missing PARENT link).`);
                    }
                });
            }
        });

        // 3. Cycle Detection
        const visited = new Set();
        const recursionStack = new Set();

        const detectCycle = (currId) => {
            if (recursionStack.has(currId)) return true;
            if (visited.has(currId)) return false;

            visited.add(currId);
            recursionStack.add(currId);

            const record = this.records.get(currId);
            if (record && record.data['PARENT']) {
                for (const pField of record.data['PARENT']) {
                    const parentId = pField.parsed[0];
                    if (parentId && !parentId.startsWith('?') && this.records.has(parentId)) {
                        if (detectCycle(parentId)) {
                            this._error(`Circular Lineage: ${currId} <-> ${parentId}`);
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

        // 4. Vocabulary & Date Validation
        this._validateVocabulary();
        this._validateDates();
    }

    _validateVocabulary() {
        // 1. Parent/Child Types
        const VALID_PARENT_TYPES = new Set(['BIO', 'ADO', 'STE', 'FOS', 'UNK']);

        // 2. Union Types
        const VALID_UNION_TYPES = new Set(['MARR', 'PART', 'UNK']);
        const VALID_UNION_REASONS = new Set(['DIV', 'SEP', 'WID', 'ANN']);

        // 3. Name Types & Status
        const VALID_NAME_TYPES = new Set(['BIRTH', 'MARR', 'AKA', 'NICK', 'PROF', 'REL', 'UNK']);
        const VALID_NAME_STATUS = new Set(['PREF']);

        // 4. Associate Roles
        const VALID_ASSOC_ROLES = new Set([
            'GODP', 'GODC', 'SPON', 'OFFI', // Religious
            'WITN', 'EXEC', 'GUAR', 'WARD', 'INFO', // Legal
            'MAST', 'APPR', 'SERV', 'NEIG', 'ENSL', 'OWNR' // Social
        ]);

        for (const record of this.records.values()) {
            // Parent Checks
            record.data['PARENT']?.forEach(f => {
                const type = (f.parsed[1] || '').trim();
                if (type && !VALID_PARENT_TYPES.has(type)) {
                    this._error(`Invalid PARENT Type "${type}" in ${record.id}`);
                }
            });

            // Union Checks
            record.data['UNION']?.forEach(f => {
                const type = (f.parsed[1] || '').trim();
                const reason = (f.parsed[4] || '').trim();
                if (type && !VALID_UNION_TYPES.has(type)) {
                    this._error(`Invalid UNION Type "${type}" in ${record.id}`);
                }
                if (reason && !VALID_UNION_REASONS.has(reason)) {
                    this._error(`Invalid UNION Reason "${reason}" in ${record.id}`);
                }
            });

            // Name Checks (Advisory)
            record.data['NAME']?.forEach(f => {
                const type = (f.parsed[2] || '').trim();
                const status = (f.parsed[3] || '').trim();

                if (type && !VALID_NAME_TYPES.has(type)) {
                    this._warning(`Vocabulary Notice: Non-standard NAME Type "${type}" in record ${record.id}.`);
                }
                if (status && !VALID_NAME_STATUS.has(status)) {
                    this._error(`Vocabulary Error: Invalid NAME Status "${status}" in record ${record.id}.`);
                }
            });

            // Assoc Checks (Advisory)
            record.data['ASSOC']?.forEach(f => {
                const role = (f.parsed[1] || '').trim();
                if (role && !VALID_ASSOC_ROLES.has(role)) {
                    this._warning(`Vocabulary Notice: Non-standard ASSOC Role "${role}" in record ${record.id}.`);
                }
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

        if (this.headers['HEAD_DATE'] && !DATE_PATTERN.test(this.headers['HEAD_DATE'])) {
            this._error(`Invalid HEAD_DATE: "${this.headers['HEAD_DATE']}"`);
        }

        for (const record of this.records.values()) {
            for (const [key, fields] of Object.entries(record.data)) {
                if (DATE_KEYS[key]) {
                    const indicesToCheck = DATE_KEYS[key];
                    fields.forEach(field => {
                        indicesToCheck.forEach(idx => {
                            if (field.parsed.length > idx) {
                                const dateVal = field.parsed[idx];
                                if (dateVal && !DATE_PATTERN.test(dateVal)) {
                                    this._error(`Invalid Date "${dateVal}" in ${record.id} (${key})`);
                                }
                            }
                        });
                    });
                }
            }
        }
    }

    _checkReferences(record) {
        const refKeys = ['PARENT', 'CHILD', 'UNION', 'ASSOC', 'SRC', 'EVENT_REF'];
        refKeys.forEach(key => {
            record.data[key]?.forEach(field => {
                const targetId = field.parsed[0];
                if (targetId && !this._idExists(targetId)) {
                    this._error(`Dangling Reference: ${record.id} -> ${targetId} (${key})`);
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
                                this._error(`Dangling Citation: ${record.id} -> ${srcId} (${modKey})`);
                            }
                        });
                    }
                }
            });
        });
    }

    _idExists(id) {
        if (id.startsWith('?')) return true;
        return this.ids.has(id);
    }

    _error(msg) {
        this.errors.push(msg);
    }
    _warning(msg) {
        this.warnings.push(msg);
    }
}
