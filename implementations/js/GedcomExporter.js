import FTTParser from './FTTParser.js';

/**
 * GedcomExporter
 * Converts FamilyTree-Text v0.1 back to GEDCOM 5.5.1
 */
export default class GedcomExporter {
    constructor() {
        this.parser = new FTTParser();
        this.famCache = new Map(); // "ID1_ID2" -> { id: @F1@, ... }
        this.famCounter = 1;
        this.downgradeLog = []; // Stores audit warnings
    }

    convert(fttText) {
        // 1. Parse FTT
        const result = this.parser.parse(fttText);
        if (result.errors.length > 0) {
            throw new Error(`Cannot export invalid FTT: ${result.errors[0]}`);
        }

        const records = result.records;
        
        // 1b. Inject Implicit Placeholders
        // Scan for ?IDs that are referenced but not defined, and create records for them.
        this._injectImplicitPlaceholders(records);

        const output = [];

        // 2. Header
        output.push(`0 HEAD`);
        output.push(`1 SOUR FTT_CONVERTER`);
        output.push(`1 GEDC`);
        output.push(`2 VERS 5.5.1`);
        output.push(`2 FORM LINEAGE-LINKED`);
        output.push(`1 CHAR UTF-8`);

        // 3. Process Individuals & Build Family Cache
        for (const [id, rec] of Object.entries(records)) {
            if (rec.type === 'INDIVIDUAL' || rec.type === 'PLACEHOLDER') {
                this._writeIndividual(rec, output, records);
            } else if (rec.type === 'SOURCE') {
                this._writeSource(rec, output);
            } else if (rec.type === 'EVENT') {
                this._log(rec.id, 'Shared Event flattened to individual events (Linkage lost).');
            }
        }

        // 4. Process Families
        for (const fam of this.famCache.values()) {
            output.push(`0 ${fam.id} FAM`);
            if (fam.husb) output.push(`1 HUSB @${fam.husb}@`);
            if (fam.wife) output.push(`1 WIFE @${fam.wife}@`);
            fam.children.forEach(childId => {
                output.push(`1 CHIL @${childId}@`);
            });
            fam.events.forEach(evt => {
                if (evt.type === 'PART') {
                    output.push(`1 MARR`);
                    output.push(`2 TYPE Common Law / Partner`);
                    this._log(fam.id, `Union Type 'PART' exported as 'MARR' (Semantic downgrade).`);
                } else {
                    output.push(`1 ${evt.tag}`);
                }

                if (evt.date) output.push(`2 DATE ${evt.date}`);
                if (evt.reason === 'DIV') {
                    output.push(`1 DIV`);
                    if (evt.endDate) output.push(`2 DATE ${evt.endDate}`);
                }
            });
        }

        // 5. Append Audit Report
        if (this.downgradeLog.length > 0) {
            output.push('0 @NOTE_AUDIT@ NOTE');
            output.push('1 CONC ===================================================');
            output.push('1 CONT FTT -> GEDCOM DOWNGRADE REPORT');
            output.push('1 CONT ===================================================');
            output.push('1 CONT The following high-fidelity features were flattened:');
            this.downgradeLog.forEach(msg => {
                output.push(`1 CONT - ${msg}`);
            });
        }

        output.push('0 TRLR');
        return output.join('\n');
    }

    _injectImplicitPlaceholders(records) {
        const referenced = new Set();
        
        const collect = (id) => {
            if (id && id.startsWith('?') && !records[id]) {
                referenced.add(id);
            }
        };

        for (const rec of Object.values(records)) {
            if (rec.data.PARENT) rec.data.PARENT.forEach(p => collect(p.parsed[0]));
            if (rec.data.UNION) rec.data.UNION.forEach(u => collect(u.parsed[0]));
            if (rec.data.CHILD) rec.data.CHILD.forEach(c => collect(c.parsed[0]));
            if (rec.data.ASSOC) rec.data.ASSOC.forEach(a => collect(a.parsed[0]));
        }

        referenced.forEach(id => {
            records[id] = {
                id: id,
                type: 'PLACEHOLDER',
                data: {},
                line: 0 // Synthetic
            };
            this._log(id, 'Implicit placeholder converted to dummy INDI record.');
        });
    }

    // --- Writers ---

    _writeSource(rec, out) {
        const cleanId = rec.id.replace('^', '');
        out.push(`0 @${cleanId}@ SOUR`);
        const title = this._getField(rec, 'TITLE');
        if (title) out.push(`1 TITL ${title}`);
        const auth = this._getField(rec, 'AUTHOR');
        if (auth) out.push(`1 AUTH ${auth}`);
        
        // Export Notes
        if (rec.data.NOTES) {
            rec.data.NOTES.forEach(n => {
                this._writeNote(n.parsed[0], out, 1);
            });
        }
    }

