import FTTParser from '../../implementations/js/FTTParser.js';

document.addEventListener('DOMContentLoaded', () => {
    const btnCalc = document.getElementById('btn-calc');
    const txtSource = document.getElementById('ftt-source');
    const inpId1 = document.getElementById('id1');
    const inpId2 = document.getElementById('id2');
    const resultBox = document.getElementById('result-box');
    
    // File I/O Elements
    const btnOpenFile = document.getElementById('btn-open-file');
    const fileInput = document.getElementById('file-input');

    const showError = (message) => {
        resultBox.textContent = ''; 
        const span = document.createElement('span');
        span.className = 'error';
        span.textContent = message;
        resultBox.appendChild(span);
    };

    // --- File Loading Logic ---
    btnOpenFile.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            txtSource.value = e.target.result;
            resultBox.innerHTML = '<span style="color:#ccc;">File loaded. Enter IDs to calculate.</span>';
        };
        reader.readAsText(file);
        fileInput.value = '';
    });

    // --- Calculation Logic ---
    btnCalc.addEventListener('click', () => {
        const source = txtSource.value;
        const id1 = inpId1.value.trim();
        const id2 = inpId2.value.trim();

        if (!source || !id1 || !id2) {
            showError('Please provide FTT data and both IDs.');
            return;
        }

        try {
            const parser = new FTTParser();
            const parseResult = parser.parse(source);

            if (parseResult.errors.length > 0) {
                showError(`Parse Error: ${parseResult.errors[0]}`);
                return;
            }

            const records = parseResult.records;
            if (!records[id1]) throw new Error(`ID "${id1}" not found.`);
            if (!records[id2]) throw new Error(`ID "${id2}" not found.`);

            const calculator = new RelationshipCalculator(records);
            const relationships = calculator.calculate(id1, id2);
            
            renderResult(relationships, records, id1, id2);

        } catch (e) {
            showError(e.message);
            console.error(e);
        }
    });
});

/**
 * Relationship Calculator
 * Uses Lowest Common Ancestor (LCA) logic to find all distinct paths.
 * Supports composite relationships (e.g. "Spouse AND 2nd Cousin").
 */
