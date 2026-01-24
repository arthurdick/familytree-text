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
            const rel = calculator.calculate(id1, id2);
            
            renderResult(rel, records, id1, id2);

        } catch (e) {
            showError(e.message);
            console.error(e);
        }
    });
});

/**
 * Core Logic Class
 * Encapsulates the graph traversal and type detection.
 */
class RelationshipCalculator {
    constructor(records) {
        this.records = records;
    }

    calculate(idA, idB) {
        if (idA === idB) return { type: 'IDENTITY' };

        // 1. Direct Union (Spouse/Partner)
        const directUnion = this.checkDirectUnion(idA, idB);
        if (directUnion) return directUnion;

        // 2. Direct Association
        const directAssoc = this.checkDirectAssoc(idA, idB);
        if (directAssoc) return directAssoc;

        // 3. Blood Relationship (Common Ancestor)
        // Handles Full/Half Siblings, Cousins, etc.
        const blood = this.calculateBlood(idA, idB);
        if (blood) return blood;

        // 4. Affinal (In-Laws)
        // Checks Spouse's Blood, Blood's Spouse, and Spouse's Blood's Spouse
        const affinal = this.calculateAffinal(idA, idB);
        if (affinal) return affinal;

        return { type: 'NONE' };
    }

    // --- Checkers ---

    checkDirectUnion(idA, idB) {
        const recA = this.records[idA];
        if (recA.data.UNION) {
            const union = recA.data.UNION.find(u => u.parsed[0] === idB);
            if (union) {
                return { type: 'UNION', subType: union.parsed[1] || 'MARR' };
            }
        }
        return null;
    }

    checkDirectAssoc(idA, idB) {
        const recA = this.records[idA];
        const recB = this.records[idB];

        if (recA.data.ASSOC) {
            const assoc = recA.data.ASSOC.find(a => a.parsed[0] === idB);
            if (assoc) return { type: 'ASSOC', role: assoc.parsed[1] || 'ASSOCIATE', direction: 'FORWARD' };
        }
        if (recB.data.ASSOC) {
            const assoc = recB.data.ASSOC.find(a => a.parsed[0] === idA);
            if (assoc) return { type: 'ASSOC', role: assoc.parsed[1] || 'ASSOCIATE', direction: 'REVERSE' };
        }
        return null;
    }

    calculateBlood(idA, idB) {
        const ancA = this.getAncestors(idA);
        const ancB = this.getAncestors(idB);

        // Find intersections
        const commonIds = [...ancA.keys()].filter(id => ancB.has(id));
        if (commonIds.length === 0) return null;

        // Find the "Most Recent" Common Ancestor(s) (Lowest Distance sum)
        let minTotalDist = Infinity;
        let mrcas = [];

        commonIds.forEach(id => {
            const distA = ancA.get(id);
            const distB = ancB.get(id);
            const total = distA + distB;

            if (total < minTotalDist) {
                minTotalDist = total;
                mrcas = [{ id, distA, distB }];
            } else if (total === minTotalDist) {
                mrcas.push({ id, distA, distB });
            }
        });

        if (mrcas.length === 0) return null;

        const mrca = mrcas[0];
        let isHalf = false;

        // Determine if Half or Full
        // We only flag as "Half" if we find exactly 1 MRCA,
        // AND we can verify that the branches diverge via *different* second parents.
        // If second parents are missing (incomplete data), we assume Full.
        if (mrcas.length === 1 && mrca.distA > 0 && mrca.distB > 0) {
            isHalf = this.isHalfSiblingOrCousin(mrca.id, ancA, ancB);
        }

        return {
            type: 'BLOOD',
            ancestorId: mrca.id,
            distA: mrca.distA,
            distB: mrca.distB,
            isHalf: isHalf
        };
    }

    /**
     * Helper to verify if a relationship is "Half" by checking for conflicting second parents.
     * Returns true ONLY if both sides have a second parent defined and they are different.
     */
    isHalfSiblingOrCousin(mrcaId, ancMapA, ancMapB) {
        // 1. Find the direct child of MRCA that leads to A
        const childA = this.findChildOfAncestorInPath(mrcaId, ancMapA);
        // 2. Find the direct child of MRCA that leads to B
        const childB = this.findChildOfAncestorInPath(mrcaId, ancMapB);

        if (!childA || !childB) return false; 
        if (childA === childB) return false; // Same lineage branching lower down

        // 3. Get other parents of childA
        const parentsA = this.getOtherParents(childA, mrcaId);
        // 4. Get other parents of childB
        const parentsB = this.getOtherParents(childB, mrcaId);

        // 5. If either side has NO other parents listed, assume FULL (incomplete data)
        if (parentsA.length === 0 || parentsB.length === 0) return false;

        // 6. If they have other parents, but share NONE of them, it's HALF
        const sharesOtherParent = parentsA.some(p => parentsB.includes(p));
        return !sharesOtherParent;
    }

