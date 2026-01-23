import FTTParser from '../FTTParser.js';


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
        resultBox.textContent = ''; // Clear previous
        const span = document.createElement('span');
        span.className = 'error';
        span.textContent = message;
        resultBox.appendChild(span);
    };

    // --- File Loading Logic ---
    btnOpenFile.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            txtSource.value = e.target.result;
            // Clear result box on new file load to avoid confusion
            resultBox.innerHTML = '<span style="color:#ccc;">File loaded. Enter IDs to calculate.</span>';
        };
        reader.readAsText(file);
        // Reset input so the same file can be re-selected if modified externally
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
            // 1. Parse Data using the included library
            const parser = new FTTParser();
            const parseResult = parser.parse(source);

            if (parseResult.errors.length > 0) {
                resultBox.textContent = '';
                const span = document.createElement('span');
                span.className = 'error';
                span.appendChild(document.createTextNode('Parse Error:'));
                span.appendChild(document.createElement('br'));
                span.appendChild(document.createTextNode(parseResult.errors[0]));
                resultBox.appendChild(span);
                return;
            }

            const records = parseResult.records;

            // 2. Validate IDs
            if (!records[id1]) throw new Error(`ID "${id1}" not found in records.`);
            if (!records[id2]) throw new Error(`ID "${id2}" not found in records.`);

            // 3. Calculate Relationship
            const rel = calculateRelationship(records, id1, id2);

            // 4. Render
            renderResult(rel, records, id1, id2);

        } catch (e) {
            showError(e.message);
        }
    });
});

// ==========================================
// Relationship Logic
// ==========================================

function calculateRelationship(records, idA, idB) {
    if (idA === idB) return {
        type: 'IDENTITY'
    };

    const recA = records[idA];
    const recB = records[idB];

    // 1. Check Direct Union (Spouse)
    if (recA.data.UNION) {
        const union = recA.data.UNION.find(u => u.parsed[0] === idB);
        if (union) {
            const uType = union.parsed[1] || 'MARR';
            return {
                type: 'UNION',
                subType: uType
            };
        }
    }

    // 2. Check Direct Association
    if (recA.data.ASSOC) {
        const assoc = recA.data.ASSOC.find(a => a.parsed[0] === idB);
        if (assoc) {
            return {
                type: 'ASSOC',
                role: assoc.parsed[1] || 'ASSOCIATE'
            };
        }
    }
    if (recB.data.ASSOC) {
        const assoc = recB.data.ASSOC.find(a => a.parsed[0] === idA);
        if (assoc) {
            return {
                type: 'ASSOC_REVERSE',
                role: assoc.parsed[1] || 'ASSOCIATE'
            };
        }
    }

    // 3. Blood Relationship (Lowest Common Ancestor)
    const bloodRel = calculateBloodRelationship(records, idA, idB);
    if (bloodRel) return bloodRel;

    // 4. Affinal (In-Laws / Step) Relationship
    const affinalRel = calculateAffinalRelationship(records, idA, idB);
    if (affinalRel) return affinalRel;

    return {
        type: 'NONE'
    };
}

function calculateBloodRelationship(records, idA, idB) {
    const ancestorsA = getAncestors(records, idA);
    const ancestorsB = getAncestors(records, idB);

    let bestCA = null;
    let minDistance = Infinity;

    for (const [ancId, distA] of ancestorsA) {
        if (ancestorsB.has(ancId)) {
            const distB = ancestorsB.get(ancId);
            const totalDist = distA + distB;

            if (totalDist < minDistance) {
                minDistance = totalDist;
                bestCA = {
                    id: ancId,
                    distA,
                    distB
                };
            }
        }
    }

    if (bestCA) {
        return {
            type: 'BLOOD',
            ...bestCA
        };
    }
    return null;
}