    _writeIndividual(rec, out, allRecords) {
        out.push(`0 @${rec.id}@ INDI`);
        
        // Name Parsing
        if (rec.data.NAME) {
            rec.data.NAME.forEach(nameField => {
                const display = nameField.parsed[0] || 'Unknown';
                const sort = nameField.parsed[1] || '';
                const type = nameField.parsed[2] || '';

                let gedName = display;
                if (sort.includes(',')) {
                    const surname = sort.split(',')[0].trim();
                    if (display.includes(surname)) {
                        gedName = display.replace(surname, `/${surname}/`);
                    } else {
                        gedName = `${display} /${surname}/`;
                    }
                } else {
                    gedName = `${display} //`;
                }

                out.push(`1 NAME ${gedName}`);
                if (type) {
                    out.push(`2 TYPE ${type}`);
                }
            });
        } else if (rec.type === 'PLACEHOLDER') {
            out.push(`1 NAME Unknown /Placeholder/`);
        }

        // Placeholder Note
        if (rec.type === 'PLACEHOLDER') {
            out.push(`1 NOTE This is a synthesized placeholder record from FTT.`);
        }

        // Sex
        const sex = this._getField(rec, 'SEX');
        if (sex) out.push(`1 SEX ${sex}`);

        // Vital Events
        this._writeEvent(rec, 'BORN', 'BIRT', out);
        this._writeEvent(rec, 'DIED', 'DEAT', out);

        // Generic Inline Events
        this._writeEvent(rec, 'EVENT', 'EVEN', out);

        // Shared Events (EVENT_REF)
        if (rec.data.EVENT_REF) {
            rec.data.EVENT_REF.forEach(ref => {
                const evtId = ref.parsed[0];
                const sharedEvt = allRecords[evtId];
                if (sharedEvt) {
                    const type = this._getField(sharedEvt, 'TYPE') || 'EVENT';
                    const date = this._gedDate(this._getField(sharedEvt, 'START_DATE'));
                    
                    out.push(`1 EVEN`);
                    out.push(`2 TYPE ${type}`);
                    if (date) out.push(`2 DATE ${date}`);
                    out.push(`2 NOTE Shared Event Reference: ${evtId}`);
                }
            });
        }

        // Associate Export
        if (rec.data.ASSOC) {
            rec.data.ASSOC.forEach(assoc => {
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || 'ASSOCIATE';
                const startDate = assoc.parsed[2]; 
                const details = assoc.parsed[4]; 

                out.push(`1 ASSO @${targetId}@`);
                out.push(`2 RELA ${role}`);

                if (startDate) {
                    this._log(rec.id, `ASSOC to ${targetId}: Date '${startDate}' stripped (Not supported in GEDCOM ASSO).`);
                }

                if (details) {
                    out.push(`2 NOTE ${details}`);
                }
            });
        }

        // Export Notes
        if (rec.data.NOTES) {
            rec.data.NOTES.forEach(n => {
                this._writeNote(n.parsed[0], out, 1);
            });
        }

        // Family Linkage (Spouse)
        if (rec.data.UNION) {
            rec.data.UNION.forEach(u => {
                const partnerId = u.parsed[0];
                const type = u.parsed[1] || 'MARR';
                const date = this._gedDate(u.parsed[2]);
                const endDate = this._gedDate(u.parsed[3]);
                const reason = u.parsed[4];

                const fam = this._getFamily(rec.id, partnerId, allRecords);
                
                if (!fam.hasMarr) {
                    fam.events.push({ tag: 'MARR', date, endDate, reason, type });
                    fam.hasMarr = true;
                }
                out.push(`1 FAMS ${fam.id}`);
            });
        }

        // Family Linkage (Child)
        if (rec.data.PARENT) {
            // 1. Group parents by Relationship Type
            const groups = {};
            rec.data.PARENT.forEach(p => {
                const pid = p.parsed[0];
                const type = p.parsed[1] || 'BIO';
                if (!groups[type]) groups[type] = [];
                groups[type].push(pid);
            });

            // 2. Process each group
            for (const [type, pids] of Object.entries(groups)) {
                // Iterate in pairs (Standard Mom/Dad or single parents)
                // This ensures we catch ALL parents, not just the first 2 of the entire list.
                for (let i = 0; i < pids.length; i += 2) {
                    const p1 = pids[i];
                    const p2 = pids[i+1] || null;

                    const fam = this._getFamily(p1, p2, allRecords);
                    
                    // Link Child to Family
                    if (!fam.children.includes(rec.id)) {
                        fam.children.push(rec.id);
                    }
                    
                    // Write FAMC tag
                    out.push(`1 FAMC ${fam.id}`);

                    // Apply Relationship Type (PEDI)
                    if (type === 'ADO') {
                        out.push(`2 PEDI adopted`);
                    } else if (type === 'FOS') {
                        out.push(`2 PEDI foster`);
                    }
                }
            }
        }
    }