    findChildOfAncestorInPath(ancestorId, descendantAncestorsMap) {
        // Find the node in the descendant's ancestor set that lists 'ancestorId' as a parent
        for (const [id, dist] of descendantAncestorsMap) {
             const rec = this.records[id];
             if (rec && rec.data.PARENT) {
                 if (rec.data.PARENT.some(p => p.parsed[0] === ancestorId)) {
                     return id;
                 }
             }
        }
        return null;
    }

    getOtherParents(childId, excludeParentId) {
        const rec = this.records[childId];
        if (!rec || !rec.data.PARENT) return [];
        return rec.data.PARENT
            .map(p => p.parsed[0])
            .filter(pid => pid !== excludeParentId);
    }

    calculateAffinal(idA, idB) {
        const spousesA = this.getSpouseIDs(idA);
        const spousesB = this.getSpouseIDs(idB);

        // Path 1: A -> Spouse -> Blood Relative -> B (My Spouse's Family)
        for (const sA of spousesA) {
            const rel = this.calculateBlood(sA, idB);
            if (rel) {
                return {
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE_BLOOD',
                    spouseId: sA,
                    bloodRel: rel
                };
            }
        }

        // Path 2: A -> Blood Relative -> Spouse -> B (My Relative's Spouse)
        for (const sB of spousesB) {
            const rel = this.calculateBlood(idA, sB);
            if (rel) {
                return {
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE',
                    targetSpouseId: sB,
                    bloodRel: rel
                };
            }
        }

        // Path 3: A -> Spouse -> Blood Relative -> Spouse -> B (Joint Affinal)
        // e.g. "My Wife's Brother's Wife"
        for (const sA of spousesA) {
            for (const sB of spousesB) {
                // Don't loop back
                if (sA === sB) continue; 
                
                const rel = this.calculateBlood(sA, sB);
                if (rel) {
                    return {
                        type: 'AFFINAL',
                        subType: 'JOINT_AFFINAL',
                        spouseAId: sA,
                        spouseBId: sB,
                        bloodRel: rel
                    };
                }
            }
        }

        return null;
    }

    // --- Helpers ---

    getAncestors(startId) {
        const ancestors = new Map(); // ID -> Distance
        const queue = [{ id: startId, dist: 0 }];
        ancestors.set(startId, 0);

        let head = 0;
        while(head < queue.length) {
            const { id, dist } = queue[head++];
            const rec = this.records[id];
            if (rec && rec.data.PARENT) {
                rec.data.PARENT.forEach(p => {
                    const pId = p.parsed[0];
                    if (pId && !ancestors.has(pId)) {
                        ancestors.set(pId, dist + 1);
                        queue.push({ id: pId, dist: dist + 1 });
                    }
                });
            }
        }
        return ancestors;
    }

    getSpouseIDs(id) {
        const rec = this.records[id];
        if (!rec || !rec.data.UNION) return [];
        return rec.data.UNION.map(u => u.parsed[0]).filter(pid => this.records[pid]);
    }
}

// ==========================================
// Rendering & Terminology
// ==========================================

function renderResult(rel, records, idA, idB) {
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
    const { term, detail } = textGen.describe(rel, idA, idB, genderA, nameB, nameA);

    const spanTerm = document.createElement('span');
    spanTerm.className = 'relationship-term';
    spanTerm.textContent = term;
    resultBox.appendChild(spanTerm);

    const div2 = document.createElement('div');
    div2.appendChild(document.createTextNode('of '));
    const strongB = document.createElement('strong');
    strongB.textContent = nameB;
    div2.appendChild(strongB);
    resultBox.appendChild(div2);

    if (detail) {
        const divDetail = document.createElement('div');
        divDetail.className = 'path-detail';
        divDetail.textContent = detail;
        resultBox.appendChild(divDetail);
    }
}

class RelationText {
    constructor(records) {
        this.records = records;
    }