function calculateAffinalRelationship(records, idA, idB) {
    // Strategy: 
    // 1. Is A related to B's Spouse? (A -> Spouse(B) -> B)
    // 2. Is A's Spouse related to B? (A -> Spouse(A) -> B)
    // 3. Are Parents of A and Parents of B married? (Step-Siblings)

    // Helper to get spouses
    const getSpouses = (id) => {
        const rec = records[id];
        if (!rec || !rec.data.UNION) return [];
        return rec.data.UNION.map(u => u.parsed[0]).filter(pid => records[pid]);
    };

    const spousesA = getSpouses(idA);
    const spousesB = getSpouses(idB);

    // Path 1: B's Spouse is the link (A is blood relative of B's spouse)
    // e.g. A is Father of Spouse(B) -> A is Father-in-law of B.
    for (const sB of spousesB) {
        const rel = calculateBloodRelationship(records, idA, sB);
        if (rel) {
            return {
                type: 'AFFINAL',
                subtype: 'VIA_TARGET_SPOUSE',
                spouseId: sB,
                bloodRel: rel
            };
        }
    }

    // Path 2: A's Spouse is the link (Spouse(A) is blood relative of B)
    // e.g. Spouse(A) is Parent of B -> A is Stepparent of B.
    for (const sA of spousesA) {
        const rel = calculateBloodRelationship(records, sA, idB);
        if (rel) {
            return {
                type: 'AFFINAL',
                subtype: 'VIA_SUBJECT_SPOUSE',
                spouseId: sA,
                bloodRel: rel
            };
        }
    }

    // Path 3: Step-Siblings (Parent(A) is married to Parent(B))
    // Note: If they shared a parent, calculateBloodRelationship would have returned already.
    const getParents = (id) => {
        const rec = records[id];
        if (!rec || !rec.data.PARENT) return [];
        return rec.data.PARENT.map(p => p.parsed[0]).filter(pid => records[pid]);
    };

    const parentsA = getParents(idA);
    const parentsB = getParents(idB);

    for (const pA of parentsA) {
        for (const pB of parentsB) {
            if (pA === pB) continue; // Safety check

            // Check if pA and pB are in a union
            const recPA = records[pA];
            if (recPA && recPA.data.UNION) {
                const union = recPA.data.UNION.find(u => u.parsed[0] === pB);
                if (union) {
                    return {
                        type: 'AFFINAL',
                        subtype: 'STEP_SIBLING',
                        parentA: pA,
                        parentB: pB
                    };
                }
            }
        }
    }

    return null;
}

// BFS to map all ancestors and their generation distance
function getAncestors(records, startId) {
    const ancestors = new Map(); // ID -> Distance (0=Self, 1=Parent...)
    const queue = [{
        id: startId,
        dist: 0
    }];

    ancestors.set(startId, 0);

    while (queue.length > 0) {
        const {
            id,
            dist
        } = queue.shift();
        const record = records[id];
        if (record && record.data.PARENT) {
            record.data.PARENT.forEach(p => {
                const pId = p.parsed[0];
                if (pId && !ancestors.has(pId)) {
                    ancestors.set(pId, dist + 1);
                    queue.push({
                        id: pId,
                        dist: dist + 1
                    });
                }
            });
        }
    }
    return ancestors;
}

// ==========================================
// Rendering & Terminology
// ==========================================

