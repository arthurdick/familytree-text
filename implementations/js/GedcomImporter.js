/**
 * GedcomImporter
 * Converts GEDCOM 5.5.1 to FamilyTree-Text (FTT).
 */

export default class GedcomImporter {
    constructor() {
        this.individuals = new Map();
        this.families = new Map();
        this.sources = new Map();
        this.lossReport = []; // Stores details of stripped data
    }

    convert(gedcomData) {
        this._reset();
        this._firstPassParse(gedcomData);
        const fttOutput = this._generateFTT();
        const reportOutput = this._generateLossReport();

        // Append report to the end of the file
        return fttOutput + "\n" + reportOutput;
    }

    _reset() {
        this.individuals.clear();
        this.families.clear();
        this.sources.clear();
        this.lossReport = [];
    }

    // =========================================================================
    // Pass 1: Parse GEDCOM into Memory Objects (With 'Handled' Flags)
    // =========================================================================
    _firstPassParse(data) {
        const lines = data.split(/\r?\n/);
        let currentRecord = null;
        let stack = [];

        // Regex: Level + [Optional ID] + Tag + [Optional Value]
        const lineRegex = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?: (.*))?$/;
        lines.forEach((line, index) => {
            if (!line.trim()) return;

            const match = line.match(lineRegex);
            if (!match) return;

            const level = parseInt(match[1], 10);
            const id = match[2] || null;
            const tag = match[3];
            const rawValue = match[4] || "";
            const cleanId = id ? id.replace(/@/g, "") : null;

            // FTT v0.1 requires UTF-8. We explicitly reject legacy encodings.
            if (level === 1 && tag === "CHAR") {
                const charValue = rawValue.trim().toUpperCase();
                if (
                    charValue === "ANSEL" ||
                    charValue === "IBMPC" ||
                    charValue === "WINDOWS-1252"
                ) {
                    throw new Error(
                        `Unsupported Encoding: FTT requires UTF-8. Your file is encoded as ${charValue}. ` +
                            `Please export your GEDCOM as UTF-8 before importing.`
                    );
                }
            }

            // Handle multiline concatenation (CONT/CONC)
            if (tag === "CONT" || tag === "CONC") {
                const targetNode = stack[level - 1];
                if (targetNode) {
                    if (tag === "CONT") targetNode.value += "\n" + rawValue;
                    else targetNode.value += rawValue;
                }
                return;
            }

            // Create Node with 'handled' flag for audit
            const node = {
                tag,
                value: rawValue,
                children: [],
                handled: false,
                lineNum: index + 1 // Useful for debugging imports
            };

            if (level === 0) {
                currentRecord = { id: cleanId, type: tag, ...node };
                // We implicitly handle the Root Record Shell (INDI/FAM/SOUR tags themselves)
                currentRecord.handled = true;
                stack = [];
                stack[0] = currentRecord;

                if (tag === "INDI") this.individuals.set(cleanId, currentRecord);
                else if (tag === "FAM") this.families.set(cleanId, currentRecord);
                else if (tag === "SOUR") this.sources.set(cleanId, currentRecord);
                else if (tag === "HEAD" || tag === "TRLR") {
                    // Ignore purely structural/header records for loss reporting
                    currentRecord.handled = true;
                }
            } else {
                const parent = stack[level - 1];
                if (parent) {
                    parent.children.push(node);
                    stack[level] = node;
                }
            }
        });
    }

    // =========================================================================
    // Pass 2: Generate FTT Output (Marking Data as Used)
    // =========================================================================
    _generateFTT() {
        const output = [];
        output.push(`HEAD_FORMAT: FTT v0.1`);
        output.push(`HEAD_DATE: ${new Date().toISOString().split("T")[0]}`);
        output.push(`HEAD_TITLE: GEDCOM Import`);
        output.push("---");
        output.push("");

        // Process Sources
        if (this.sources.size > 0) {
            output.push("# ==========================================");
            output.push("# SOURCES");
            output.push("# ==========================================");
            output.push("");
            for (const [id, rec] of this.sources) {
                this._writeSource(rec, output);
                this._auditNode(rec, `SOUR(${id})`); // Audit immediately after writing
            }
            output.push("---");
            output.push("");
        }

        // Process Individuals
        output.push("# ==========================================");
        output.push("# RECORDS");
        output.push("# ==========================================");
        output.push("");
        for (const [indiId, indi] of this.individuals) {
            this._writeIndividual(indi, output);
            this._auditNode(indi, `INDI(${indiId})`); // Audit immediately
            output.push("");
        }

        // Process Families (Audit Only)
        // We don't write FAM records directly (they are resolved to Unions),
        // but we must check if they contained data we ignored.
        for (const [famId, fam] of this.families) {
            this._auditNode(fam, `FAM(${famId})`);
        }

        return output.join("\n");
    }

    // =========================================================================
    // Writers & Markers
    // =========================================================================

    _writeSource(rec, out) {
        const fttId = `^${rec.id}`;
        out.push(`ID: ${fttId}`);

        const title = this._extractTag(rec, "TITL");
        if (title) out.push(`TITLE: ${title.replace(/\n/g, " ")}`);

        const auth = this._extractTag(rec, "AUTH");
        if (auth) out.push(`AUTHOR: ${auth.replace(/\n/g, " ")}`);

        // Record-Level Notes
        const noteNodes = rec.children.filter((c) => c.tag === "NOTE");
        noteNodes.forEach((n) => {
            n.handled = true;
            const lines = n.value.split("\n");
            if (lines.length > 0) {
                out.push(`NOTES: ${lines[0]}`);
                for (let i = 1; i < lines.length; i++) {
                    out.push(`\n  ${lines[i]}`);
                }
            }
        });
    }

    _writeIndividual(indi, out) {
        out.push(`ID: ${indi.id}`);

        // NAME Processing
        const nameNodes = indi.children.filter((c) => c.tag === "NAME");

        if (nameNodes.length > 0) {
            nameNodes.forEach((nameNode, index) => {
                nameNode.handled = true; // Mark handled

                // 1. Parse Display and Sort Key
                const rawName = nameNode.value || "";
                const display = rawName.replace(/\//g, "").trim();
                const match = rawName.match(/(.*)\/(.*)\/(.*)/);
                let sortKey = "";
                if (match) {
                    const given = (match[1] + " " + match[3]).trim();
                    const sur = match[2].trim();
                    sortKey = `${sur}, ${given}`;
                }

                // 2. Extract Type
                // Check for GEDCOM 'TYPE' sub-tag
                let type = "";
                const typeNode = nameNode.children.find((c) => c.tag === "TYPE");

                if (typeNode) {
                    typeNode.handled = true;
                    const rawType = typeNode.value.toUpperCase().trim();
                    if (rawType === "AKA" || rawType === "ALIAS") type = "AKA";
                    else if (rawType === "BIRTH" || rawType === "MAIDEN" || rawType === "NEE")
                        type = "BIRTH";
                    else if (rawType === "MARRIED") type = "MARR";
                    else if (rawType === "NICK" || rawType === "NICKNAME") type = "NICK";
                    else if (rawType === "IMMIGRANT") type = "IMM";
                    else type = rawType;
                } else {
                    if (index === 0) type = "BIRTH";
                }

                // 3. Determine Status
                let status = index === 0 ? "PREF" : "";

                // 4. Output Main Name Line
                out.push(`NAME: ${display} | ${sortKey} | ${type} | ${status}`);

                // 5. Handle Sub-Tags, Nicknames, & Notes
                this._markTagHandled(nameNode, "SURN");
                this._markTagHandled(nameNode, "GIVN");
                this._markTagHandled(nameNode, "_PREF");

                const nickNode = nameNode.children.find((c) => c.tag === "NICK");
                if (nickNode) {
                    nickNode.handled = true;
                    const nickVal = nickNode.value.trim();
                    if (nickVal) {
                        out.push(`NAME: ${nickVal} || NICK |`);
                    }
                }

                // Capture Name Notes (NAME_NOTE)
                this._writeNotesFrom(nameNode, "NAME", out);
            });
        }

        // SEX
        const sex = this._extractTag(indi, "SEX");
        if (sex) out.push(`SEX:  ${sex}`);

        // VITAL EVENTS
        this._writeEvent(indi, "BIRT", "BORN", out);
        this._writeEvent(indi, "DEAT", "DIED", out);

        // OTHER EVENTS
        this._writeGenericEvents(indi, out);

        // PARENTS (FAMC)
        const famcNodes = indi.children.filter((c) => c.tag === "FAMC");
        famcNodes.forEach((famc) => {
            famc.handled = true;

            let relType = "BIO";
            const pediVal = this._extractTag(famc, "PEDI");
            if (pediVal) {
                const p = pediVal.trim().toLowerCase();
                if (p === "adopted") relType = "ADO";
                else if (p === "foster") relType = "FOS";
            }

            const famId = famc.value.replace(/@/g, "");
            const fam = this.families.get(famId);
            if (fam) {
                this._markTagHandled(fam, "HUSB");
                this._markTagHandled(fam, "WIFE");

                const myChilNode = fam.children.find(
                    (c) => c.tag === "CHIL" && c.value.replace(/@/g, "") === indi.id
                );
                if (myChilNode) myChilNode.handled = true;

                const husbId = this._peekTag(fam, "HUSB")?.replace(/@/g, "");
                const wifeId = this._peekTag(fam, "WIFE")?.replace(/@/g, "");

                // Output links & Append notes to each link
                if (husbId) {
                    out.push(`PARENT: ${husbId} | ${relType}`);
                    this._writeNotesFrom(famc, "PARENT", out);
                }
                if (wifeId) {
                    out.push(`PARENT: ${wifeId} | ${relType}`);
                    this._writeNotesFrom(famc, "PARENT", out);
                }
            }
        });

        // SPOUSES (FAMS)
        const famsNodes = indi.children.filter((c) => c.tag === "FAMS");
        famsNodes.forEach((fams) => {
            fams.handled = true;
            const famId = fams.value.replace(/@/g, "");
            const fam = this.families.get(famId);
            if (fam) {
                this._markTagHandled(fam, "HUSB");
                this._markTagHandled(fam, "WIFE");

                const chilNodes = fam.children.filter((c) => c.tag === "CHIL");
                chilNodes.forEach((childNode) => {
                    childNode.handled = true;
                    const childId = childNode.value.replace(/@/g, "");
                    out.push(`CHILD: ${childId}`);
                });

                const husbId = this._peekTag(fam, "HUSB")?.replace(/@/g, "");
                const wifeId = this._peekTag(fam, "WIFE")?.replace(/@/g, "");

                let spouseId = null;
                if (indi.id === husbId) spouseId = wifeId;
                else if (indi.id === wifeId) spouseId = husbId;

                if (spouseId) {
                    const marrNode = this._extractNode(fam, "MARR");
                    let dateStr = "";
                    let endReason = "";

                    if (marrNode) {
                        const d = this._extractTag(marrNode, "DATE");
                        if (d) dateStr = this._convertDate(d);
                        this._extractTag(marrNode, "PLAC");
                    }

                    const divNode = this._extractNode(fam, "DIV");
                    if (divNode) {
                        endReason = "DIV";
                        this._extractTag(divNode, "DATE");
                    }

                    out.push(`UNION: ${spouseId} | MARR | ${dateStr} || ${endReason}`);

                    // Collect and Attach Notes (UNION_NOTE)
                    // 1. From the Shared Family Record
                    this._writeNotesFrom(fam, "UNION", out);
                    // 2. From the Marriage Event
                    if (marrNode) this._writeNotesFrom(marrNode, "UNION", out);
                    // 3. From the Divorce Event
                    if (divNode) this._writeNotesFrom(divNode, "UNION", out);
                }
            }
        });

        // Record-Level Notes
        const noteNodes = indi.children.filter((c) => c.tag === "NOTE");
        noteNodes.forEach((n) => {
            n.handled = true;
            const lines = n.value.split("\n");
            if (lines.length > 0) {
                out.push(`NOTES: ${lines[0]}`);
                for (let i = 1; i < lines.length; i++) {
                    out.push(`\n  ${lines[i]}`);
                }
            }
        });
    }

    _writeEvent(parentNode, gedTag, fttKey, out) {
        const evtNode = this._extractNode(parentNode, gedTag);
        if (evtNode) {
            const date = this._convertDate(this._extractTag(evtNode, "DATE"));

            let fttPlace = "";
            const placNode = this._extractNode(evtNode, "PLAC");

            if (placNode) {
                fttPlace = (placNode.value || "").replace(/,/g, ";");
                const mapNode = this._extractNode(placNode, "MAP");
                if (mapNode) {
                    const lat = this._extractTag(mapNode, "LATI");
                    const long = this._extractTag(mapNode, "LONG");
                    if (lat && long) fttPlace += ` <${lat}, ${long}>`;
                }
            }

            out.push(`${fttKey}: ${date} | ${fttPlace}`);

            // Citations
            const sourNodes = evtNode.children.filter((c) => c.tag === "SOUR");
            let bestQuay = -1;
            sourNodes.forEach((s) => {
                s.handled = true;
                const sId = s.value.replace(/@/g, "");
                const page = this._extractTag(s, "PAGE") || "";
                const quayNode = s.children.find((c) => c.tag === "QUAY");
                if (quayNode) {
                    quayNode.handled = true;
                    const qVal = parseInt(quayNode.value, 10);
                    if (!isNaN(qVal) && qVal > bestQuay) bestQuay = qVal;
                }
                out.push(`${fttKey}_SRC: ^${sId} | ${page}`);
            });

            if (bestQuay !== -1) {
                const qualStr = this._convertQuayToFtt(String(bestQuay));
                if (qualStr) out.push(`${fttKey}_QUAL: ${qualStr}`);
            }

            // Notes
            this._writeNotesFrom(evtNode, fttKey, out);
        }
    }

    _writeGenericEvents(indi, out) {
        const EVENT_MAP = {
            BAPM: "BAP",
            BURI: "BUR",
            CREM: "CREM",
            CONF: "CONF",
            CENS: "CENS",
            PROB: "PROB",
            WILL: "WILL",
            NATU: "NAT",
            IMMI: "IMM",
            EMIG: "EMIG",
            EDUC: "EDUC",
            OCCU: "OCC",
            RETI: "RET",
            RESI: "RESI"
        };

        const events = indi.children.filter((c) =>
            Object.prototype.hasOwnProperty.call(EVENT_MAP, c.tag)
        );

        events.forEach((node) => {
            node.handled = true;
            const fttType = EVENT_MAP[node.tag];
            const date = this._convertDate(this._extractTag(node, "DATE"));

            let place = "";
            const placNode = this._extractNode(node, "PLAC");
            if (placNode) {
                place = (placNode.value || "").replace(/,/g, ";");
                const mapNode = this._extractNode(placNode, "MAP");
                if (mapNode) {
                    const lat = this._extractTag(mapNode, "LATI");
                    const long = this._extractTag(mapNode, "LONG");
                    if (lat && long) place += ` <${lat}, ${long}>`;
                }
            }

            const details = (node.value || "").replace(/\n/g, " ").trim();
            out.push(`EVENT: ${fttType} | ${date} || ${place} | ${details}`);

            const sourNodes = node.children.filter((c) => c.tag === "SOUR");
            let bestQuay = -1;
            sourNodes.forEach((s) => {
                s.handled = true;
                const sId = s.value.replace(/@/g, "");
                const page = this._extractTag(s, "PAGE") || "";
                const quayNode = s.children.find((c) => c.tag === "QUAY");
                if (quayNode) {
                    quayNode.handled = true;
                    const qVal = parseInt(quayNode.value, 10);
                    if (!isNaN(qVal) && qVal > bestQuay) bestQuay = qVal;
                }
                out.push(`EVENT_SRC: ^${sId} | ${page}`);
            });

            if (bestQuay !== -1) {
                const qualStr = this._convertQuayToFtt(String(bestQuay));
                if (qualStr) out.push(`EVENT_QUAL: ${qualStr}`);
            }

            // Notes
            this._writeNotesFrom(node, "EVENT", out);
        });
    }

    _writeNotesFrom(node, fttKey, out) {
        const noteNodes = node.children.filter((c) => c.tag === "NOTE");
        noteNodes.forEach((n) => {
            n.handled = true;
            const lines = n.value.split("\n");
            if (lines.length > 0) {
                out.push(`${fttKey}_NOTE: ${lines[0]}`);
                for (let i = 1; i < lines.length; i++) {
                    out.push(`\n  ${lines[i]}`);
                }
            }
        });
    }

    _convertQuayToFtt(quay) {
        switch (quay.trim()) {
            case "3":
                return "DIRECT | PRIM | ORIG";
            case "2":
                return "DIRECT | SEC | DERIV";
            case "1":
                return "INDIRECT | UNK | DERIV";
            case "0":
                return "UNK | UNK | UNK";
            default:
                return null;
        }
    }

    // =========================================================================
    // Extraction Helpers
    // =========================================================================

    _extractTag(parentNode, targetTag) {
        const node = parentNode.children.find((c) => c.tag === targetTag);
        if (node) {
            node.handled = true;
            return node.value;
        }
        return null;
    }

    _extractNode(parentNode, targetTag) {
        const node = parentNode.children.find((c) => c.tag === targetTag);
        if (node) {
            node.handled = true;
            return node;
        }
        return null;
    }

    _markTagHandled(parentNode, targetTag) {
        const node = parentNode.children.find((c) => c.tag === targetTag);
        if (node) node.handled = true;
    }

    _peekTag(parentNode, targetTag) {
        const node = parentNode.children.find((c) => c.tag === targetTag);
        return node ? node.value : null;
    }

    // =========================================================================
    // Audit Logic
    // =========================================================================

    _auditNode(node, contextPath) {
        if (!node.handled) {
            this._reportLoss(contextPath, node.tag, node.value, true);
            return;
        }
        node.children.forEach((child) => {
            if (!child.handled) {
                this._reportLoss(contextPath, child.tag, child.value, false);
            } else {
                this._auditNode(child, `${contextPath}.${child.tag}`);
            }
        });
    }

    _reportLoss(path, tag, value, isWholeBranch) {
        const valStr = value
            ? ` = "${value.substring(0, 30)}${value.length > 30 ? "..." : ""}"`
            : "";
        const desc = isWholeBranch ? "(Whole Branch Skipped)" : "(Tag Skipped)";
        this.lossReport.push(`[${path}] Unhandled ${tag}${valStr} ${desc}`);
    }

    _generateLossReport() {
        if (this.lossReport.length === 0) return "";
        const lines = [];
        lines.push("# ==========================================");
        lines.push(`# IMPORT WARNINGS (${this.lossReport.length} items stripped)`);
        lines.push("# ==========================================");
        lines.push("# The following GEDCOM data was not converted to FTT v0.1:");
        this.lossReport.forEach((msg) => {
            lines.push(`# ${msg}`);
        });
        return lines.join("\n");
    }

    // =========================================================================
    // Date Helpers
    // =========================================================================
    _convertDate(gedDate) {
        if (!gedDate) return "";
        let d = gedDate.trim().toUpperCase();
        if (d.startsWith("ABT")) return this._parseStandardDate(d.replace("ABT", "").trim()) + "~";
        if (d.startsWith("EST") || d.startsWith("CAL"))
            return this._parseStandardDate(d.replace(/EST|CAL/, "").trim()) + "~";
        if (d.startsWith("BEF"))
            return `[..${this._parseStandardDate(d.replace("BEF", "").trim())}]`;
        if (d.startsWith("AFT"))
            return `[${this._parseStandardDate(d.replace("AFT", "").trim())}..]`;
        if (d.startsWith("BET")) {
            const parts = d.replace("BET", "").split("AND");
            if (parts.length === 2) {
                return `[${this._parseStandardDate(parts[0].trim())}..${this._parseStandardDate(parts[1].trim())}]`;
            }
        }
        return this._parseStandardDate(d);
    }

    _parseStandardDate(dateStr) {
        const MONTHS = {
            JAN: "01",
            FEB: "02",
            MAR: "03",
            APR: "04",
            MAY: "05",
            JUN: "06",
            JUL: "07",
            AUG: "08",
            SEP: "09",
            OCT: "10",
            NOV: "11",
            DEC: "12"
        };
        const parts = dateStr.split(" ");
        if (parts.length === 1) return parts[0];
        if (parts.length === 2 && MONTHS[parts[0]]) return `${parts[1]}-${MONTHS[parts[0]]}`;
        if (parts.length === 3 && MONTHS[parts[1]])
            return `${parts[2]}-${MONTHS[parts[1]]}-${parts[0].padStart(2, "0")}`;
        return dateStr;
    }
}