    _writeEvent(rec, fttKey, gedTag, out) {
        if (rec.data[fttKey]) {
            rec.data[fttKey].forEach(f => {
                out.push(`1 ${gedTag}`);

                // Generic events usually have TYPE as first param, Vitals have DATE.
                // We need to distinguish based on the fttKey.
                let dateIndex = 0;
                let placeIndex = 1;
                let typeIndex = -1;

                if (fttKey === 'EVENT') {
                    // EVENT: TYPE | DATE | END | PLACE
                    typeIndex = 0;
                    dateIndex = 1;
                    placeIndex = 3;
                    
                    const type = f.parsed[typeIndex];
                    if (type) out.push(`2 TYPE ${type}`);
                }
                
                const date = this._gedDate(f.parsed[dateIndex]);
                if (date) out.push(`2 DATE ${date}`);
                
                const place = f.parsed[placeIndex];
                if (place) {
                    out.push(`2 PLAC ${place.replace(/;\s*/g, ', ')}`);
                    
                    if (f.metadata && f.metadata.coords) {
                        const [lat, long] = f.metadata.coords.split(',').map(s => s.trim());
                        if (lat && long) {
                            out.push(`3 MAP`);
                            out.push(`4 LATI ${lat}`);
                            out.push(`4 LONG ${long}`);
                        }
                    }

                    if (f.metadata && f.metadata.geo) {
                        out.push(`3 NOTE Standardized/Modern Place: ${f.metadata.geo.replace(/;\s*/g, ', ')}`);
                    }
                }

                // Citations & Notes
                if (f.modifiers) {
                    for (const [modKey, mods] of Object.entries(f.modifiers)) {
                        if (modKey.endsWith('_SRC')) {
                            mods.forEach(m => {
                                const srcId = m.parsed[0].replace('^', '');
                                out.push(`2 SOUR @${srcId}@`);
                                const page = m.parsed[1];
                                if(page) out.push(`3 PAGE ${page}`);
                            });
                        }
                        if (modKey.endsWith('_NOTE')) {
                            mods.forEach(m => {
                                this._writeNote(m.parsed[0], out, 2);
                            });
                        }
                    }
                }
            });
        }
    }

    // --- Helpers ---

    _writeNote(text, out, level) {
        if (!text) return;
        const lines = text.split('\n');
        out.push(`${level} NOTE ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
            out.push(`${level + 1} CONT ${lines[i]}`);
        }
    }

    _log(id, msg) {
        this.downgradeLog.push(`[${id}] ${msg}`);
    }

    _getField(rec, key) {
        if (rec.data[key] && rec.data[key][0]) {
            return rec.data[key][0].parsed[0];
        }
        return null;
    }

    _getFamily(p1, p2, allRecords) {
        const ids = [p1, p2].filter(x => x).sort();
        const key = ids.join('_');

        if (this.famCache.has(key)) {
            return this.famCache.get(key);
        }

        const famId = `@F${this.famCounter++}@`;
        const famObj = { 
            id: famId, 
            husb: null, 
            wife: null, 
            children: [], 
            events: [],
            hasMarr: false
        };
        ids.forEach(pid => {
            const prec = allRecords[pid];
            const sex = (prec && prec.data.SEX && prec.data.SEX[0]) 
                ? prec.data.SEX[0].parsed[0] 
                : 'U';

            if (sex === 'M' && !famObj.husb) famObj.husb = pid;
            else if (sex === 'F' && !famObj.wife) famObj.wife = pid;
            else {
                if (!famObj.husb) famObj.husb = pid;
                else famObj.wife = pid;
            }
        });

        this.famCache.set(key, famObj);
        return famObj;
    }

    _gedDate(fttDate) {
        if (!fttDate) return null;
        const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        
        const isoMatch = fttDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
            return `${parseInt(isoMatch[3])} ${months[parseInt(isoMatch[2])-1]} ${isoMatch[1]}`;
        }
        
        const monthMatch = fttDate.match(/^(\d{4})-(\d{2})$/);
        if (monthMatch) {
             return `${months[parseInt(monthMatch[2])-1]} ${monthMatch[1]}`;
        }
        
        if (/^\d{4}$/.test(fttDate)) return fttDate;

        if (fttDate.endsWith('~') || fttDate.endsWith('?')) {
            return `ABT ${fttDate.replace(/[~?]/g, '')}`;
        }
        
        const rangeMatch = fttDate.match(/^\[(.*?)\.\.(.*?)\]$/);
        if (rangeMatch) {
            const start = rangeMatch[1].trim();
            const end = rangeMatch[2].trim();
            
            if (!start && end) return `BEF ${end}`;
            if (start && !end) return `AFT ${start}`;
            return `BET ${start} AND ${end}`;
        }

        return fttDate;
    }
}