    describe(rel, idA, idB, genderA, nameB, nameA) {
        if (rel.type === 'IDENTITY') {
            return { term: "Same Person", detail: "IDs match." };
        }
        if (rel.type === 'NONE') {
            return { term: "No Relation Found", detail: "Could not find a path through Parents or Unions." };
        }
        if (rel.type === 'UNION') {
            const t = rel.subType === 'MARR' ? (genderA === 'M' ? "Husband" : genderA === 'F' ? "Wife" : "Spouse") : "Partner";
            return { term: t, detail: "Direct Union record found." };
        }
        if (rel.type === 'ASSOC') {
            const role = rel.direction === 'FORWARD' ? rel.role : "Associate";
            const det = rel.direction === 'FORWARD' 
                ? `Defined as ${rel.role} of ${nameB}.` 
                : `${nameB} is defined as ${rel.role} of ${nameA}.`;
            return { term: role, detail: det };
        }
        if (rel.type === 'BLOOD') {
            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf);
            const commonName = getDisplayName(this.records[rel.ancestorId]);
            return {
                term: term,
                detail: `Common Ancestor: ${commonName}\nPath: [${rel.distA} steps] ↔ Ancestor ↔ [${rel.distB} steps]`
            };
        }
        if (rel.type === 'AFFINAL') {
            return this.describeAffinal(rel, genderA, nameB, nameA);
        }
        return { term: "Unknown", detail: "" };
    }

    describeAffinal(rel, genderA, nameB, nameA) {
        // 1. VIA_SPOUSE_BLOOD: A -> Spouse -> Relative -> B
        // A is the Spouse of B's Relative.
        if (rel.subType === 'VIA_SPOUSE_BLOOD') {
            const dSpouseToRel = rel.bloodRel.distA; // Distance from Spouse to Common Ancestor (0=Self, 1=Parent...)
            const dTargetToRel = rel.bloodRel.distB; // Distance from B to Common Ancestor
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            
            // Re-calculate the relationship of SPOUSE -> B using correct blood logic
            // Note: In calculateBlood, distA was Spouse, distB was Target
            const spouseToTargetTerm = this.getBloodTerm(dSpouseToRel, dTargetToRel, 'U', rel.bloodRel.isHalf);

            let term = "In-Law";

            // If Spouse is B's Ancestor (e.g. Spouse is Grandfather of B) -> A is Step-Grandmother
            if (dSpouseToRel === 0 && dTargetToRel > 0) {
                const ancTerm = this.getAncestorTerm(dTargetToRel, genderA);
                term = "Step-" + ancTerm;
            }
            // If B is Spouse's Ancestor (e.g. Spouse is Grandson of B) -> A is Grandson-in-law
            else if (dTargetToRel === 0 && dSpouseToRel > 0) {
                 // Spouse is Descendant. A is Spouse of Descendant.
                 const descTerm = this.getDescendantTerm(dSpouseToRel, genderA);
                 term = descTerm + "-in-law";
            }
            // If Spouse is B's Sibling -> A is Brother/Sister-in-law
            else if (dSpouseToRel === 1 && dTargetToRel === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            }
            // Fallback for Cousins/Nibaunts
            else {
                term = `Spouse of ${spouseToTargetTerm}`;
            }

            return {
                term: term,
                detail: `Through spouse: ${spouseName}, who is the ${spouseToTargetTerm} of ${nameB}.`
            };
        }

        // 2. VIA_BLOOD_SPOUSE: A -> Relative -> Spouse -> B
        // B is the Spouse of A's Relative.
        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            const dSubjectToRel = rel.bloodRel.distA;
            const dSpouseToRel  = rel.bloodRel.distB; // Target's Spouse relative to CA
            const targetSpouseName = getDisplayName(this.records[rel.targetSpouseId]);
            
            // Calculate A -> Relative (Target's Spouse)
            const subjectToSpouseTerm = this.getBloodTerm(dSubjectToRel, dSpouseToRel, genderA, rel.bloodRel.isHalf);

            let term = "In-Law";
            
            // If A is Ancestor of Target's Spouse -> A is Father/Mother-in-law
            if (dSubjectToRel === 0 && dSpouseToRel > 0) {
                const ancTerm = this.getAncestorTerm(dSpouseToRel, genderA);
                term = ancTerm + "-in-law";
            }
            // If Target's Spouse is Ancestor of A -> A is Step-Child
            else if (dSpouseToRel === 0 && dSubjectToRel > 0) {
                const descTerm = this.getDescendantTerm(dSubjectToRel, genderA);
                term = "Step-" + descTerm; // e.g. Step-Son
            }
            // Siblings
            else if (dSubjectToRel === 1 && dSpouseToRel === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            }
            else {
                term = `${subjectToSpouseTerm}-in-law`; // e.g. Cousin-in-law
            }

            return {
                term: term,
                detail: `${nameB} is the spouse of ${targetSpouseName} (${subjectToSpouseTerm} of ${nameA})`
            };
        }

        // 3. JOINT_AFFINAL: A -> SpouseA -> Relative -> SpouseB -> B
        if (rel.subType === 'JOINT_AFFINAL') {
            const sAName = getDisplayName(this.records[rel.spouseAId]);
            const sBName = getDisplayName(this.records[rel.spouseBId]);
            const sAGender = getGender(this.records[rel.spouseAId]);
            
            // Calculate relation between spouses
            const spouseRelTerm = this.getBloodTerm(rel.bloodRel.distA, rel.bloodRel.distB, sAGender, rel.bloodRel.isHalf);
            
            return {
                term: `Spouse of ${spouseRelTerm}-in-law`, // e.g. Spouse of Brother-in-law
                detail: `Your spouse (${sAName}) is the ${spouseRelTerm} of ${nameB}'s spouse (${sBName}).`
            };
        }
    }

    getBloodTerm(distA, distB, sex, isHalf) {
        const halfPrefix = isHalf ? "Half-" : "";
        
        // Direct Line
        if (distA === 0) return this.getAncestorTerm(distB, sex); 
        if (distB === 0) return this.getDescendantTerm(distA, sex);

        // Sibling (Shared Parent)
        if (distA === 1 && distB === 1) {
            return halfPrefix + (sex === 'M' ? "Brother" : sex === 'F' ? "Sister" : "Sibling");
        }

        // Avuncular (Uncle/Aunt/Nibling)
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

    suffix(term, suff) {
        return term + suff;
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
