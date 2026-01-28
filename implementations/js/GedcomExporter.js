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
            if (rec.type === 'INDIVIDUAL') {
                this._writeIndividual(rec, output, records);
            } else if (rec.type === 'PLACEHOLDER') {
                // GEDCOM requires explicit records for placeholders
                this._writePlaceholder(rec, output);
                this._log(rec.id, 'Placeholder converted to dummy INDI record.');
            } else if (rec.type === 'SOURCE') {
                this._writeSource(rec, output);
            } else if (rec.type === 'EVENT') {
                // Shared Events cannot be exported as root records in GEDCOM.
                // They are handled by flattening inside _writeIndividual.
                // We log this structural loss here once.
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
                // Handle Union Semantics Downgrade
                if (evt.type === 'PART') {
                    // Export as MARR with TYPE to preserve some meaning, but strictly it's a semantic loss
                    output.push(`1 MARR`);
                    output.push(`2 TYPE Common Law / Partner`);
                    this._log(fam.id, `Union Type 'PART' exported as 'MARR' (Semantic downgrade).`);
                } else {
                    output.push(`1 ${evt.tag}`);
                }

                if (evt.date) output.push(`2 DATE ${evt.date}`);
                if (evt.reason === 'DIV') {
                    output.push(`1 DIV`);
                    // If an end date exists, attach it to the Divorce event
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

    // --- Writers ---

    _writeSource(rec, out) {
        const cleanId = rec.id.replace('^', '');
        out.push(`0 @${cleanId}@ SOUR`);
        const title = this._getField(rec, 'TITLE');
        if (title) out.push(`1 TITL ${title}`);
        const auth = this._getField(rec, 'AUTHOR');
        if (auth) out.push(`1 AUTH ${auth}`);
    }

    _writePlaceholder(rec, out) {
        // Create a dummy record so pointers remain valid
        // FTT ?UNK-FATHER -> GEDCOM @UNK-FATHER@
        out.push(`0 @${rec.id}@ INDI`);
        out.push(`1 NAME Unknown /Placeholder/`);
        out.push(`1 NOTE This is a synthesized placeholder record from FTT.`);
    }

    _writeIndividual(rec, out, allRecords) {
        out.push(`0 @${rec.id}@ INDI`);

        // Name Parsing
        if (rec.data.NAME) {
            const nameField = rec.data.NAME[0];
            const display = nameField.parsed[0] || 'Unknown';
            const sort = nameField.parsed[1] || '';
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
        }

        // Sex
        const sex = this._getField(rec, 'SEX');
        if (sex) out.push(`1 SEX ${sex}`);

        // Vital Events
        this._writeEvent(rec, 'BORN', 'BIRT', out);
        this._writeEvent(rec, 'DIED', 'DEAT', out);

        // Shared Events (EVENT_REF) - Flattening Logic
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

        // --- Associate Export (Best Effort) ---
        if (rec.data.ASSOC) {
            rec.data.ASSOC.forEach(assoc => {
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || 'ASSOCIATE';
                const startDate = assoc.parsed[2]; // FTT allows dates
                const details = assoc.parsed[4];   // FTT allows details

                // Basic Linkage
                out.push(`1 ASSO @${targetId}@`);
                out.push(`2 RELA ${role}`);

                // Handle Data Loss
                // GEDCOM 5.5.1 ASSO does not support DATE. We must log this.
                if (startDate) {
                    this._log(rec.id, `ASSOC to ${targetId}: Date '${startDate}' stripped (Not supported in GEDCOM ASSO).`);
                }

                // Map Details to Note
                if (details) {
                    out.push(`2 NOTE ${details}`);
                }
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
            const parents = rec.data.PARENT.map(p => p.parsed[0]);
            if (parents.length > 0) {
                const fam = this._getFamily(parents[0], parents[1] || null, allRecords);
                if (!fam.children.includes(rec.id)) {
                    fam.children.push(rec.id);
                }
                out.push(`1 FAMC ${fam.id}`);
            }
        }
    }

    _writeEvent(rec, fttKey, gedTag, out) {
        if (rec.data[fttKey]) {
            const f = rec.data[fttKey][0];
            out.push(`1 ${gedTag}`);
            
            const date = this._gedDate(f.parsed[0]);
            if (date) out.push(`2 DATE ${date}`);
            
            const place = f.parsed[1];
            if (place) {
                // FTT: "City; Country" -> GED: "City, Country"
                out.push(`2 PLAC ${place.replace(/;/g, ',')}`);
                
                // CHECK FOR METADATA LOSS (Geocoding/Coordinates)
                if (f.metadata && (f.metadata.geo || f.metadata.coords)) {
                    // 5.5.1 has MAP.LATI/LONG but strictly for PLAC structures.
                    // Simple exporters often skip this complexity.
                    // We log the loss of high-fidelity geodata.
                    this._log(rec.id, `${fttKey}: Coordinates/Historical name for '${place}' stripped.`);
                }
            }

            // Citations
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
                }
            }
        }
    }

    // --- Helpers ---

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
            // Treat placeholders as Unknown sex for safety
            const sex = (prec && prec.type !== 'PLACEHOLDER' && prec.data.SEX) 
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
        
        // ISO to GEDCOM conversion
        const isoMatch = fttDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
            return `${parseInt(isoMatch[3])} ${months[parseInt(isoMatch[2])-1]} ${isoMatch[1]}`;
        }
        
        const monthMatch = fttDate.match(/^(\d{4})-(\d{2})$/);
        if (monthMatch) {
             return `${months[parseInt(monthMatch[2])-1]} ${monthMatch[1]}`;
        }
        
        if (/^\d{4}$/.test(fttDate)) return fttDate;
        
        // Handle '?' suffix (Uncertain) same as '~' (Approx)
        if (fttDate.endsWith('~') || fttDate.endsWith('?')) {
            return `ABT ${fttDate.replace(/[~?]/g, '')}`;
        }
        
        // FTT [A..B] is a "Window". GEDCOM BET A AND B implies roughly the same.
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
