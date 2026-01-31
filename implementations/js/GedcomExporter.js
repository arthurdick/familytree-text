import FTTParser from "./FTTParser.js";

/**
 * GedcomExporter
 * Converts FamilyTree-Text v0.1 back to GEDCOM 5.5.1
 */
export default class GedcomExporter {
    constructor() {
        this.parser = new FTTParser();
        this.famCache = new Map(); // "ID1|ID2" -> { id: @F1@, ... }
        this.famCounter = 1;
        this.downgradeLog = []; // Stores audit warnings
    }

    /**
     * @param {string} fttText
     * @param {boolean} privacyEnabled - If true, enforces Appendix D privacy rules
     */
    convert(fttText, privacyEnabled = false) {
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
        for (const [, rec] of Object.entries(records)) {
            // Apply Privacy: Skip PRIVATE records entirely
            if (privacyEnabled) {
                const privacy = this._getField(rec, "PRIVACY");
                if (privacy === "PRIVATE") continue;
            }

            if (rec.type === "INDIVIDUAL" || rec.type === "PLACEHOLDER") {
                this._writeIndividual(rec, output, records, privacyEnabled);
            } else if (rec.type === "SOURCE") {
                this._writeSource(rec, output);
            } else if (rec.type === "EVENT") {
                this._log(rec.id, "Shared Event flattened to individual events (Linkage lost).");
            }
        }

        // 4. Process Families
        for (const fam of this.famCache.values()) {
            output.push(`0 ${fam.id} FAM`);

            fam.husbs.forEach((h) => output.push(`1 HUSB @${h}@`));
            fam.wives.forEach((w) => output.push(`1 WIFE @${w}@`));

            fam.children.forEach((childId) => {
                output.push(`1 CHIL @${childId}@`);
            });
            fam.events.forEach((evt) => {
                // If privacy is enabled, we need to check if we should mask Family Events.
                // Spec implies masking marriage dates/places for Living people.
                // Since Family events are shared, if one partner is Living, we usually mask.
                // For simplicity, if privacyEnabled is passed, we mask dates/places on family events too.
                // However, detailed logic requires checking the privacy status of partners.
                // We'll mask if privacyEnabled is true to be safe.
                const shouldMask = privacyEnabled;

                if (evt.type === "PART") {
                    output.push(`1 MARR`);
                    output.push(`2 TYPE Common Law / Partner`);
                    this._log(fam.id, `Union Type 'PART' exported as 'MARR' (Semantic downgrade).`);
                } else {
                    output.push(`1 ${evt.tag}`);
                }

                if (!shouldMask) {
                    if (evt.date) output.push(`2 DATE ${evt.date}`);
                    if (evt.reason === "DIV") {
                        output.push(`1 DIV`);
                        if (evt.endDate) output.push(`2 DATE ${evt.endDate}`);
                    }
                } else {
                    // Privacy Mode: Mask dates
                    // (Optional: output.push('2 NOTE Private'))
                }
            });
        }

        // 5. Append Audit Report
        if (this.downgradeLog.length > 0) {
            output.push("0 @NOTE_AUDIT@ NOTE");
            output.push("1 CONC ===================================================");
            output.push("1 CONT FTT -> GEDCOM DOWNGRADE REPORT");
            output.push("1 CONT ===================================================");
            output.push("1 CONT The following high-fidelity features were flattened:");
            this.downgradeLog.forEach((msg) => {
                output.push(`1 CONT - ${msg}`);
            });
        }

        output.push("0 TRLR");
        return output.join("\n");
    }

    _injectImplicitPlaceholders(records) {
        const referenced = new Set();

        const collect = (id) => {
            if (id && id.startsWith("?") && !records[id]) {
                referenced.add(id);
            }
        };

        for (const rec of Object.values(records)) {
            if (rec.data.PARENT) rec.data.PARENT.forEach((p) => collect(p.parsed[0]));
            if (rec.data.UNION) rec.data.UNION.forEach((u) => collect(u.parsed[0]));
            if (rec.data.CHILD) rec.data.CHILD.forEach((c) => collect(c.parsed[0]));
            if (rec.data.ASSOC) rec.data.ASSOC.forEach((a) => collect(a.parsed[0]));
        }

        referenced.forEach((id) => {
            records[id] = {
                id: id,
                type: "PLACEHOLDER",
                data: {},
                line: 0 // Synthetic
            };
            this._log(id, "Implicit placeholder converted to dummy INDI record.");
        });
    }

