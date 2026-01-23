/**
 * GedcomImporter (v0.1)
 * Converts GEDCOM 5.5.1 to FamilyTree-Text (FTT).
 *
 * Usage:
 * const converter = new GedcomImporter();
 * const fttOutput = converter.convert(gedcomString);
 */

export default class GedcomImporter {
  constructor() {
    this.individuals = new Map();
    this.families = new Map();
    this.sources = new Map();
  }

  convert(gedcomData) {
    this._reset();
    this._firstPassParse(gedcomData);
    return this._generateFTT();
  }

  _reset() {
    this.individuals.clear();
    this.families.clear();
    this.sources.clear();
  }

// =========================================================================
  // Pass 1: Parse GEDCOM into Memory Objects
  // =========================================================================
  _firstPassParse(data) {
    const lines = data.split(/\r?\n/);
    let currentRecord = null;
    let stack = []; // To handle hierarchy levels

    lines.forEach((line) => {
      line = line.trim();
      if (!line) return;

      // 1. Tokenize the line
      // GEDCOM is strict: Level + Space + [Optional ID] + Space + Tag + [Space + Value]
      const parts = line.split(/\s+/);
      const level = parseInt(parts[0], 10);
      
      let id = null;
      let tag = null;
      let value = '';

      // Check if the second token is an ID (Starts/Ends with @)
      if (parts[1] && parts[1].startsWith('@') && parts[1].endsWith('@')) {
          // Format: 0 @I1@ INDI
          id = parts[1];
          tag = parts[2];
          // Value is everything after the tag
          value = parts.slice(3).join(' '); 
      } else {
          // Format: 1 NAME John Doe
          tag = parts[1];
          // Value is everything after the tag
          value = parts.slice(2).join(' ');
      }

      // Cleanup
      const cleanId = id ? id.replace(/@/g, '') : null;
      if (!tag) return; // Skip malformed lines

      const node = { tag, value, children: [] };

      if (level === 0) {
        // New Record Start
        currentRecord = { id: cleanId, type: tag, ...node };
        stack = [currentRecord]; // Reset stack, index 0 is root

        // Store based on Type
        if (tag === 'INDI') this.individuals.set(cleanId, currentRecord);
        else if (tag === 'FAM') this.families.set(cleanId, currentRecord);
        else if (tag === 'SOUR') this.sources.set(cleanId, currentRecord);

      } else {
        // Child Node
        // Parent is always at level - 1
        // Safety: Ensure stack has a parent at this level
        if (stack[level - 1]) {
          stack[level - 1].children.push(node);
          stack[level] = node; // Set this node as the parent for level + 1
        }
      }
    });
  }

  // =========================================================================
  // Pass 2: Generate FTT Output
  // =========================================================================
  _generateFTT() {
    const output = [];

    // 1. Headers
    output.push(`HEAD_FORMAT: FTT v0.1`);
    output.push(`HEAD_DATE: ${new Date().toISOString().split('T')[0]}`);
    output.push(`HEAD_TITLE: GEDCOM Import`);
    output.push('---');
    output.push('');

    // 2. Sources (Converted first so they are defined)
    if (this.sources.size > 0) {
      output.push('# ==========================================');
      output.push('# SOURCES');
      output.push('# ==========================================');
      output.push('');
      for (const [id, rec] of this.sources) {
        this._writeSource(rec, output);
      }
      output.push('---');
      output.push('');
    }

    // 3. Individuals
    output.push('# ==========================================');
    output.push('# RECORDS');
    output.push('# ==========================================');
    output.push('');

    for (const [indiId, indi] of this.individuals) {
      this._writeIndividual(indi, output);
      output.push(''); // Spacer between records
    }

    return output.join('\n');
  }

  // --- Output Helpers ---

  _writeSource(rec, out) {
    const fttId = `^${rec.id}`; // Prefix source IDs with ^
    out.push(`ID: ${fttId}`);

    const title = this._findTag(rec, 'TITL');
    if (title) out.push(`TITLE: ${title}`);

    const auth = this._findTag(rec, 'AUTH');
    if (auth) out.push(`AUTHOR: ${auth}`);
  }

