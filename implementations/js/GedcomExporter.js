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

            // Family Events (MARR, DIV, etc.)
            fam.events.forEach((evt) => {
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

                    // Attach Notes to the main event (usually MARR)
                    if (evt.notes && evt.notes.length > 0) {
                        evt.notes.forEach((n) => this._writeNote(n, output, 2));
                    }

                    if (evt.reason === "DIV") {
                        output.push(`1 DIV`);
                        if (evt.endDate) output.push(`2 DATE ${evt.endDate}`);
                        // If we had specific divorce notes, they would go here.
                        // Currently UNION_NOTE is bucketed to the main Union event.
                    }
                }
            });

            // Generic Family Notes (if any were pushed to the root fam object)
            if (fam.notes && fam.notes.length > 0) {
                fam.notes.forEach((n) => this._writeNote(n, output, 1));
            }
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
            records[id] = { id: id, type: "PLACEHOLDER", data: {}, line: 0 };
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

                if (shouldMask && status !== "PREF" && rec.data.NAME.length > 1) {
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
                if (type) out.push(`2 TYPE ${type}`);

                // Export NAME_NOTE
                if (!shouldMask && nameField.modifiers && nameField.modifiers.NAME_NOTE) {
                    nameField.modifiers.NAME_NOTE.forEach((note) => {
                        this._writeNote(note.parsed[0], out, 2);
                    });
                }
            });
        } else if (rec.type === "PLACEHOLDER") {
            out.push(`1 NAME Unknown /Placeholder/`);
        }

        if (rec.type === "PLACEHOLDER") {
            out.push(`1 NOTE This is a synthesized placeholder record from FTT.`);
        }

        const sex = this._getField(rec, "SEX");
        if (sex) out.push(`1 SEX ${sex}`);

        this._writeEvent(rec, "BORN", "BIRT", out, shouldMask);
        this._writeEvent(rec, "DIED", "DEAT", out, shouldMask);
        this._writeEvent(rec, "EVENT", "EVEN", out, shouldMask);

        // Shared Events
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

        // Associations
        if (rec.data.ASSOC) {
            rec.data.ASSOC.forEach((assoc) => {
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || "ASSOCIATE";
                const startDate = assoc.parsed[2];
                const details = assoc.parsed[4];

                out.push(`1 ASSO @${targetId}@`);
                out.push(`2 RELA ${role}`);
                if (startDate) {
                    this._log(rec.id, `ASSOC to ${targetId}: Date '${startDate}' stripped.`);
                }
                if (details && !shouldMask) {
                    out.push(`2 NOTE ${details}`);
                }
            });
        }

        // Notes
        if (!shouldMask && rec.data.NOTES) {
            rec.data.NOTES.forEach((n) => {
                this._writeNote(n.parsed[0], out, 1);
            });
        }

        // Unions (Spouse Links)
        if (rec.data.UNION) {
            rec.data.UNION.forEach((u) => {
                const partnerId = u.parsed[0];
                const type = u.parsed[1] || "MARR";
                const date = this._gedDate(u.parsed[2]);
                const endDate = this._gedDate(u.parsed[3]);
                const reason = u.parsed[4];

                const fam = this._getFamily(rec.id, partnerId, allRecords);

                // Collect UNION_NOTEs
                const notes = [];
                if (!shouldMask && u.modifiers && u.modifiers.UNION_NOTE) {
                    u.modifiers.UNION_NOTE.forEach((n) => notes.push(n.parsed[0]));
                }

                if (!fam.hasMarr) {
                    fam.events.push({ tag: "MARR", date, endDate, reason, type, notes });
                    fam.hasMarr = true;
                } else {
                    // Append notes to existing marriage event if found
                    const evt = fam.events.find((e) => e.tag === "MARR");
                    if (evt && notes.length > 0) {
                        // Avoid exact duplicate notes if spouse has same note
                        notes.forEach((noteText) => {
                            if (!evt.notes.includes(noteText)) evt.notes.push(noteText);
                        });
                    }
                }
                out.push(`1 FAMS ${fam.id}`);
            });
        }

        // Parents (Child Links)
        if (rec.data.PARENT) {
            const groups = {};
            // We must preserve the object to access modifiers later
            rec.data.PARENT.forEach((p) => {
                const type = p.parsed[1] || "BIO";
                if (!groups[type]) groups[type] = [];
                groups[type].push(p); // Store whole object
            });

            for (const [type, pObjs] of Object.entries(groups)) {
                // Process in pairs of 2 for potential Mom/Dad grouping
                for (let i = 0; i < pObjs.length; i += 2) {
                    const p1Obj = pObjs[i];
                    const p2Obj = pObjs[i + 1] || null;

                    const p1 = p1Obj.parsed[0];
                    const p2 = p2Obj ? p2Obj.parsed[0] : null;

                    const fam = this._getFamily(p1, p2, allRecords);

                    if (!fam.children.includes(rec.id)) {
                        fam.children.push(rec.id);
                    }

                    out.push(`1 FAMC ${fam.id}`);

                    if (type === "ADO") out.push(`2 PEDI adopted`);
                    else if (type === "FOS") out.push(`2 PEDI foster`);

                    // Export PARENT_NOTE
                    // Check notes on p1Obj
                    if (!shouldMask && p1Obj.modifiers && p1Obj.modifiers.PARENT_NOTE) {
                        p1Obj.modifiers.PARENT_NOTE.forEach((n) =>
                            this._writeNote(n.parsed[0], out, 2)
                        );
                    }
                    // Check notes on p2Obj
                    if (p2Obj && !shouldMask && p2Obj.modifiers && p2Obj.modifiers.PARENT_NOTE) {
                        p2Obj.modifiers.PARENT_NOTE.forEach((n) =>
                            this._writeNote(n.parsed[0], out, 2)
                        );
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
                let typeIndex = -1,
                    dateIndex = 0,
                    placeIndex = 1,
                    detailsIndex = -1;

                if (fttKey === "EVENT") {
                    typeIndex = 0;
                    dateIndex = 1;
                    placeIndex = 3;
                    detailsIndex = 4;
                    const fttType = f.parsed[0];
                    if (fttType && EVENT_MAP[fttType]) gedTag = EVENT_MAP[fttType];
                    else writeType = true;
                }

                const details = detailsIndex > -1 ? f.parsed[detailsIndex] : null;
                if (details) out.push(`1 ${gedTag} ${details}`);
                else out.push(`1 ${gedTag}`);

                if (writeType) {
                    const type = f.parsed[typeIndex];
                    if (type) out.push(`2 TYPE ${type}`);
                }

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

                    if (f.modifiers) {
                        let quayVal = null;
                        const qualKey = `${fttKey}_QUAL`;
                        if (f.modifiers[qualKey] && f.modifiers[qualKey].length > 0) {
                            quayVal = this._convertFttQualToQuay(f.modifiers[qualKey][0].parsed);
                        }

                        for (const [modKey, mods] of Object.entries(f.modifiers)) {
                            if (modKey.endsWith("_SRC")) {
                                mods.forEach((m) => {
                                    const srcId = m.parsed[0].replace("^", "");
                                    out.push(`2 SOUR @${srcId}@`);
                                    const page = m.parsed[1];
                                    if (page) out.push(`3 PAGE ${page}`);
                                    if (quayVal !== null) out.push(`3 QUAY ${quayVal}`);
                                });
                            }
                            if (modKey.endsWith("_NOTE")) {
                                mods.forEach((m) => {
                                    this._writeNote(m.parsed[0], out, 2);
                                });
                            }
                        }
                    }
                }
            });
        }
    }

    _convertFttQualToQuay(parsedParts) {
        if (!parsedParts || parsedParts.length === 0) return null;
        const [evidence, info] = parsedParts.map((s) => s.trim().toUpperCase());
        if (evidence === "DIRECT" && info === "PRIM") return "3";
        if (evidence === "DIRECT" || info === "PRIM") return "2";
        if (evidence === "INDIRECT" || evidence === "NEG") return "1";
        return "0";
    }

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

        if (this.famCache.has(key)) return this.famCache.get(key);

        const famId = `@F${this.famCounter++}@`;
        const famObj = {
            id: famId,
            husbs: [],
            wives: [],
            children: [],
            events: [],
            notes: [],
            hasMarr: false
        };

        ids.forEach((pid) => {
            const prec = allRecords[pid];
            const sex =
                prec && prec.data.SEX && prec.data.SEX[0] ? prec.data.SEX[0].parsed[0] : "U";
            if (sex === "M") famObj.husbs.push(pid);
            else if (sex === "F") famObj.wives.push(pid);
            else {
                if (famObj.husbs.length === 0) famObj.husbs.push(pid);
                else if (famObj.wives.length === 0) famObj.wives.push(pid);
                else famObj.husbs.push(pid);
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
        if (isoMatch)
            return `${parseInt(isoMatch[3])} ${months[parseInt(isoMatch[2]) - 1]} ${isoMatch[1]}`;

        const monthMatch = fttDate.match(/^(\d{4})-(\d{2})$/);
        if (monthMatch) return `${months[parseInt(monthMatch[2]) - 1]} ${monthMatch[1]}`;

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
