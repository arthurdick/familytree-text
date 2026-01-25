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
        this.lineageParents = new Map(); // BIO, ADO, LEGL
        this.allParents = new Map();     // All types (for Step detection)
        this.spouses = new Map();        // ID -> [SpouseIDs]
        this.parentTypes = new Map();    // Helper: ID -> Map<ParentID, Type>

        Object.values(records).forEach(rec => {
            const lList = [];
            const aList = [];
            const typeMap = new Map();

            if (rec.data.PARENT) {
                rec.data.PARENT.forEach(p => {
                    const pId = p.parsed[0];
                    // Default to BIO if missing, uppercase for safety
                    const pType = (p.parsed[1] || 'BIO').toUpperCase().trim();
                    
                    // Index all parents for Step-Sibling logic
                    aList.push(pId);
                    typeMap.set(pId, pType);

                    // Filter Lineage Parents: 
                    // We accept BIO, ADO, LEGL, SURR, DONR, IV.
                    // We REJECT STE (Step) and FOS (Foster) for blood/lineage traversal.
                    const VALID_LINEAGE = ['BIO', 'ADO', 'LEGL', 'SURR', 'DONR'];
                    if (VALID_LINEAGE.includes(pType) || !pType) {
                        lList.push(pId);
                    }
                });
            }
            this.lineageParents.set(rec.id, lList);
            this.allParents.set(rec.id, aList);
            this.parentTypes.set(rec.id, typeMap);

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

        // 2. Check Lineage Relationships (Blood/Adoptive)
        const bloodRels = this._findLineageRelationships(idA, idB);
        bloodRels.forEach(rel => results.push(rel));

        // 3. Check Affinal (In-Laws)
        // A -> Spouse -> Lineage -> B
        const spousesA = this.spouses.get(idA) || [];
        spousesA.forEach(spouseId => {
            if (spouseId === idB) return; 
            
            const rels = this._findLineageRelationships(spouseId, idB);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel
                });
            });
        });

        // A -> Lineage -> Spouse -> B
        const spousesB = this.spouses.get(idB) || [];
        spousesB.forEach(spouseId => {
            if (spouseId === idA) return;

            const rels = this._findLineageRelationships(idA, spouseId);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel
                });
            });
        });

        // 4. Step-Siblings (Strict)
        // Check if a parent of A is married to a parent of B, but they share NO lineage parents.
        if (bloodRels.length === 0) {
            const parentsA = this.allParents.get(idA) || [];
            const parentsB = this.allParents.get(idB) || [];
            
            for (const pA of parentsA) {
                for (const pB of parentsB) {
                    // If parents are married to each other
                    if (this._isSpouse(pA, pB)) {
                        results.push({
                            type: 'STEP_SIBLING',
                            parentA: pA,
                            parentB: pB
                        });
                    }
                }
            }
        }

        // Fallback
        if (results.length === 0) return [{ type: 'NONE' }];

        // 5. Clean Up and Deduplicate
        results = this._deduplicateResults(results);

        // 6. Filter Redundant Step-Relationships
        const isParent = results.some(r => r.type === 'LINEAGE' && r.distA === 0);
        if (isParent) {
            results = results.filter(r => !(r.type === 'AFFINAL' && r.subType === 'VIA_SPOUSE'));
        }
        
        const isChild = results.some(r => r.type === 'LINEAGE' && r.distB === 0);
        if (isChild) {
             results = results.filter(r => !(r.type === 'AFFINAL' && r.subType === 'VIA_BLOOD_SPOUSE'));
        }

        return results;
    }

    // =========================================================================
    // Core Algorithms
    // =========================================================================

    /**
     * Finds relationships using LCA on the Lineage Graph.
     * Handles Double Cousins and Robust Half-Sibling logic.
     */
    _findLineageRelationships(idA, idB) {
        const ancA = this._getAllAncestors(idA);
        const ancB = this._getAllAncestors(idB);

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

        // Filter for Lowest Common Ancestors (LCA)
        let lcas = commonAncestors.filter(candidate => {
            return !commonAncestors.some(other => {
                if (other.id === candidate.id) return false;
                // Use strict lineage ancestry for LCA check
                return this._isAncestor(candidate.id, other.id);
            });
        });

        // Group LCAs by their distances (Generational Tier)
        const tiers = new Map();
        lcas.forEach(lca => {
            const tierKey = `${lca.distA}-${lca.distB}`;
            if (!tiers.has(tierKey)) tiers.set(tierKey, []);
            tiers.get(tierKey).push(lca);
        });

        const finalRels = [];
        tiers.forEach((group, tierKey) => {
            const [distA, distB] = tierKey.split('-').map(Number);
            
            // --- Logic for Half / Double / Adoptive ---
            
            // 1. Ancestor Count Logic
            const lcaCount = group.length;
            
            let isHalf = false;
            let isDouble = false;

            // Sibling Logic (Distance 1-1)
            if (distA === 1 && distB === 1) {
                if (lcaCount >= 2) {
                    // Shares 2 (or more) parents -> Full Sibling
                    isHalf = false;
                } else {
                    // Shares only 1 parent.
                    // CHECK: Is this "Half" or just "Missing Data"?
                    const pA = this.lineageParents.get(idA);
                    const pB = this.lineageParents.get(idB);
                    
                    // If either side has < 2 known parents, we assume Missing Data -> Full
                    // Only flag Half if we have data to prove disparate parents.
                    if (pA.length >= 2 && pB.length >= 2) {
                        isHalf = true;
                    } else {
                        isHalf = false; // "Assumed Full"
                    }
                }
            } 
            // Cousin Logic (Distance > 1)
            else if (distA > 1 && distB > 1) {
                // If you share 2 grandparents (count=2), you are Double Cousins.
                if (lcaCount >= 2) isDouble = true;
            }

            // 2. Adoptive Path Detection
            // If the path from A->LCA or B->LCA traverses an 'ADO' link, flag it.
            // Since we merged the group, we check if ANY LCA in the group relies on adoption.
            let isAdoptive = false;
            group.forEach(lca => {
                if (this._pathHasType(idA, lca.id, 'ADO') || this._pathHasType(idB, lca.id, 'ADO')) {
                    isAdoptive = true;
                }
            });

            finalRels.push({
                type: 'LINEAGE',
                ancestorIds: group.map(g => g.id),
                distA,
                distB,
                isHalf,
                isDouble,
                isAdoptive
            });
        });

        return finalRels;
    }

    _getAllAncestors(startId) {
        const visited = new Map(); // ID -> Distance
        const queue = [{ id: startId, dist: 0 }];
        
        while (queue.length > 0) {
            const { id, dist } = queue.shift();
            // Use lineageParents (BIO/ADO) only
            const parents = this.lineageParents.get(id) || [];
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
        // BFS check using lineage parents
        const queue = [descendantId];
        const visited = new Set();
        while(queue.length > 0) {
            const curr = queue.shift();
            if (curr === ancestorId) return true;
            if (visited.has(curr)) continue;
            visited.add(curr);
            
            const parents = this.lineageParents.get(curr) || [];
            parents.forEach(p => queue.push(p));
        }
        return false;
    }

    _pathHasType(startId, endId, targetType) {
        // DFS to find if path involves specific relationship type
        if (startId === endId) return false;
        
        const stack = [{ id: startId, found: false }];
        const visited = new Set();

        while(stack.length > 0) {
            const { id, found } = stack.pop();
            
            if (id === endId) return found; // Path complete
            if (visited.has(id)) continue;
            visited.add(id);

            const parents = this.lineageParents.get(id) || [];
            const types = this.parentTypes.get(id);

            parents.forEach(pId => {
                const type = types.get(pId);
                const isTarget = (type === targetType);
                stack.push({ id: pId, found: found || isTarget });
            });
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
            if (res.type === 'LINEAGE') key += `-${res.distA}-${res.distB}-${res.isDouble}`;
            if (res.type === 'UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            if (res.type === 'STEP_SIBLING') {
                const parents = [res.parentA, res.parentB].sort().join('-');
                key += `-${parents}`;
            }
            
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
        if (rel.type === 'STEP_SIBLING') {
            const t = genderA === 'M' ? "Step-Brother" : genderA === 'F' ? "Step-Sister" : "Step-Sibling";
            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);
            return { 
                term: t, 
                detail: `Parents are married: ${pAName} and ${pBName}.` 
            };
        }
        if (rel.type === 'LINEAGE') {
            // Standard Blood/Adoptive Logic
            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf, rel.isDouble, rel.isAdoptive);
            const commonName = getDisplayName(this.records[rel.ancestorIds[0]]);
            const lcaCount = rel.ancestorIds.length;
            
            const sA = rel.distA === 1 ? "step" : "steps";
            const sB = rel.distB === 1 ? "step" : "steps";
            
            let det = `Common Ancestor: ${commonName}`;
            if (lcaCount > 1) det += ` (+ ${lcaCount - 1} other${lcaCount > 2 ? 's' : ''})`;
            det += ` (${rel.distA} ${sA} up from ${nameA}, ${rel.distB} ${sB} up from ${nameB}).`;
            
            if (rel.isAdoptive) det += ` [Includes Adoptive Link]`;

            return { term: term, detail: det };
        }
        if (rel.type === 'AFFINAL') {
            return this.describeAffinal(rel, genderA, nameB, nameA);
        }
        return { term: "Unknown", detail: "" };
    }

    describeAffinal(rel, genderA, nameB, nameA) {
        // Case 1: Relationship via "My Spouse" (e.g. My Spouse's Sister)
        if (rel.subType === 'VIA_SPOUSE') {
            const dSpouseToCA = rel.bloodRel.distA;
            const dBToCA = rel.bloodRel.distB;
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            
            const spouseGender = getGender(this.records[rel.spouseId]);
            
            let term = "In-Law";
            if (dSpouseToCA === 0 && dBToCA > 0) {
                // Spouse's Parent -> Father/Mother-in-law
                term = "Step-" + this.getAncestorTerm(dBToCA, genderA);
            } else if (dBToCA === 0 && dSpouseToCA > 0) {
                 // Spouse's Child (not mine) -> Step-Son/Daughter
                 const descTerm = this.getDescendantTerm(dSpouseToCA, genderA);
                 term = descTerm + "-in-law"; // Conventionally treated as Step-Child
            } else if (dSpouseToCA === 1 && dBToCA === 1) {
                // Spouse's Sibling -> Brother/Sister-in-law
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                // Extended: Spouse of [Relation]
                const spouseToBTerm = this.getBloodTerm(dSpouseToCA, dBToCA, spouseGender, false, false, false);
                term = `Spouse of ${spouseToBTerm}`;
            }

            return {
                term: term,
                detail: `${nameA} is the spouse of ${spouseName}, who is the ${this.getBloodTerm(dSpouseToCA, dBToCA, spouseGender, false, false, false)} of ${nameB}.`
            };
        }

        // Case 2: Relationship via "My Relative's Spouse" (e.g. My Brother's Wife)
        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            const dAtoCA = rel.bloodRel.distA;
            const dRelToCA = rel.bloodRel.distB;
            const relativeName = getDisplayName(this.records[rel.spouseId]);
            
            const relativeGender = getGender(this.records[rel.spouseId]);
            
            let term = "In-Law";
            if (dAtoCA === 0 && dRelToCA > 0) {
                term = this.getAncestorTerm(dRelToCA, genderA) + "-in-law";
            } else if (dRelToCA === 0 && dAtoCA > 0) {
                term = "Step-" + this.getDescendantTerm(dAtoCA, genderA);
            } else if (dAtoCA === 1 && dRelToCA === 1) {
                // Sibling's Spouse -> Brother/Sister-in-law
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const aToRelTerm = this.getBloodTerm(dAtoCA, dRelToCA, genderA, false, false, false);
                term = `${aToRelTerm}-in-law`;
            }

            return {
                term: term,
                detail: `${nameB} is the spouse of ${nameA}'s relative, ${relativeName} (${this.getBloodTerm(dAtoCA, dRelToCA, relativeGender, false, false, false)}).`
            };
        }
        return { term: "Affinal", detail: "Complex in-law relationship." };
    }

    getBloodTerm(distA, distB, sex, isHalf, isDouble, isAdoptive) {
        let prefix = "";
        if (isHalf) prefix = "Half-";
        if (isDouble) prefix = "Double ";
        
        let suffix = "";
        if (isAdoptive) suffix = " (Adoptive)";

        // Direct Line (Parent/Child/Grand...)
        if (distA === 0) return this.getAncestorTerm(distB, sex) + suffix;
        if (distB === 0) return this.getDescendantTerm(distA, sex) + suffix;

        // Sibling
        if (distA === 1 && distB === 1) {
            return prefix + (sex === 'M' ? "Brother" : sex === 'F' ? "Sister" : "Sibling") + suffix;
        }

        // Avuncular
        if (distA === 1 && distB > 1) { 
            const core = this.getNiblingTerm(distB - 1, sex, true);
            return prefix + core + suffix;
        }
        if (distB === 1 && distA > 1) { 
            const core = this.getNiblingTerm(distA - 1, sex, false);
            return prefix + core + suffix;
        }

        // Cousins
        const degree = Math.min(distA, distB) - 1;
        const removed = Math.abs(distA - distB);
        const core = this.getCousinTerm(degree, removed);
        
        return prefix + core + suffix;
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
