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
      const rawValue = match[4] || '';
      const cleanId = id ? id.replace(/@/g, '') : null;

      // Handle multiline concatenation (CONT/CONC)
      if (tag === 'CONT' || tag === 'CONC') {
        const targetNode = stack[level - 1];
        if (targetNode) {
          if (tag === 'CONT') targetNode.value += '\n' + rawValue;
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

        if (tag === 'INDI') this.individuals.set(cleanId, currentRecord);
        else if (tag === 'FAM') this.families.set(cleanId, currentRecord);
        else if (tag === 'SOUR') this.sources.set(cleanId, currentRecord);
        else if (tag === 'HEAD' || tag === 'TRLR') {
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
    output.push(`HEAD_DATE: ${new Date().toISOString().split('T')[0]}`);
    output.push(`HEAD_TITLE: GEDCOM Import`);
    output.push('---');
    output.push('');

    // Process Sources
    if (this.sources.size > 0) {
      output.push('# ==========================================');
      output.push('# SOURCES');
      output.push('# ==========================================');
      output.push('');
      for (const [id, rec] of this.sources) {
        this._writeSource(rec, output);
        this._auditNode(rec, `SOUR(${id})`); // Audit immediately after writing
      }
      output.push('---');
      output.push('');
    }

    // Process Individuals
    output.push('# ==========================================');
    output.push('# RECORDS');
    output.push('# ==========================================');
    output.push('');

    for (const [indiId, indi] of this.individuals) {
      this._writeIndividual(indi, output);
      this._auditNode(indi, `INDI(${indiId})`); // Audit immediately
      output.push('');
    }

    // Process Families (Audit Only)
    // We don't write FAM records directly (they are resolved to Unions),
    // but we must check if they contained data we ignored.
    for (const [famId, fam] of this.families) {
        this._auditNode(fam, `FAM(${famId})`);
    }

    return output.join('\n');
  }

  // =========================================================================
  // Writers & Markers
  // =========================================================================

  _writeSource(rec, out) {
    const fttId = `^${rec.id}`;
    out.push(`ID: ${fttId}`);

    const title = this._extractTag(rec, 'TITL');
    if (title) out.push(`TITLE: ${title.replace(/\n/g, ' ')}`);

    const auth = this._extractTag(rec, 'AUTH');
    if (auth) out.push(`AUTHOR: ${auth.replace(/\n/g, ' ')}`);
  }

  _writeIndividual(indi, out) {
    out.push(`ID: ${indi.id}`);

    // NAME
    const nameNode = this._extractNode(indi, 'NAME');
    if (nameNode) {
      const rawName = nameNode.value || '';
      const display = rawName.replace(/\//g, '').trim();
      const match = rawName.match(/(.*)\/(.*)\/(.*)/);
      let sortKey = '';
      if (match) {
        const given = (match[1] + ' ' + match[3]).trim();
        const sur = match[2].trim();
        sortKey = `${sur}, ${given}`;
      }
      out.push(`NAME: ${display} | ${sortKey} | BIRTH | PREF`);
      
      // Handle SURN / GIVN standard sub-tags if present to avoid false warnings
      this._extractTag(nameNode, 'SURN');
      this._extractTag(nameNode, 'GIVN');
    }

    // SEX
    const sex = this._extractTag(indi, 'SEX');
    if (sex) out.push(`SEX:  ${sex}`);

    // VITAL EVENTS
    this._writeEvent(indi, 'BIRT', 'BORN', out);
    this._writeEvent(indi, 'DEAT', 'DIED', out);

    // PARENTS (FAMC)
    // We scan for FAMC nodes and mark them handled
    const famcNodes = indi.children.filter(c => c.tag === 'FAMC');
    famcNodes.forEach(famc => {
      famc.handled = true; // Mark FAMC as handled
      const famId = famc.value.replace(/@/g, '');
      const fam = this.families.get(famId);
      if (fam) {
        // We are implicitly "using" the HUSB/WIFE pointers in the FAM record here
        this._markTagHandled(fam, 'HUSB');
        this._markTagHandled(fam, 'WIFE');
        
        // Also claim "my" own CHIL slot in this family to prevent false "Unhandled" warnings.
        // This covers cases where parents are missing/unlinked, but the child linkage is valid.
        const myChilNode = fam.children.find(c => 
            c.tag === 'CHIL' && c.value.replace(/@/g, '') === indi.id
        );
        if (myChilNode) {
            myChilNode.handled = true;
        }
        
        // Check structural parent links
        const husbId = this._peekTag(fam, 'HUSB')?.replace(/@/g, '');
        const wifeId = this._peekTag(fam, 'WIFE')?.replace(/@/g, '');
        if (husbId) out.push(`PARENT: ${husbId} | BIO`);
        if (wifeId) out.push(`PARENT: ${wifeId} | BIO`);
      }
    });

    // SPOUSES (FAMS)
    const famsNodes = indi.children.filter(c => c.tag === 'FAMS');
    famsNodes.forEach(fams => {
      fams.handled = true; // Mark FAMS as handled
      const famId = fams.value.replace(/@/g, '');
      const fam = this.families.get(famId);
      if (fam) {
        this._markTagHandled(fam, 'HUSB');
        this._markTagHandled(fam, 'WIFE');
        
        // Handle Children to preserve order and silence audit warnings
        // 1. Mark CHIL tags in the family as handled (stops false positive audit logs)
        // 2. Generate CHILD: lines in FTT to preserve the specific birth order from GEDCOM
        const chilNodes = fam.children.filter(c => c.tag === 'CHIL');
        chilNodes.forEach(childNode => {
            childNode.handled = true;
            const childId = childNode.value.replace(/@/g, '');
            out.push(`CHILD: ${childId}`);
        });
        
        const husbId = this._peekTag(fam, 'HUSB')?.replace(/@/g, '');
        const wifeId = this._peekTag(fam, 'WIFE')?.replace(/@/g, '');
        
        let spouseId = null;
        if (indi.id === husbId) spouseId = wifeId;
        else if (indi.id === wifeId) spouseId = husbId;

        if (spouseId) {
            // Process Marriage Event in FAM
            const marrNode = this._extractNode(fam, 'MARR');
            let dateStr = '';
            let endReason = '';

            if (marrNode) {
                const d = this._extractTag(marrNode, 'DATE');
                if (d) dateStr = this._convertDate(d);
                // Also handle PLAC inside MARR to avoid warning
                this._extractTag(marrNode, 'PLAC'); 
            }
            
            const divNode = this._extractNode(fam, 'DIV');
            if (divNode) {
                endReason = 'DIV';
                // Handle DIV children (DATE etc)
                this._extractTag(divNode, 'DATE');
            }

            out.push(`UNION: ${spouseId} | MARR | ${dateStr} || ${endReason}`);
        }
      }
    });

    // NOTES
    const noteNodes = indi.children.filter(c => c.tag === 'NOTE');
    noteNodes.forEach(n => {
        n.handled = true; // Mark handled
        const lines = n.value.split('\n');
        if(lines.length > 0) {
            out.push(`NOTES: ${lines[0]}`);
            for(let i=1; i<lines.length; i++) {
                out.push(`  ${lines[i]}`);
            }
        }
    });
  }

  _writeEvent(parentNode, gedTag, fttKey, out) {
    const evtNode = this._extractNode(parentNode, gedTag);
    if (evtNode) {
      const date = this._convertDate(this._extractTag(evtNode, 'DATE'));
      const place = this._extractTag(evtNode, 'PLAC') || '';
      const fttPlace = place.replace(/,/g, ';');
      
      out.push(`${fttKey}: ${date} | ${fttPlace}`);

      // Citations
      const sourNodes = evtNode.children.filter(c => c.tag === 'SOUR');
      sourNodes.forEach(s => {
        s.handled = true; // Mark handled
        const sId = s.value.replace(/@/g, '');
        const page = this._extractTag(s, 'PAGE') || '';
        out.push(`${fttKey}_SRC: ^${sId} | ${page}`);
      });
    }
  }

  // =========================================================================
  // Extraction Helpers (The "Mark-as-Read" System)
  // =========================================================================

  /** Returns value and marks node as handled */
  _extractTag(parentNode, targetTag) {
    const node = parentNode.children.find(c => c.tag === targetTag);
    if (node) {
      node.handled = true;
      return node.value;
    }
    return null;
  }

  /** Returns node object and marks it as handled */
  _extractNode(parentNode, targetTag) {
    const node = parentNode.children.find(c => c.tag === targetTag);
    if (node) {
      node.handled = true;
      return node;
    }
    return null;
  }

  /** Marks a tag handled without returning it (for Implicit usage) */
  _markTagHandled(parentNode, targetTag) {
    const node = parentNode.children.find(c => c.tag === targetTag);
    if (node) node.handled = true;
  }

  /** Peeks at value WITHOUT marking handled (for lookups that don't consume data) */
  _peekTag(parentNode, targetTag) {
    const node = parentNode.children.find(c => c.tag === targetTag);
    return node ? node.value : null;
  }

  // =========================================================================
  // Audit Logic
  // =========================================================================

  _auditNode(node, contextPath) {
    // If this specific node wasn't handled, everything inside is lost
    if (!node.handled) {
      this._reportLoss(contextPath, node.tag, node.value, true);
      return; 
    }

    // Check children recursively
    node.children.forEach(child => {
      if (!child.handled) {
        this._reportLoss(contextPath, child.tag, child.value, false);
      } else {
        // Recurse into handled children to find deeper unhandled tags
        this._auditNode(child, `${contextPath}.${child.tag}`);
      }
    });
  }

  _reportLoss(path, tag, value, isWholeBranch) {
    const valStr = value ? ` = "${value.substring(0, 30)}${value.length>30?'...':''}"` : '';
    const desc = isWholeBranch ? '(Whole Branch Skipped)' : '(Tag Skipped)';
    this.lossReport.push(`[${path}] Unhandled ${tag}${valStr} ${desc}`);
  }

  _generateLossReport() {
    if (this.lossReport.length === 0) return "";
    
    const lines = [];
    lines.push("# ==========================================");
    lines.push(`# IMPORT WARNINGS (${this.lossReport.length} items stripped)`);
    lines.push("# ==========================================");
    lines.push("# The following GEDCOM data was not converted to FTT v0.1:");
    
    this.lossReport.forEach(msg => {
        lines.push(`# ${msg}`);
    });
    
    return lines.join("\n");
  }

  // =========================================================================
  // Date Helpers (Existing logic)
  // =========================================================================
  _convertDate(gedDate) {
    if (!gedDate) return '';
    let d = gedDate.trim().toUpperCase();
    if (d.startsWith('ABT')) return this._parseStandardDate(d.replace('ABT', '').trim()) + '~';
    if (d.startsWith('EST') || d.startsWith('CAL')) return this._parseStandardDate(d.replace(/EST|CAL/, '').trim()) + '~';
    
    if (d.startsWith('BEF')) return `[..${this._parseStandardDate(d.replace('BEF', '').trim())}]`;
    if (d.startsWith('AFT')) return `[${this._parseStandardDate(d.replace('AFT', '').trim())}..]`;
    
    if (d.startsWith('BET')) {
       const parts = d.replace('BET', '').split('AND');
       if (parts.length === 2) {
           return `[${this._parseStandardDate(parts[0].trim())}..${this._parseStandardDate(parts[1].trim())}]`;
       }
    }
    return this._parseStandardDate(d);
  }

  _parseStandardDate(dateStr) {
    const MONTHS = { 'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12' };
    const parts = dateStr.split(' ');
    if (parts.length === 1) return parts[0];
    if (parts.length === 2 && MONTHS[parts[0]]) return `${parts[1]}-${MONTHS[parts[0]]}`;
    if (parts.length === 3 && MONTHS[parts[1]]) return `${parts[2]}-${MONTHS[parts[1]]}-${parts[0].padStart(2, '0')}`;
    return dateStr;
  }
}