    // --- Writers ---

    _writeSource(rec, out) {
        const cleanId = rec.id.replace("^", "");
        out.push(`0 @${cleanId}@ SOUR`);
        const title = this._getField(rec, "TITLE");
        if (title) out.push(`1 TITL ${title}`);
        const auth = this._getField(rec, "AUTHOR");
        if (auth) out.push(`1 AUTH ${auth}`);

        // Export Notes
        if (rec.data.NOTES) {
            rec.data.NOTES.forEach((n) => {
                this._writeNote(n.parsed[0], out, 1);
            });
        }
    }

    _writeIndividual(rec, out, allRecords, privacyEnabled) {
        out.push(`0 @${rec.id}@ INDI`);

        const privacyStatus = this._getField(rec, "PRIVACY");
        const isLiving = privacyStatus === "LIVING";
        const shouldMask = privacyEnabled && isLiving;

        // Name Parsing
        if (rec.data.NAME) {
            rec.data.NAME.forEach((nameField) => {
                const display = nameField.parsed[0] || "Unknown";
                const sort = nameField.parsed[1] || "";
                const type = nameField.parsed[2] || "";
                const status = nameField.parsed[3] || "";

                // Privacy: Show only Preferred Name
                if (shouldMask && status !== "PREF" && rec.data.NAME.length > 1) {
                    // If multiple names exist and this isn't preferred, skip it.
                    // If no name is marked PREF, we might just output the first one.
                    const hasPref = rec.data.NAME.some((n) => n.parsed[3] === "PREF");
                    if (hasPref) return;
                }

                let gedName = display;
                if (sort.includes(",")) {
                    const surname = sort.split(",")[0].trim();
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
        } else if (rec.type === "PLACEHOLDER") {
            out.push(`1 NAME Unknown /Placeholder/`);
        }

        // Placeholder Note
        if (rec.type === "PLACEHOLDER") {
            out.push(`1 NOTE This is a synthesized placeholder record from FTT.`);
        }

        // Sex
        const sex = this._getField(rec, "SEX");
        if (sex) out.push(`1 SEX ${sex}`);

        // Vital Events (Masked if Living)
        this._writeEvent(rec, "BORN", "BIRT", out, shouldMask);
        this._writeEvent(rec, "DIED", "DEAT", out, shouldMask);

        // Generic Inline Events (Masked if Living)
        this._writeEvent(rec, "EVENT", "EVEN", out, shouldMask);

        // Shared Events (Masked if Living)
        if (rec.data.EVENT_REF) {
            rec.data.EVENT_REF.forEach((ref) => {
                const evtId = ref.parsed[0];
                const sharedEvt = allRecords[evtId];
                if (sharedEvt) {
                    const type = this._getField(sharedEvt, "TYPE") || "EVENT";
                    const date = this._gedDate(this._getField(sharedEvt, "START_DATE"));

                    out.push(`1 EVEN`);
                    out.push(`2 TYPE ${type}`);

                    if (!shouldMask) {
                        if (date) out.push(`2 DATE ${date}`);
                        out.push(`2 NOTE Shared Event Reference: ${evtId}`);
                    }
                }
            });
        }

        // Associate Export
        if (rec.data.ASSOC) {
            rec.data.ASSOC.forEach((assoc) => {
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || "ASSOCIATE";
                const startDate = assoc.parsed[2];
                const details = assoc.parsed[4];

                out.push(`1 ASSO @${targetId}@`);
                out.push(`2 RELA ${role}`);

                if (startDate) {
                    this._log(
                        rec.id,
                        `ASSOC to ${targetId}: Date '${startDate}' stripped (Not supported in GEDCOM ASSO).`
                    );
                }

                if (details && !shouldMask) {
                    out.push(`2 NOTE ${details}`);
                }
            });
        }

        // Export Notes (Skipped if Living to protect sensitive bio)
        if (!shouldMask && rec.data.NOTES) {
            rec.data.NOTES.forEach((n) => {
                this._writeNote(n.parsed[0], out, 1);
            });
        }

        // Family Linkage (Spouse) - Links are preserved even if Living
        if (rec.data.UNION) {
            rec.data.UNION.forEach((u) => {
                const partnerId = u.parsed[0];
                const type = u.parsed[1] || "MARR";
                const date = this._gedDate(u.parsed[2]);
                const endDate = this._gedDate(u.parsed[3]);
                const reason = u.parsed[4];

                const fam = this._getFamily(rec.id, partnerId, allRecords);

                if (!fam.hasMarr) {
                    fam.events.push({ tag: "MARR", date, endDate, reason, type });
                    fam.hasMarr = true;
                }
                out.push(`1 FAMS ${fam.id}`);
            });
        }

        // Family Linkage (Child) - Links are preserved even if Living
        if (rec.data.PARENT) {
            // 1. Group parents by Relationship Type
            const groups = {};
            rec.data.PARENT.forEach((p) => {
                const pid = p.parsed[0];
                const type = p.parsed[1] || "BIO";
                if (!groups[type]) groups[type] = [];
                groups[type].push(pid);
            });

            // 2. Process each group
            for (const [type, pids] of Object.entries(groups)) {
                // Iterate in pairs (Standard Mom/Dad or single parents)
                for (let i = 0; i < pids.length; i += 2) {
                    const p1 = pids[i];
                    const p2 = pids[i + 1] || null;

                    const fam = this._getFamily(p1, p2, allRecords);

                    // Link Child to Family
                    if (!fam.children.includes(rec.id)) {
                        fam.children.push(rec.id);
                    }

                    // Write FAMC tag
                    out.push(`1 FAMC ${fam.id}`);

                    // Apply Relationship Type (PEDI)
                    if (type === "ADO") {
                        out.push(`2 PEDI adopted`);
                    } else if (type === "FOS") {
                        out.push(`2 PEDI foster`);
                    }
                }
            }
        }
    }

    _writeEvent(rec, fttKey, defaultGedTag, out, shouldMask) {
        if (rec.data[fttKey]) {
            const EVENT_MAP = {
                BAP: "BAPM",
                BUR: "BURI",
                CREM: "CREM",
                CONF: "CONF",
                CENS: "CENS",
                PROB: "PROB",
                WILL: "WILL",
                NAT: "NATU",
                IMM: "IMMI",
                EMIG: "EMIG",
                EDUC: "EDUC",
                OCC: "OCCU",
                RET: "RETI",
                RESI: "RESI"
            };

            rec.data[fttKey].forEach((f) => {
                let gedTag = defaultGedTag;
                let writeType = false;
                let typeIndex = -1;
                let dateIndex = 0;
                let placeIndex = 1;
                let detailsIndex = -1;

                if (fttKey === "EVENT") {
                    // EVENT: TYPE | DATE | END | PLACE | DETAILS
                    typeIndex = 0;
                    dateIndex = 1;
                    placeIndex = 3;
                    detailsIndex = 4;

                    const fttType = f.parsed[0];
                    if (fttType && EVENT_MAP[fttType]) {
                        gedTag = EVENT_MAP[fttType];
                    } else {
                        writeType = true;
                    }
                }

                // Get details (e.g. Occupation value)
                const details = detailsIndex > -1 ? f.parsed[detailsIndex] : null;

                // Output Tag (with optional value)
                // If masked, we might suppress details if sensitive, but Spec focuses on dates/places.
                // We'll output the tag to indicate "something happened" or just skip if it has no semantic value without date.
                // Spec: "Mask all birth/marriage dates and places."
                if (details) {
                    out.push(`1 ${gedTag} ${details}`);
                } else {
                    out.push(`1 ${gedTag}`);
                }

                // Generic Type
                if (writeType) {
                    const type = f.parsed[typeIndex];
                    if (type) out.push(`2 TYPE ${type}`);
                }

                // Date & Place (MASKED if shouldMask is true)
                if (!shouldMask) {
                    const date = this._gedDate(f.parsed[dateIndex]);
                    if (date) out.push(`2 DATE ${date}`);

                    const place = f.parsed[placeIndex];
                    if (place) {
                        out.push(`2 PLAC ${place.replace(/;\s*/g, ", ")}`);

                        if (f.metadata && f.metadata.coords) {
                            const [lat, long] = f.metadata.coords.split(",").map((s) => s.trim());
                            if (lat && long) {
                                out.push(`3 MAP`);
                                out.push(`4 LATI ${lat}`);
                                out.push(`4 LONG ${long}`);
                            }
                        }

                        if (f.metadata && f.metadata.geo) {
                            out.push(
                                `3 NOTE Standardized/Modern Place: ${f.metadata.geo.replace(/;\s*/g, ", ")}`
                            );
                        }
                    }

                    // Citations & Notes
                    if (f.modifiers) {
                        for (const [modKey, mods] of Object.entries(f.modifiers)) {
                            if (modKey.endsWith("_SRC")) {
                                mods.forEach((m) => {
                                    const srcId = m.parsed[0].replace("^", "");
                                    out.push(`2 SOUR @${srcId}@`);
                                    const page = m.parsed[1];
                                    if (page) out.push(`3 PAGE ${page}`);
                                });
                            }
                            if (modKey.endsWith("_NOTE")) {
                                mods.forEach((m) => {
                                    this._writeNote(m.parsed[0], out, 2);
                                });
                            }
                        }
                    }
                } else {
                    // Optional: Indicate data is masked
                    // out.push(`2 NOTE Private`);
                }
            });
        }
    }

    // --- Helpers ---

    _writeNote(text, out, level) {
        if (!text) return;
        const lines = text.split("\n");
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
        const ids = [p1, p2].filter((x) => x).sort();
        const key = ids.join("|");

        if (this.famCache.has(key)) {
            return this.famCache.get(key);
        }

        const famId = `@F${this.famCounter++}@`;
        const famObj = {
            id: famId,
            husbs: [],
            wives: [],
            children: [],
            events: [],
            hasMarr: false
        };

        ids.forEach((pid) => {
            const prec = allRecords[pid];
            const sex =
                prec && prec.data.SEX && prec.data.SEX[0] ? prec.data.SEX[0].parsed[0] : "U";

            if (sex === "M") {
                famObj.husbs.push(pid);
            } else if (sex === "F") {
                famObj.wives.push(pid);
            } else {
                // Fallback for Unknown/Other:
                // Try to fill empty slots to create valid structure.
                if (famObj.husbs.length === 0) {
                    famObj.husbs.push(pid);
                } else if (famObj.wives.length === 0) {
                    famObj.wives.push(pid);
                } else {
                    famObj.husbs.push(pid);
                }
            }
        });

        this.famCache.set(key, famObj);
        return famObj;
    }

    _gedDate(fttDate) {
        if (!fttDate) return null;
        const months = [
            "JAN",
            "FEB",
            "MAR",
            "APR",
            "MAY",
            "JUN",
            "JUL",
            "AUG",
            "SEP",
            "OCT",
            "NOV",
            "DEC"
        ];

        const isoMatch = fttDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
            return `${parseInt(isoMatch[3])} ${months[parseInt(isoMatch[2]) - 1]} ${isoMatch[1]}`;
        }

        const monthMatch = fttDate.match(/^(\d{4})-(\d{2})$/);
        if (monthMatch) {
            return `${months[parseInt(monthMatch[2]) - 1]} ${monthMatch[1]}`;
        }

        if (/^\d{4}$/.test(fttDate)) return fttDate;

        if (fttDate.endsWith("~")) {
            return `ABT ${fttDate.replace("~", "")}`;
        }

        if (fttDate.endsWith("?")) {
            return `EST ${fttDate.replace("?", "")}`;
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