  _writeIndividual(indi, out) {
    out.push(`ID: ${indi.id}`);

    // NAME
    const nameNode = indi.children.find(c => c.tag === 'NAME');
    if (nameNode) {
      const rawName = nameNode.value || '';
      // GEDCOM: John /Smith/ -> FTT: John Smith | Smith, John
      const display = rawName.replace(/\//g, '').trim();
      const match = rawName.match(/(.*)\/(.*)\/(.*)/);
      let sortKey = '';
      if (match) {
        const given = (match[1] + ' ' + match[3]).trim();
        const sur = match[2].trim();
        sortKey = `${sur}, ${given}`;
      }
      out.push(`NAME: ${display} | ${sortKey} | BIRTH | PREF`);
    }

    // SEX
    const sex = this._findTag(indi, 'SEX');
    if (sex) out.push(`SEX:  ${sex}`);

    // VITAL EVENTS (BIRT/DEAT)
    this._writeEvent(indi, 'BIRT', 'BORN', out);
    this._writeEvent(indi, 'DEAT', 'DIED', out);

    // LOGIC TRANSFORMATION: FAM -> PARENT / UNION
    // In GEDCOM, links are stored in FAM records. We must reverse-lookup.

    // A. Find Parents (Where am I a Child?)
    // Look for FAMC tags in the Individual record
    const famcNodes = indi.children.filter(c => c.tag === 'FAMC');
    famcNodes.forEach(famc => {
      const famId = famc.value.replace(/@/g, '');
      const fam = this.families.get(famId);
      if (fam) {
        const husbId = this._findTag(fam, 'HUSB')?.replace(/@/g, '');
        const wifeId = this._findTag(fam, 'WIFE')?.replace(/@/g, '');

        if (husbId) out.push(`PARENT: ${husbId} | BIO`);
        if (wifeId) out.push(`PARENT: ${wifeId} | BIO`);
      }
    });

    // B. Find Spouses (Where am I a Spouse?)
    // Look for FAMS tags
    const famsNodes = indi.children.filter(c => c.tag === 'FAMS');
    famsNodes.forEach(fams => {
      const famId = fams.value.replace(/@/g, '');
      const fam = this.families.get(famId);
      if (fam) {
        const husbId = this._findTag(fam, 'HUSB')?.replace(/@/g, '');
        const wifeId = this._findTag(fam, 'WIFE')?.replace(/@/g, '');
        
        // Determine "The Other Person"
        let spouseId = null;
        if (indi.id === husbId) spouseId = wifeId;
        else if (indi.id === wifeId) spouseId = husbId;

        if (spouseId) {
            // Check for Marriage Date in FAM record
            const marrNode = fam.children.find(c => c.tag === 'MARR');
            let dateStr = '';
            if (marrNode) {
                const d = this._findTag(marrNode, 'DATE');
                if (d) dateStr = this._convertDate(d);
            }
            
            // Check for Divorce
            const divNode = fam.children.find(c => c.tag === 'DIV');
            let endReason = divNode ? 'DIV' : '';

            // Construct FTT UNION line
            // UNION: [ID] | [TYPE] | [START] | [END] | [REASON]
            out.push(`UNION: ${spouseId} | MARR | ${dateStr} || ${endReason}`);
        }
      }
    });
  }

  _writeEvent(node, gedTag, fttKey, out) {
    const evtNode = node.children.find(c => c.tag === gedTag);
    if (evtNode) {
      const date = this._convertDate(this._findTag(evtNode, 'DATE'));
      const place = this._findTag(evtNode, 'PLAC') || '';
      // Simple Place Formatting: Ensure semicolons if commas used
      const fttPlace = place.replace(/,/g, ';');
      
      out.push(`${fttKey}: ${date} | ${fttPlace}`);

      // Handle Citations (SOUR inside Event)
      const sourNodes = evtNode.children.filter(c => c.tag === 'SOUR');
      sourNodes.forEach(s => {
        const sId = s.value.replace(/@/g, '');
        const page = this._findTag(s, 'PAGE') || '';
        out.push(`${fttKey}_SRC: ^${sId} | ${page}`);
      });
    }
  }

  // Helper to get simple child value
  _findTag(node, tag) {
    const child = node.children.find(c => c.tag === tag);
    return child ? child.value : null;
  }

  // =========================================================================
  // Date Parsing Logic (GEDCOM -> ISO/EDTF)
  // =========================================================================
  _convertDate(gedDate) {
    if (!gedDate) return '';
    let d = gedDate.trim().toUpperCase();

    // 1. Handle ABT (About) -> ~
    if (d.startsWith('ABT')) {
      d = d.replace('ABT', '').trim();
      return this._parseStandardDate(d) + '~';
    }

    // 2. Handle EST (Estimated) -> ~
    if (d.startsWith('EST') || d.startsWith('CAL')) {
        d = d.replace(/EST|CAL/, '').trim();
        return this._parseStandardDate(d) + '~';
    }

    // 3. Handle BET / AND (Between) -> [A..B]
    if (d.startsWith('BET')) {
       // BET 1900 AND 1910
       const parts = d.replace('BET', '').split('AND');
       if (parts.length === 2) {
           const start = this._parseStandardDate(parts[0].trim());
           const end = this._parseStandardDate(parts[1].trim());
           return `[${start}..${end}]`;
       }
    }

    // 4. Standard Date
    return this._parseStandardDate(d);
  }

  _parseStandardDate(dateStr) {
    // GEDCOM Format: 12 MAY 1900 or MAY 1900 or 1900
    const MONTHS = {
      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06',
      'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };

    const parts = dateStr.split(' ');
    
    // Year only (1990)
    if (parts.length === 1) return parts[0];

    // Month Year (MAY 1990)
    if (parts.length === 2) {
        const m = MONTHS[parts[0]];
        if (m) return `${parts[1]}-${m}`;
        return dateStr; // Fallback
    }

    // Day Month Year (12 MAY 1990)
    if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const m = MONTHS[parts[1]];
        const y = parts[2];
        if (m) return `${y}-${m}-${day}`;
    }

    return dateStr; // Fallback if parsing fails
  }
}