class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        // Build efficient lookups
        this.parents = new Map(); // ID -> [ParentIDs]
        this.spouses = new Map(); // ID -> [SpouseIDs]

        Object.values(records).forEach(rec => {
            // Index Parents
            const pList = [];
            if (rec.data.PARENT) {
                rec.data.PARENT.forEach(p => pList.push(p.parsed[0]));
            }
            this.parents.set(rec.id, pList);

            // Index Spouses (Union)
            const sList = [];
            if (rec.data.UNION) {
                rec.data.UNION.forEach(u => sList.push(u.parsed[0]));
            }
            this.spouses.set(rec.id, sList);
        });
    }

    /**
     * Main Entry Point
     * Returns an ARRAY of relationship objects to support composite results.
     */
    calculate(idA, idB) {
        if (idA === idB) return [{ type: 'IDENTITY' }];

        let results = [];

        // 1. Check Direct Union
        if (this._isSpouse(idA, idB)) {
            results.push({ type: 'UNION', target: idB });
        }

        // 2. Check Blood Relationships (via LCA)
        const bloodRels = this._findBloodRelationships(idA, idB);
        bloodRels.forEach(rel => results.push(rel));

        // 3. Check Affinal (In-Laws)
        // A -> Spouse -> Blood -> B
        const spousesA = this.spouses.get(idA) || [];
        spousesA.forEach(spouseId => {
            if (spouseId === idB) return; 
            
            const rels = this._findBloodRelationships(spouseId, idB);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel
                });
            });
        });

        // A -> Blood -> Spouse -> B
        const spousesB = this.spouses.get(idB) || [];
        spousesB.forEach(spouseId => {
            if (spouseId === idA) return;

            const rels = this._findBloodRelationships(idA, spouseId);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel
                });
            });
        });

        // Fallback
        if (results.length === 0) return [{ type: 'NONE' }];

        // 4. Clean Up and Deduplicate
        results = this._deduplicateResults(results);
        
        // 5. Filter Redundant Step-Relationships
        // If A is the Parent of B (Blood), remove "Step-Parent" (Affinal via Spouse)
        const isParent = results.some(r => r.type === 'BLOOD' && r.distA === 0);
        if (isParent) {
            results = results.filter(r => !(r.type === 'AFFINAL' && r.subType === 'VIA_SPOUSE'));
        }
        
        // If A is the Child of B (Blood), remove "Step-Child" (Affinal via Blood Spouse)
        const isChild = results.some(r => r.type === 'BLOOD' && r.distB === 0);
        if (isChild) {
             results = results.filter(r => !(r.type === 'AFFINAL' && r.subType === 'VIA_BLOOD_SPOUSE'));
        }

        return results;
    }

    // =========================================================================
    // Core Algorithms
    // =========================================================================

    _findBloodRelationships(idA, idB) {
        const ancA = this._getAllAncestors(idA);
        const ancB = this._getAllAncestors(idB);

        // Include Self
        ancA.set(idA, 0);
        ancB.set(idB, 0);

        const commonAncestors = [];
        for (const [id, distA] of ancA) {
            if (ancB.has(id)) {
                commonAncestors.push({
                    id,
                    distA: distA,
                    distB: ancB.get(id)
                });
            }
        }

        if (commonAncestors.length === 0) return [];

        // Filter for LCA
        const lcas = commonAncestors.filter(candidate => {
            const isRedundant = commonAncestors.some(other => {
                if (other.id === candidate.id) return false;
                return this._isAncestor(candidate.id, other.id);
            });
            return !isRedundant;
        });

        return lcas.map(lca => ({
            type: 'BLOOD',
            ancestorId: lca.id,
            distA: lca.distA,
            distB: lca.distB,
            isHalf: false 
        }));
    }

    _getAllAncestors(startId) {
        const visited = new Map(); // ID -> Distance
        const queue = [{ id: startId, dist: 0 }];

        while (queue.length > 0) {
            const { id, dist } = queue.shift();
            const parents = this.parents.get(id) || [];
            parents.forEach(pId => {
                if (!visited.has(pId)) {
                    visited.set(pId, dist + 1);
                    queue.push({ id: pId, dist: dist + 1 });
                }
            });
        }
        return visited;
    }

    _isAncestor(ancestorId, descendantId) {
        const queue = [descendantId];
        const visited = new Set();
        while(queue.length > 0) {
            const curr = queue.shift();
            if (curr === ancestorId) return true;
            if (visited.has(curr)) continue;
            visited.add(curr);
            
            const parents = this.parents.get(curr) || [];
            parents.forEach(p => queue.push(p));
        }
        return false;
    }

    _isSpouse(idA, idB) {
        const spouses = this.spouses.get(idA) || [];
        return spouses.includes(idB);
    }

    _deduplicateResults(results) {
        const unique = new Map();
        results.forEach(res => {
            let key = `${res.type}`;
            if (res.type === 'BLOOD') key += `-${res.distA}-${res.distB}`;
            if (res.type === 'UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            
            if (!unique.has(key)) {
                unique.set(key, res);
            }
        });
        return Array.from(unique.values());
    }
}

// ==========================================
// Rendering & Terminology (Composite)
// ==========================================