function renderResult(rel, records, idA, idB) {
    const nameA = getDisplayName(records[idA]);
    const nameB = getDisplayName(records[idB]);
    const genderA = getGender(records[idA]);

    const resultBox = document.getElementById('result-box');
    resultBox.textContent = ''; // Clear previous results

    // 1. Create Line: "[NameA] is the"
    const div1 = document.createElement('div');
    const strongA = document.createElement('strong');
    strongA.textContent = nameA;
    div1.appendChild(strongA);
    div1.appendChild(document.createTextNode(' is the'));
    resultBox.appendChild(div1);

    let term = "Unknown Relation";
    let detail = "";

    // Calculation Logic
    if (rel.type === 'IDENTITY') {
        term = "Same Person";
    } else if (rel.type === 'UNION') {
        term = (rel.subType === 'MARR') ? (genderA === 'M' ? "Husband" : genderA === 'F' ? "Wife" : "Spouse") : "Partner";
        detail = "Direct Union record found.";
    } else if (rel.type === 'ASSOC') {
        term = rel.role;
        detail = `Defined as an associate of ${nameB}.`;
    } else if (rel.type === 'ASSOC_REVERSE') {
        term = "Associate";
        detail = `${nameB} is defined as ${rel.role} of ${nameA}.`;
    } else if (rel.type === 'BLOOD') {
        term = getBloodTerm(rel.distA, rel.distB, genderA);
        const commonName = getDisplayName(records[rel.id]);
        detail = `Common Ancestor: ${commonName} (${rel.id})\n` +
                 `Distance: ${nameA} (${rel.distA}) ↔ Ancestor ↔ (${rel.distB}) ${nameB}`;
    } else if (rel.type === 'AFFINAL') {
        if (rel.subtype === 'STEP_SIBLING') {
            const pAName = getDisplayName(records[rel.parentA]);
            const pBName = getDisplayName(records[rel.parentB]);
            term = (genderA === 'M') ? "Stepbrother" : (genderA === 'F') ? "Stepsister" : "Step-Sibling";
            detail = `${nameA}'s parent (${pAName}) is a partner of ${nameB}'s parent (${pBName}).`;
        } else {
            const dBloodSubject = rel.bloodRel.distA;
            const dBloodTarget = rel.bloodRel.distB;
            const rawBloodTerm = getBloodTerm(dBloodSubject, dBloodTarget, genderA);

            if (rel.subtype === 'VIA_TARGET_SPOUSE') {
                const spouseName = getDisplayName(records[rel.spouseId]);
                detail = `${nameA} is the ${rawBloodTerm} of ${nameB}'s spouse (${spouseName}).`;
                term = getInLawTermFromBlood(dBloodSubject, dBloodTarget, genderA, 'INLAW');
            } else if (rel.subtype === 'VIA_SUBJECT_SPOUSE') {
                const spouseName = getDisplayName(records[rel.spouseId]);
                const spouseGender = getGender(records[rel.spouseId]);
                const relationToB = getBloodTerm(rel.bloodRel.distA, rel.bloodRel.distB, spouseGender);
                detail = `${nameA}'s spouse (${spouseName}) is the ${relationToB} of ${nameB}.`;
                term = getInLawTermFromBlood(dBloodSubject, dBloodTarget, genderA, 'STEP');
            }
        }
    } else {
        term = "No Relation Found";
        detail = "Could not find a path through Parents or Unions.";
    }

    // 2. Create Term: "[Term]"
    const spanTerm = document.createElement('span');
    spanTerm.className = 'relationship-term';
    spanTerm.textContent = term;
    resultBox.appendChild(spanTerm);

    // 3. Create Line: "of [NameB]"
    const div2 = document.createElement('div');
    div2.appendChild(document.createTextNode('of '));
    const strongB = document.createElement('strong');
    strongB.textContent = nameB;
    div2.appendChild(strongB);
    resultBox.appendChild(div2);

    // 4. Create Detail (if exists)
    if (detail) {
        const divDetail = document.createElement('div');
        divDetail.className = 'path-detail';
        // Ensure whitespace (newlines) are respected if we added them in the logic
        divDetail.style.whiteSpace = 'pre-wrap'; 
        divDetail.textContent = detail;
        resultBox.appendChild(divDetail);
    }
}

// ==========================================
// Terminology Helpers
// ==========================================

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
    if (rec.data.SEX && rec.data.SEX[0]) {
        return rec.data.SEX[0].parsed[0].trim().toUpperCase();
    }
    return 'U';
}

function getBloodTerm(distA, distB, sex) {
    if (distA === 0) return getAncestorTerm(distB, sex); // A is Ancestor
    if (distB === 0) return getDescendantTerm(distA, sex); // A is Descendant

    // Siblings
    if (distA === 1 && distB === 1) {
        return (sex === 'M') ? "Brother" : (sex === 'F') ? "Sister" : "Sibling";
    }
    // A is Uncle/Aunt (Sibling of Ancestor)
    if (distA === 1 && distB > 1) {
        return getNiblingTerm(distB - 1, sex, true);
    }
    // A is Niece/Nephew (Child of Sibling)
    if (distB === 1 && distA > 1) {
        return getNiblingTerm(distA - 1, sex, false);
    }
    // Cousins
    const degree = Math.min(distA, distB) - 1;
    const removed = Math.abs(distA - distB);
    return getCousinTerm(degree, removed);
}

