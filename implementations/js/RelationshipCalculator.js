/**
 * RelationshipCalculator.js
 * Core logic for kinship determination and text generation.
 */

export class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        this.lineageParents = new Map(); // BIO, ADO, LEGL
        this.allParents = new Map(); // All types (for Step detection)
        this.spouses = new Map(); // ID -> [SpouseIDs]
        this.parentTypes = new Map(); // ID -> Map<ParentID, Type>

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
                    // We accept BIO, ADO, LEGL, SURR, DONR.
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

        // 3. Check Step-Parent / Step-Child (Recursive/Direct)
        const stepRels = this._findStepRelationships(idA, idB);
        stepRels.forEach(rel => results.push(rel));

        // 4. Check Affinal (In-Laws)

        // A -> Spouse -> B (Spouse's Lineage or Step)
        const spousesA = this.spouses.get(idA) || [];
        spousesA.forEach(spouseId => {
            if (spouseId === idB) return;

            // Spouse's Blood Relations (e.g. Spouse's Father)
            const rels = this._findLineageRelationships(spouseId, idB);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel
                });
            });

            // Extended Affinal Chain (Spouse's Step-Parent)
            const stepRelsViaSpouse = this._findStepRelationships(spouseId, idB);
            stepRelsViaSpouse.forEach(stepRel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE_STEP',
                    spouseId: spouseId,
                    stepRel: stepRel
                });
            });
        });

        // A -> Lineage -> Spouse -> B (Relative's Spouse)
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

        // 5. Step-Siblings (Strict)
        const parentsA = this.allParents.get(idA) || [];
        const parentsB = this.allParents.get(idB) || [];

        for (const pA of parentsA) {
            for (const pB of parentsB) {
                if (this._isSpouse(pA, pB)) {
                    const isBioPair = this.lineageParents.get(idA)?.includes(pA) &&
                        this.lineageParents.get(idA)?.includes(pB) &&
                        this.lineageParents.get(idB)?.includes(pA) &&
                        this.lineageParents.get(idB)?.includes(pB);

                    if (!isBioPair) {
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

        // 6. Clean Up and Deduplicate
        results = this._deduplicateResults(results);

        // 7. Filter Redundant Relationships
        const isStep = results.some(r => r.type === 'STEP_PARENT' || r.type === 'STEP_CHILD');
        if (isStep) {
            results = results.filter(r => !(r.type === 'AFFINAL' && r.subType === 'VIA_BLOOD_SPOUSE' && r.bloodRel.distA === 0));
        }

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

    _findStepRelationships(idA, idB) {
        const results = [];
        const parentsB = this.lineageParents.get(idB) || [];
        for (const pB of parentsB) {
            if (this._isSpouse(idA, pB)) {
                if (!parentsB.includes(idA)) {
                    results.push({ type: 'STEP_PARENT', parentId: pB });
                }
            }
        }
        const parentsA = this.lineageParents.get(idA) || [];
        for (const pA of parentsA) {
            if (this._isSpouse(idB, pA)) {
                if (!parentsA.includes(idB)) {
                    results.push({ type: 'STEP_CHILD', parentId: pA });
                }
            }
        }
        return results;
    }

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

        let lcas = commonAncestors.filter(candidate => {
            return !commonAncestors.some(other => {
                if (other.id === candidate.id) return false;
                return this._isAncestor(candidate.id, other.id);
            });
        });

        const tiers = new Map();
        lcas.forEach(lca => {
            const tierKey = `${lca.distA}-${lca.distB}`;
            if (!tiers.has(tierKey)) tiers.set(tierKey, []);
            tiers.get(tierKey).push(lca);
        });

        const finalRels = [];
        tiers.forEach((group, tierKey) => {
            const [distA, distB] = tierKey.split('-').map(Number);
            const lcaCount = group.length;
            let isHalf = false;
            let isDouble = false;

            if (distA === 1 && distB === 1) {
                // SIBLING LOGIC
                if (lcaCount >= 2) {
                    // 2+ Common Ancestors (Mother + Father) = Full
                    isHalf = false;
                } else {
                    // < 2 Common Ancestors. Check for Half-Sibling pattern.
                    const pA = this.lineageParents.get(idA) || [];
                    const pB = this.lineageParents.get(idB) || [];
                    const shared = pA.filter(p => pB.includes(p));
                    const uniqueA = pA.filter(p => !pB.includes(p));
                    const uniqueB = pB.filter(p => !pA.includes(p));
                    
                    // If they share exactly 1 parent, AND at least one of them has a non-shared parent,
                    // it counts as Half-Sibling. (e.g. A has Mom+Dad, B has just Dad).
                    if (shared.length === 1 && (uniqueA.length > 0 || uniqueB.length > 0)) {
                        isHalf = true;
                    } else {
                        isHalf = false;
                    }
                }
            } else if (distA > 1 && distB > 1) {
                if (lcaCount >= 4) isDouble = true;
                if (lcaCount === 1) isHalf = true;
            }

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
        const visited = new Map();
        const queue = [{ id: startId, dist: 0 }];
        while (queue.length > 0) {
            const { id, dist } = queue.shift();
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
        const queue = [descendantId];
        const visited = new Set();
        while (queue.length > 0) {
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
        if (startId === endId) return false;
        const stack = [{ id: startId, found: false }];
        const visited = new Set();
        while (stack.length > 0) {
            const { id, found } = stack.pop();
            if (id === endId) return found;
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
            if (res.type === 'LINEAGE') key += `-${res.distA}-${res.distB}-${res.isDouble}-${res.isHalf}`;
            if (res.type === 'UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.spouseId}`;
            if (res.type === 'STEP_PARENT') key += `-${res.parentId}`;
            if (res.type === 'STEP_CHILD') key += `-${res.parentId}`;
            if (res.type === 'STEP_SIBLING') {
                const parents = [res.parentA, res.parentB].sort().join('-');
                key += `-${parents}`;
            }
            if (!unique.has(key)) unique.set(key, res);
        });
        return Array.from(unique.values());
    }
}

export class RelationText {
    constructor(records) {
        this.records = records;
    }

    describe(rel, genderA, nameB, nameA) {
        if (rel.type === 'IDENTITY') {
            return { term: "Same Person", detail: "" };
        }
        if (rel.type === 'UNION') {
            const t = genderA === 'M' ?
                "Husband" : genderA === 'F' ? "Wife" : "Spouse";
            return { term: t, detail: "Direct Union record found." };
        }

        if (rel.type === 'STEP_PARENT') {
            const t = genderA === 'M' ?
                "Step-Father" : genderA === 'F' ? "Step-Mother" : "Step-Parent";
            const spouseName = getDisplayName(this.records[rel.parentId]);
            return {
                term: t,
                detail: `${nameA} is the spouse of ${nameB}'s parent, ${spouseName}.`
            };
        }
        if (rel.type === 'STEP_CHILD') {
            const t = genderA === 'M' ?
                "Step-Son" : genderA === 'F' ? "Step-Daughter" : "Step-Child";
            const parentName = getDisplayName(this.records[rel.parentId]);
            return {
                term: t,
                detail: `${nameA} is the child of ${nameB}'s spouse, ${parentName}.`
            };
        }

        if (rel.type === 'STEP_SIBLING') {
            const t = genderA === 'M' ?
                "Step-Brother" : genderA === 'F' ? "Step-Sister" : "Step-Sibling";
            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);
            return {
                term: t,
                detail: `Parents are married: ${pAName} and ${pBName}.`
            };
        }

        if (rel.type === 'LINEAGE') {
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
        // Case 1: Relationship via "My Spouse"
        if (rel.subType === 'VIA_SPOUSE' || rel.subType === 'VIA_SPOUSE_STEP') {
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            const spouseGender = getGender(this.records[rel.spouseId]);

            // Handling VIA_SPOUSE_STEP (Spouse's Step-Parent or Step-Child)
            if (rel.subType === 'VIA_SPOUSE_STEP') {
                let term = "Step-In-Law";
                // If the Spouse is a Step-Child of B, then B is a Step-Parent.
                // A is Step-Son/Daughter-in-law.
                if (rel.stepRel.type === 'STEP_CHILD') {
                    const core = (genderA === 'M' ? "Step-Son" : genderA === 'F' ? "Step-Daughter" : "Step-Child");
                    term = core + "-in-law";
                }
                // If Spouse is Step-Parent of B, then A is Step-Father/Mother-in-law.
                else if (rel.stepRel.type === 'STEP_PARENT') {
                    term = (genderA === 'M' ? "Step-Father" : genderA === 'F' ? "Step-Mother" : "Step-Parent") + "-in-law";
                }

                return {
                    term: term,
                    detail: `${nameA} is the spouse of ${spouseName}, who is the Step-Relation of ${nameB}.`
                };
            }

            // Standard VIA_SPOUSE
            const dSpouseToCA = rel.bloodRel.distA;
            const dBToCA = rel.bloodRel.distB;

            let term = "In-Law";
            if (dSpouseToCA === 0 && dBToCA > 0) {
                // Spouse's Parent -> Father/Mother-in-law
                term = this.getAncestorTerm(dBToCA, genderA) + "-in-law";
            } else if (dSpouseToCA === 1 && dBToCA === 1) {
                // Spouse's Sibling -> Brother/Sister-in-law
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const spouseToBTerm = this.getBloodTerm(dSpouseToCA, dBToCA, spouseGender, false, false, false);
                term = `Spouse of ${spouseToBTerm}`;
            }

            return {
                term: term,
                detail: `${nameA} is the spouse of ${spouseName}, who is the ${this.getBloodTerm(dSpouseToCA, dBToCA, spouseGender, false, false, false)} of ${nameB}.`
            };
        }

        // Case 2: Relationship via "My Relative's Spouse"
        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            const dAtoCA = rel.bloodRel.distA;
            const dRelToCA = rel.bloodRel.distB;
            const relativeName = getDisplayName(this.records[rel.spouseId]);
            const relativeGender = getGender(this.records[rel.spouseId]);

            let term = "In-Law";
            if (dAtoCA === 0 && dRelToCA > 0) {
                // Relative is my Descendant -> Son/Daughter-in-law
                term = this.getDescendantTerm(dAtoCA, genderA) + "-in-law";
            } else if (dRelToCA === 0 && dAtoCA > 0) {
                // Relative is my Ancestor. B is Spouse of Ancestor.
                // This means B is my Step-Parent/Grandparent.
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

        if (distA === 0) return this.getAncestorTerm(distB, sex) + suffix;
        if (distB === 0) return this.getDescendantTerm(distA, sex) + suffix;

        if (distA === 1 && distB === 1) {
            return prefix + (sex === 'M' ? "Brother" : sex === 'F' ? "Sister" : "Sibling") + suffix;
        }

        if (distA === 1 && distB > 1) {
            const core = this.getNiblingTerm(distB - 1, sex, true);
            return prefix + core + suffix;
        }
        if (distB === 1 && distA > 1) {
            const core = this.getNiblingTerm(distA - 1, sex, false);
            return prefix + core + suffix;
        }

        const degree = Math.min(distA, distB) - 1;
        const removed = Math.abs(distA - distB);
        const core = this.getCousinTerm(degree, removed);

        return prefix + core + suffix;
    }

    getAncestorTerm(dist, sex) {
        if (dist === 1) return sex === 'M' ?
            "Father" : sex === 'F' ? "Mother" : "Parent";
        if (dist === 2) return sex === 'M' ?
            "Grandfather" : sex === 'F' ? "Grandmother" : "Grandparent";
        if (dist === 3) return sex === 'M' ?
            "Great-Grandfather" : sex === 'F' ? "Great-Grandmother" : "Great-Grandparent";
        return `${dist - 2}x Great-Grandparent`;
    }

    getDescendantTerm(dist, sex) {
        if (dist === 1) return sex === 'M' ?
            "Son" : sex === 'F' ? "Daughter" : "Child";
        if (dist === 2) return sex === 'M' ?
            "Grandson" : sex === 'F' ? "Granddaughter" : "Grandchild";
        if (dist === 3) return sex === 'M' ?
            "Great-Grandson" : sex === 'F' ? "Great-Granddaughter" : "Great-Grandchild";
        return `${dist - 2}x Great-Grandchild`;
    }

    getNiblingTerm(genDiff, sex, isUncleAunt) {
        if (isUncleAunt) {
            if (genDiff === 1) return sex === 'M' ?
                "Uncle" : sex === 'F' ? "Aunt" : "Pibling";
            if (genDiff === 2) return sex === 'M' ?
                "Great-Uncle" : sex === 'F' ? "Great-Aunt" : "Grand-Uncle/Aunt";
            return `${genDiff - 2}x Great-Uncle/Aunt`;
        } else {
            if (genDiff === 1) return sex === 'M' ?
                "Nephew" : sex === 'F' ? "Niece" : "Nibling";
            if (genDiff === 2) return sex === 'M' ?
                "Great-Nephew" : sex === 'F' ? "Great-Niece" : "Grand-Nibling";
            return `${genDiff - 2}x Great-Niece/Nephew`;
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

export function getDisplayName(rec) {
    if (!rec) return "Unknown";
    if (rec.data.NAME) {
        const pref = rec.data.NAME.find(n => n.parsed[3] === 'PREF');
        if (pref) return pref.parsed[0];
        if (rec.data.NAME[0]) return rec.data.NAME[0].parsed[0];
    }
    return rec.id;
}

export function getGender(rec) {
    if (rec && rec.data.SEX && rec.data.SEX[0]) {
        return rec.data.SEX[0].parsed[0].trim().toUpperCase();
    }
    return 'U';
}