function renderResult(relationships, records, idA, idB) {
    const nameA = getDisplayName(records[idA]);
    const nameB = getDisplayName(records[idB]);
    const genderA = getGender(records[idA]);
    
    const resultBox = document.getElementById('result-box');
    resultBox.textContent = '';

    const div1 = document.createElement('div');
    const strongA = document.createElement('strong');
    strongA.textContent = nameA;
    div1.appendChild(strongA);
    div1.appendChild(document.createTextNode(' is the'));
    resultBox.appendChild(div1);

    const textGen = new RelationText(records);
    
    if (relationships.length === 1 && relationships[0].type === 'NONE') {
         // ... [No change] ...
         const spanTerm = document.createElement('span');
         spanTerm.className = 'relationship-term';
         spanTerm.textContent = "No Relation Found";
         spanTerm.style.color = "#999";
         spanTerm.style.fontSize = "1.5rem";
         resultBox.appendChild(spanTerm);
    } else {
        const terms = [];
        const details = [];

        relationships.forEach(rel => {
            const { term, detail } = textGen.describe(rel, genderA, nameB, nameA);
            terms.push(term);
            if (detail) details.push(detail);
        });

        const spanTerm = document.createElement('span');
        spanTerm.className = 'relationship-term';
        spanTerm.textContent = terms.join(' AND ');
        resultBox.appendChild(spanTerm);

        const div2 = document.createElement('div');
        div2.appendChild(document.createTextNode('of '));
        const strongB = document.createElement('strong');
        strongB.textContent = nameB;
        div2.appendChild(strongB);
        resultBox.appendChild(div2);

        if (details.length > 0) {
            const divDetail = document.createElement('div');
            divDetail.className = 'path-detail';
            if (details.length > 1) {
                divDetail.innerHTML = '<ul>' + details.map(d => `<li>${d.replace(/\n/g, '<br>')}</li>`).join('') + '</ul>';
            } else {
                divDetail.textContent = details[0];
            }
            resultBox.appendChild(divDetail);
        }
    }
}

class RelationText {
    constructor(records) {
        this.records = records;
    }