function getInLawTermFromBlood(distA, distB, sex, mode) {
    // 1. Parent / Ancestor
    if (distA === 0) { // Subject is Ancestor of Spouse (INLAW) OR Spouse is Ancestor of Target (STEP)
        const term = getAncestorTerm(distB, sex);
        if (mode === 'INLAW') return term + "-in-law"; // Parent -> Parent-in-law
        if (mode === 'STEP') return "Step" + term.toLowerCase(); // Parent -> Stepparent
    }

    // 2. Child / Descendant
    if (distB === 0) {
        const term = getDescendantTerm(distA, sex);
        if (mode === 'INLAW') return "Step" + term.toLowerCase(); // Child of Spouse -> Stepchild
        if (mode === 'STEP') return term + "-in-law"; // Spouse of Child -> Son-in-law
    }

    // 3. Sibling
    if (distA === 1 && distB === 1) {
        const term = (sex === 'M') ? "Brother" : (sex === 'F') ? "Sister" : "Sibling";
        return term + "-in-law"; // Works for both ways
    }

    // 4. Uncle/Aunt
    if (distA === 1 && distB > 1) {
        const term = getNiblingTerm(distB - 1, sex, true);
        return term + "-in-law"; // Uncle-in-law
    }

    // 5. Niece/Nephew
    if (distB === 1 && distA > 1) {
        const term = getNiblingTerm(distA - 1, sex, false);
        return term + "-in-law"; // Nephew-in-law
    }

    // 6. Cousin
    const degree = Math.min(distA, distB) - 1;
    const removed = Math.abs(distA - distB);
    const term = getCousinTerm(degree, removed);
    return term + "-in-law";
}

function getAncestorTerm(dist, sex) {
    if (dist === 1) return sex === 'M' ? "Father" : sex === 'F' ? "Mother" : "Parent";
    if (dist === 2) return sex === 'M' ? "Grandfather" : sex === 'F' ? "Grandmother" : "Grandparent";
    if (dist === 3) return sex === 'M' ? "Great-Grandfather" : sex === 'F' ? "Great-Grandmother" : "Great-Grandparent";
    return `${dist-2}x Great-Grandparent`;
}

function getDescendantTerm(dist, sex) {
    if (dist === 1) return sex === 'M' ? "Son" : sex === 'F' ? "Daughter" : "Child";
    if (dist === 2) return sex === 'M' ? "Grandson" : sex === 'F' ? "Granddaughter" : "Grandchild";
    if (dist === 3) return sex === 'M' ? "Great-Grandson" : sex === 'F' ? "Great-Granddaughter" : "Great-Grandchild";
    return `${dist-2}x Great-Grandchild`;
}

function getNiblingTerm(genDiff, sex, isUncleAunt) {
    if (isUncleAunt) {
        if (genDiff === 1) return sex === 'M' ? "Uncle" : sex === 'F' ? "Aunt" : "Parent's Sibling";
        if (genDiff === 2) return sex === 'M' ? "Great-Uncle" : sex === 'F' ? "Great-Aunt" : "Grand-Uncle/Aunt";
        return `${genDiff-2}x Great-Uncle/Aunt`;
    } else {
        if (genDiff === 1) return sex === 'M' ? "Nephew" : sex === 'F' ? "Niece" : "Sibling's Child";
        if (genDiff === 2) return sex === 'M' ? "Great-Nephew" : sex === 'F' ? "Great-Niece" : "Grand-Nibling";
        return `${genDiff-2}x Great-Niece/Nephew`;
    }
}

function getCousinTerm(degree, removed) {
    let ord = "Cousin";
    if (degree === 1) ord = "1st Cousin";
    else if (degree === 2) ord = "2nd Cousin";
    else if (degree === 3) ord = "3rd Cousin";
    else ord = `${degree}th Cousin`;

    if (removed === 0) return ord;
    if (removed === 1) return `${ord} 1x Removed`;
    return `${ord} ${removed}x Removed`;
}
