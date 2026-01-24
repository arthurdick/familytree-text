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
 * Relationship Calculator
 * Uses Breadth-First Search (BFS) to find the shortest path in the graph.
 * Capable of solving Blood, Affinal (In-Laws), and Step relationships of arbitrary depth.
 */
class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        this.graph = this._buildAdjacencyGraph(records);
    }

    /**
     * Main Entry Point
     */
    calculate(idA, idB) {
        if (idA === idB) return { type: 'IDENTITY' };

        // 1. Find the shortest path (Node sequence + Edge types)
        const path = this._findShortestPath(idA, idB);
        
        console.log( path );

        if (!path) return { type: 'NONE' };

        // 2. Analyze the path to classify the relationship
        return this._classifyPath(path, idA, idB);
    }

    // =========================================================================
    // 1. Graph Construction (Pre-calculation)
    // =========================================================================
    _buildAdjacencyGraph(records) {
        const graph = new Map();

        // Initialize nodes
        Object.keys(records).forEach(id => graph.set(id, []));

        // Build Edges
        Object.values(records).forEach(rec => {
            const childId = rec.id;

            // PARENT Edges (Child -> Parent)
            if (rec.data.PARENT) {
                rec.data.PARENT.forEach(p => {
                    const parentId = p.parsed[0];
                    if (records[parentId]) {
                        // Edge: Child -> Parent (UP)
                        this._addEdge(graph, childId, parentId, 'PARENT');
                        // Edge: Parent -> Child (DOWN)
                        this._addEdge(graph, parentId, childId, 'CHILD');
                    }
                });
            }

            // UNION Edges (Spouse <-> Spouse)
            if (rec.data.UNION) {
                rec.data.UNION.forEach(u => {
                    const spouseId = u.parsed[0];
                    if (records[spouseId]) {
                        // Bidirectional Union
                        this._addEdge(graph, childId, spouseId, 'UNION');
                        this._addEdge(graph, spouseId, childId, 'UNION');
                    }
                });
            }
        });
        return graph;
    }

    _addEdge(graph, from, to, type) {
        if (!graph.has(from)) graph.set(from, []);
        // Avoid duplicate edges
        const existing = graph.get(from).find(e => e.target === to && e.type === type);
        if (!existing) {
            graph.get(from).push({ target: to, type });
        }
    }

    // =========================================================================
    // 2. Breadth-First Search (BFS)
    // =========================================================================
    _findShortestPath(startId, endId) {
        // Queue item: { id, path: [{ edgeType, targetId }] }
        const queue = [{ id: startId, path: [] }];
        const visited = new Set([startId]);

        while (queue.length > 0) {
            const current = queue.shift();

            if (current.id === endId) {
                return current.path;
            }

            const neighbors = this.graph.get(current.id) || [];
            
            for (const edge of neighbors) {
                if (!visited.has(edge.target)) {
                    visited.add(edge.target);
                    const newPath = [...current.path, { type: edge.type, target: edge.target }];
                    queue.push({ id: edge.target, path: newPath });
                }
            }
        }
        return null; // No path found
    }

    // =========================================================================
    // 3. Path Classification (The "Math" of Kinship)
    // =========================================================================
    _classifyPath(path, startId, endId) {
        // Count edge types
        let ups = 0;   // Steps up to common ancestor
        let downs = 0; // Steps down from common ancestor
        let unions = 0;
        let unionIndices = [];

        // Analyze direction flow
        // Standard Blood Path looks like: UP... UP (Apex) DOWN... DOWN
        let isBloodLike = true;
        let hasTurnedDown = false;

        path.forEach((step, index) => {
            if (step.type === 'UNION') {
                unions++;
                unionIndices.push(index);
                // Unions break the "Blood" flow unless handled specifically
            } else if (step.type === 'PARENT') {
                if (hasTurnedDown) isBloodLike = false; // Going up after going down (Zigzag)
                ups++;
            } else if (step.type === 'CHILD') {
                hasTurnedDown = true;
                downs++;
            }
        });

        // --- CASE A: Direct Union (Spouse) ---
        if (unions === 1 && path.length === 1) {
            return { type: 'UNION', subType: 'MARR' }; // Defaulting to MARR for simplicity
        }

        // --- CASE B: Blood Relatives (0 Unions) ---
        if (unions === 0 && isBloodLike) {
            // Find common ancestor ID (The node at the "Apex" of the path)
            const ancestorIndex = ups - 1; 
            const ancestorId = ancestorIndex >= 0 ? path[ancestorIndex].target : startId;

            return {
                type: 'BLOOD',
                ancestorId: ancestorId,
                distA: ups,    // Steps from Start -> Ancestor
                distB: downs,  // Steps from End -> Ancestor
                isHalf: false  // BFS assumes full; logic for half-sibling requires deeper graph analysis
            };
        }

        // --- CASE C: Affinal (In-Laws) ---
        // Logic: Try to split the path at the Union to reuse Blood Logic
        if (unions > 0) {
            
            // 1. Spouse's Blood Relative (E.g. Wife's Father)
            // Path: UNION -> UP/DOWN
            if (path[0].type === 'UNION' && unions === 1) {
                const spouseId = path[0].target;
                // Treat the rest of the path as a blood path from the Spouse
                const remainderPath = path.slice(1);
                const { ups: rUps, downs: rDowns } = this._countUD(remainderPath);
                
                return {
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE_BLOOD',
                    spouseId: spouseId,
                    bloodRel: { distA: rUps, distB: rDowns, isHalf: false }
                };
            }

            // 2. Blood Relative's Spouse (E.g. Brother's Wife)
            // Path: UP/DOWN -> UNION
            if (path[path.length - 1].type === 'UNION' && unions === 1) {
                const targetSpouseId = path[path.length - 1].target; // This is endId
                const relativeId = path[path.length - 2].target;     // Person before endId
                
                // Analyze path from Start to Relative
                const bloodPath = path.slice(0, path.length - 1);
                const { ups: bUps, downs: bDowns } = this._countUD(bloodPath);

                return {
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE',
                    targetSpouseId: targetSpouseId, // The end user
                    bloodRel: { distA: bUps, distB: bDowns, isHalf: false }
                };
            }

            // 3. Joint Affinal (Spouse's Sibling's Spouse)
            // Path: UNION -> UP/DOWN -> UNION
            if (path[0].type === 'UNION' && path[path.length - 1].type === 'UNION' && unions === 2) {
                const spouseA = path[0].target;
                const spouseB = endId;
                
                // Path between spouses
                const midPath = path.slice(1, path.length - 1);
                const { ups: mUps, downs: mDowns } = this._countUD(midPath);

                return {
                    type: 'AFFINAL',
                    subType: 'JOINT_AFFINAL',
                    spouseAId: spouseA,
                    spouseBId: spouseB,
                    bloodRel: { distA: mUps, distB: mDowns, isHalf: false }
                };
            }
        }

        // Fallback for complex zig-zags (e.g., "Cousin's Step-Father")
        // We return a generic "Step/Complex" type that the renderer can handle simply
        return { 
            type: 'COMPLEX', 
            detail: `Path Length: ${path.length} steps. Unions crossed: ${unions}.` 
        };
    }

    // Helper to count ups/downs in a sub-path
    _countUD(path) {
        let ups = 0;
        let downs = 0;
        path.forEach(step => {
            if (step.type === 'PARENT') ups++;
            if (step.type === 'CHILD') downs++;
        });
        return { ups, downs };
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