    describe(rel, genderA, nameB, nameA) {
        if (rel.type === 'IDENTITY') {
            return { term: "Same Person", detail: "" };
        }
        if (rel.type === 'UNION') {
            const t = genderA === 'M' ? "Husband" : genderA === 'F' ? "Wife" : "Spouse";
            return { term: t, detail: "Direct Union record found." };
        }
        if (rel.type === 'BLOOD') {
            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf);
            const commonName = getDisplayName(this.records[rel.ancestorId]);
            return {
                term: term,
                detail: `Common Ancestor: ${commonName} (${rel.distA} steps up from ${nameA}, ${rel.distB} steps up from ${nameB}).`
            };
        }
        if (rel.type === 'AFFINAL') {
            return this.describeAffinal(rel, genderA, nameB, nameA);
        }
        return { term: "Unknown", detail: "" };
    }

    describeAffinal(rel, genderA, nameB, nameA) {
        if (rel.subType === 'VIA_SPOUSE') {
            const dSpouseToCA = rel.bloodRel.distA;
            const dBToCA = rel.bloodRel.distB;
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            
            let term = "In-Law";

            if (dSpouseToCA === 0 && dBToCA > 0) {
                term = "Step-" + this.getAncestorTerm(dBToCA, genderA);
            } else if (dBToCA === 0 && dSpouseToCA > 0) {
                 const descTerm = this.getDescendantTerm(dSpouseToCA, genderA);
                 term = descTerm + "-in-law";
            } else if (dSpouseToCA === 1 && dBToCA === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const spouseToBTerm = this.getBloodTerm(dSpouseToCA, dBToCA, 'U', false);
                term = `Spouse of ${spouseToBTerm}`;
            }

            return {
                term: term,
                detail: `${nameA} is the spouse of ${spouseName}, who is the ${this.getBloodTerm(dSpouseToCA, dBToCA, 'U', false)} of ${nameB}.`
            };
        }

        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            const dAtoCA = rel.bloodRel.distA;
            const dRelToCA = rel.bloodRel.distB;
            const relativeName = getDisplayName(this.records[rel.spouseId]);
            
            let term = "In-Law";

            if (dAtoCA === 0 && dRelToCA > 0) {
                term = this.getAncestorTerm(dRelToCA, genderA) + "-in-law";
            } else if (dRelToCA === 0 && dAtoCA > 0) {
                term = "Step-" + this.getDescendantTerm(dAtoCA, genderA);
            } else if (dAtoCA === 1 && dRelToCA === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const aToRelTerm = this.getBloodTerm(dAtoCA, dRelToCA, genderA, false);
                term = `${aToRelTerm}-in-law`;
            }

            // No "you" used here previously, but consistent naming is good.
            return {
                term: term,
                detail: `${nameB} is the spouse of ${nameA}'s relative, ${relativeName} (${this.getBloodTerm(dAtoCA, dRelToCA, 'U', false)}).`
            };
        }
        return { term: "Affinal", detail: "Complex in-law relationship." };
    }

    getBloodTerm(distA, distB, sex, isHalf) {
        const halfPrefix = isHalf ? "Half-" : "";
        
        // Direct Line
        if (distA === 0) return this.getAncestorTerm(distB, sex);   // A is Ancestor (0 steps away from CA=Self)
        if (distB === 0) return this.getDescendantTerm(distA, sex); // B is Ancestor, so A is Descendant

        // Sibling
        if (distA === 1 && distB === 1) {
            return halfPrefix + (sex === 'M' ? "Brother" : sex === 'F' ? "Sister" : "Sibling");
        }

        // Avuncular
        if (distA === 1 && distB > 1) { 
            const core = this.getNiblingTerm(distB - 1, sex, true);
            return isHalf ? "Half-" + core : core;
        }
        if (distB === 1 && distA > 1) { 
            const core = this.getNiblingTerm(distA - 1, sex, false);
            return isHalf ? "Half-" + core : core;
        }

        // Cousins
        const degree = Math.min(distA, distB) - 1;
        const removed = Math.abs(distA - distB);
        const core = this.getCousinTerm(degree, removed);
        return isHalf ? "Half-" + core : core;
    }

    getAncestorTerm(dist, sex) {
        if (dist === 1) return sex === 'M' ? "Father" : sex === 'F' ? "Mother" : "Parent";
        if (dist === 2) return sex === 'M' ? "Grandfather" : sex === 'F' ? "Grandmother" : "Grandparent";
        if (dist === 3) return sex === 'M' ? "Great-Grandfather" : sex === 'F' ? "Great-Grandmother" : "Great-Grandparent";
        return `${dist-2}x Great-Grandparent`;
    }

    getDescendantTerm(dist, sex) {
        if (dist === 1) return sex === 'M' ? "Son" : sex === 'F' ? "Daughter" : "Child";
        if (dist === 2) return sex === 'M' ? "Grandson" : sex === 'F' ? "Granddaughter" : "Grandchild";
        if (dist === 3) return sex === 'M' ? "Great-Grandson" : sex === 'F' ? "Great-Granddaughter" : "Great-Grandchild";
        return `${dist-2}x Great-Grandchild`;
    }

    getNiblingTerm(genDiff, sex, isUncleAunt) {
        if (isUncleAunt) {
            if (genDiff === 1) return sex === 'M' ? "Uncle" : sex === 'F' ? "Aunt" : "Pibling";
            if (genDiff === 2) return sex === 'M' ? "Great-Uncle" : sex === 'F' ? "Great-Aunt" : "Grand-Uncle/Aunt";
            return `${genDiff-2}x Great-Uncle/Aunt`;
        } else {
            if (genDiff === 1) return sex === 'M' ? "Nephew" : sex === 'F' ? "Niece" : "Nibling";
            if (genDiff === 2) return sex === 'M' ? "Great-Nephew" : sex === 'F' ? "Great-Niece" : "Grand-Nibling";
            return `${genDiff-2}x Great-Niece/Nephew`;
        }
    }

    getCousinTerm(degree, removed) {
        let ord = "Cousin";
        if (degree === 1) ord = "1st Cousin";
        else if (degree === 2) ord = "2nd Cousin";
        else if (degree === 3) ord = "3rd Cousin";
        else ord = `${degree}th Cousin`;

        if (removed === 0) return ord;
        if (removed === 1) return `${ord} 1x Removed`;
        return `${ord} ${removed}x Removed`;
    }
}

// --- General Utils ---

function getDisplayName(rec) {
    if (!rec) return "Unknown";
    if (rec.data.NAME) {
        const pref = rec.data.NAME.find(n => n.parsed[3] === 'PREF');
        if (pref) return pref.parsed[0];
        if (rec.data.NAME[0]) return rec.data.NAME[0].parsed[0];
    }
    return rec.id;
}

function getGender(rec) {
    if (rec && rec.data.SEX && rec.data.SEX[0]) {
        return rec.data.SEX[0].parsed[0].trim().toUpperCase();
    }
    return 'U';
}
