import FTTParser from './FTTParser.js';

/**
 * GedcomExporter
 * Converts FamilyTree-Text v0.1 back to GEDCOM 5.5.1
 */
export default class GedcomExporter {
    constructor() {
        this.parser = new FTTParser();
        this.famCache = new Map(); // Key: "ID1_ID2" -> { id: @F1@, husb: ID, wife: ID, children: [], events: [] }
        this.famCounter = 1;
    }

    convert(fttText) {
        // 1. Parse the FTT
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
            if (rec.type === 'INDIVIDUAL' || rec.type === 'PLACEHOLDER') {
                this._writeIndividual(rec, output, records);
            } else if (rec.type === 'SOURCE') {
                this._writeSource(rec, output);
            }
        }

        // 4. Process the synthesized Families
        for (const fam of this.famCache.values()) {
            output.push(`0 ${fam.id} FAM`);
            if (fam.husb) output.push(`1 HUSB @${fam.husb}@`);
            if (fam.wife) output.push(`1 WIFE @${fam.wife}@`);
            
            // Add Children
            fam.children.forEach(childId => {
                output.push(`1 CHIL @${childId}@`);
            });

            // Add Events (Marriage)
            fam.events.forEach(evt => {
                output.push(`1 ${evt.tag}`);
                if (evt.date) output.push(`2 DATE ${evt.date}`);
                if (evt.reason === 'DIV') output.push(`1 DIV`); // Handle divorce flag
            });
        }

        output.push('0 TRLR');
        return output.join('\n');
    }

    // --- Writers ---

    _writeSource(rec, out) {
        // Strip ^ sigil for GEDCOM internal ID
        const cleanId = rec.id.replace('^', '');
        out.push(`0 @${cleanId}@ SOUR`);
        
        const title = this._getField(rec, 'TITLE');
        if (title) out.push(`1 TITL ${title}`);
        
        const auth = this._getField(rec, 'AUTHOR');
        if (auth) out.push(`1 AUTH ${auth}`);
    }

    _writeIndividual(rec, out, allRecords) {
        out.push(`0 @${rec.id}@ INDI`);

        // Name Parsing: "John Smith | Smith, John" -> "John /Smith/"
        if (rec.data.NAME) {
            const nameField = rec.data.NAME[0];
            const display = nameField.parsed[0] || 'Unknown';
            const sort = nameField.parsed[1] || '';
            
            let gedName = display;
            if (sort.includes(',')) {
                const surname = sort.split(',')[0].trim();
                // Replace surname in display string with slashed version
                // Regex: Find the surname in the display string and wrap it
                // Simple approach: append it if complex match fails
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

        // --- Logic: Populate Family Cache ---

        // 1. As a Spouse (UNION)
        if (rec.data.UNION) {
            rec.data.UNION.forEach(u => {
                const partnerId = u.parsed[0];
                const type = u.parsed[1]; // MARR
                const date = this._gedDate(u.parsed[2]);
                const reason = u.parsed[4]; // DIV

                // Get or Create Family Hub
                const fam = this._getFamily(rec.id, partnerId, allRecords);
                
                // Add Marriage Event to the Family (only once)
                if (!fam.hasMarr) {
                    fam.events.push({ tag: 'MARR', date, reason });
                    fam.hasMarr = true;
                }
                
                // Link Self to Family
                out.push(`1 FAMS ${fam.id}`);
            });
        }

        // 2. As a Child (PARENT)
        if (rec.data.PARENT) {
            // Group parents to find the single family they belong to
            // FTT allows multiple parents. We group them by 2s.
            const parents = rec.data.PARENT.map(p => p.parsed[0]);
            
            if (parents.length > 0) {
                // If 2 parents, find their shared family. 
                // If 1 parent, find their single-parent family or create one.
                const p1 = parents[0];
                const p2 = parents[1] || null;

                const fam = this._getFamily(p1, p2, allRecords);
                
                // Add self as child
                if (!fam.children.includes(rec.id)) {
                    fam.children.push(rec.id);
                }

                // Link Self to Family
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
            }

            // Citations
            // Look for Modifiers ending in _SRC on this specific field
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

    _getField(rec, key) {
        if (rec.data[key] && rec.data[key][0]) {
            return rec.data[key][0].parsed[0];
        }
        return null;
    }

    _getFamily(p1, p2, allRecords) {
        // Sort IDs to ensure A+B and B+A return the same family
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

        // Assign HUSB/WIFE based on SEX
        ids.forEach(pid => {
            const prec = allRecords[pid];
            const sex = prec && prec.data.SEX ? prec.data.SEX[0].parsed[0] : 'U';
            if (sex === 'M' && !famObj.husb) famObj.husb = pid;
            else if (sex === 'F' && !famObj.wife) famObj.wife = pid;
            else {
                // Fallback for Unknown/Same-sex
                if (!famObj.husb) famObj.husb = pid;
                else famObj.wife = pid;
            }
        });

        this.famCache.set(key, famObj);
        return famObj;
    }

    _gedDate(fttDate) {
        if (!fttDate) return null;
        
        // 1. Exact ISO: 1900-05-12 -> 12 MAY 1900
        const isoMatch = fttDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
            const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
            return `${parseInt(isoMatch[3])} ${months[parseInt(isoMatch[2])-1]} ${isoMatch[1]}`;
        }

        // 2. Year Only: 1900
        if (/^\d{4}$/.test(fttDate)) return fttDate;

        // 3. Approx: 1900~ -> ABT 1900
        if (fttDate.endsWith('~')) {
            return `ABT ${fttDate.replace('~', '')}`;
        }

        // 4. Interval: [1900..1910] -> BET 1900 AND 1910
        const rangeMatch = fttDate.match(/^\[(.*?)\.\.(.*?)\]$/);
        if (rangeMatch) {
            return `BET ${rangeMatch[1]} AND ${rangeMatch[2]}`;
        }

        return fttDate;
    }
}
