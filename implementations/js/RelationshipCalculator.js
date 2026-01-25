/**
 * RelationshipCalculator.js
 * Core logic for kinship determination and text generation.
 */

export class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        this.lineageParents = new Map(); // BIO, ADO, LEGL, SURR, DONR
        this.allParents = new Map();     // All types including STE, FOS + Inferred
        this.spouses = new Map();        // ID -> Map<SpouseID, { active: boolean, reason: string }>
        this.parentTypes = new Map();    // ID -> Map<ParentID, Type>

        // 1. First Pass: Build basic maps
        Object.values(records).forEach(rec => {
            const lList = [];
            const aList = [];
            const typeMap = new Map();

            // Process Parents
            if (rec.data.PARENT) {
                rec.data.PARENT.forEach(p => {
                    const pId = p.parsed[0];
                    const pType = (p.parsed[1] || 'BIO').toUpperCase().trim();

                    aList.push(pId);
                    typeMap.set(pId, pType);

                    const VALID_LINEAGE = ['BIO', 'ADO', 'LEGL', 'SURR', 'DONR'];
                    if (VALID_LINEAGE.includes(pType) || !pType) {
                        lList.push(pId);
                    }
                });
            }
            this.lineageParents.set(rec.id, lList);
            this.allParents.set(rec.id, aList);
            this.parentTypes.set(rec.id, typeMap);

            // Process Unions
            const sMap = new Map();
            if (rec.data.UNION) {
                rec.data.UNION.forEach(u => {
                    const partnerId = u.parsed[0];
                    const endDate = u.parsed[3];
                    const endReason = u.parsed[4];

                    const isEnded = !!endReason || (!!endDate && endDate !== '..' && endDate !== '?');
                    
                    sMap.set(partnerId, {
                        active: !isEnded,
                        reason: endReason || (isEnded ? 'End Date' : null)
                    });
                });
            }
            this.spouses.set(rec.id, sMap);
        });

        // 2. Second Pass: Inject Inferred Step-Parents
        this._injectInferredStepParents();
    }

    _injectInferredStepParents() {
        for (const [childId, bioParents] of this.lineageParents) {
            if (!bioParents || bioParents.length === 0) continue;
            
            bioParents.forEach(bioPId => {
                const spouses = this.spouses.get(bioPId);
                if (!spouses) return;

                spouses.forEach((status, spouseId) => {
                    if (status.active) {
                        const existingParents = this.allParents.get(childId);
                        if (!existingParents.includes(spouseId)) {
                            existingParents.push(spouseId);
                            // We use 'STE' to mark it, allowing the traversal to identify it as a step path
                            this.parentTypes.get(childId).set(spouseId, 'STE');
                        }
                    }
                });
            });
        }
    }

    calculate(idA, idB) {
        if (idA === idB) return [{ type: 'IDENTITY' }];
        let results = [];

        // 1. Check Direct Union
        const unionStatus = this._getUnionStatus(idA, idB);
        if (unionStatus) {
            results.push({ 
                type: unionStatus.active ? 'UNION' : 'FORMER_UNION', 
                target: idB,
                reason: unionStatus.reason
            });
        }

        // 2. Check Lineage (Includes inferred step-paths)
        const lineageRels = this._findLineageRelationships(idA, idB);
        lineageRels.forEach(rel => results.push(rel));

        // 3. Check Step-Parent / Step-Child (Direct)
        const stepRels = this._findDirectStepRelationships(idA, idB);
        stepRels.forEach(rel => results.push(rel));

        // 4. Check Affinal (In-Laws)
        this._findAffinalRelationships(idA, idB, results);

        // 5. Check Step-Siblings
        const stepSib = this._findStepSibling(idA, idB);
        if (stepSib) results.push(stepSib);

        // Fallback
        if (results.length === 0) return [{ type: 'NONE' }];

        // 6. Deduplicate & Filter
        results = this._deduplicateResults(results);
        return this._filterRedundant(results);
    }

    // =========================================================================
    // Core Algorithms
    // =========================================================================

    _getUnionStatus(idA, idB) {
        const map = this.spouses.get(idA);
        if (map && map.has(idB)) return map.get(idB);
        return null;
    }

    _findDirectStepRelationships(idA, idB) {
        const results = [];
        // Is A the Step-Parent of B?
        const parentsB = this.lineageParents.get(idB) || [];
        for (const pB of parentsB) {
            const uStatus = this._getUnionStatus(idA, pB);
            if (uStatus && uStatus.active) {
                if (!parentsB.includes(idA)) { 
                    results.push({ type: 'STEP_PARENT', parentId: pB });
                }
            }
        }
        // Is A the Step-Child of B?
        const parentsA = this.lineageParents.get(idA) || [];
        for (const pA of parentsA) {
            const uStatus = this._getUnionStatus(idB, pA);
            if (uStatus && uStatus.active) {
                if (!parentsA.includes(idB)) {
                    results.push({ type: 'STEP_CHILD', parentId: pA });
                }
            }
        }
        return results;
    }

    _findStepSibling(idA, idB) {
        const parentsA = this.allParents.get(idA) || [];
        const parentsB = this.allParents.get(idB) || [];

        for (const pA of parentsA) {
            for (const pB of parentsB) {
                const uStatus = this._getUnionStatus(pA, pB);
                if (uStatus) {
                    const bioA = this.lineageParents.get(idA)?.includes(pA);
                    const bioB = this.lineageParents.get(idB)?.includes(pB);
                    
                    const sharedParents = parentsA.filter(p => parentsB.includes(p));
                    const shareLineageParent = sharedParents.some(p => 
                        this.lineageParents.get(idA).includes(p) && 
                        this.lineageParents.get(idB).includes(p)
                    );

                    if (!shareLineageParent && bioA && bioB) {
                        return {
                            type: 'STEP_SIBLING',
                            parentA: pA,
                            parentB: pB,
                            parentsDivorced: !uStatus.active
                        };
                    }
                }
            }
        }
        return null;
    }

    _findLineageRelationships(idA, idB) {
        const ancA = this._getAllAncestors(idA);
        const ancB = this._getAllAncestors(idB);

        ancA.set(idA, { dist: 0, isStep: false });
        ancB.set(idB, { dist: 0, isStep: false });

        const commonAncestors = [];
        for (const [id, metaA] of ancA) {
            if (ancB.has(id)) {
                const metaB = ancB.get(id);
                commonAncestors.push({
                    id,
                    distA: metaA.dist,
                    distB: metaB.dist,
                    isStep: metaA.isStep || metaB.isStep
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
            const tierKey = `${lca.distA}-${lca.distB}-${lca.isStep}`;
            if (!tiers.has(tierKey)) tiers.set(tierKey, []);
            tiers.get(tierKey).push(lca);
        });

        const finalRels = [];
        tiers.forEach((group, tierKey) => {
            const sample = group[0];
            const { distA, distB, isStep } = sample;
            const lcaCount = group.length;

            let isHalf = false;
            let isDouble = false;

            if (!isStep) {
                if (distA === 1 && distB === 1) {
                    if (lcaCount < 2) isHalf = true;
                } else if (distA > 1 && distB > 1) {
                    if (lcaCount >= 4 && this._areCouples(group)) isDouble = true;
                    else if (lcaCount === 1) isHalf = true;
                }
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
                isAdoptive,
                isStep 
            });
        });
        return finalRels;
    }

    _getAllAncestors(startId) {
        const visited = new Map(); 
        const queue = [{ id: startId, dist: 0, isStep: false }];

        while (queue.length > 0) {
            const { id, dist, isStep } = queue.shift();
            
            const parents = this.allParents.get(id) || [];
            const types = this.parentTypes.get(id);

            parents.forEach(pId => {
                const pType = types.get(pId);
                const nextIsStep = isStep || (pType === 'STE');

                if (!visited.has(pId)) {
                    visited.set(pId, { dist: dist + 1, isStep: nextIsStep });
                    queue.push({ id: pId, dist: dist + 1, isStep: nextIsStep });
                } else {
                    const existing = visited.get(pId);
                    if (existing.isStep && !nextIsStep) {
                        visited.set(pId, { dist: dist + 1, isStep: false });
                        queue.push({ id: pId, dist: dist + 1, isStep: false });
                    }
                }
            });
        }
        return visited;
    }

    _findAffinalRelationships(idA, idB, results) {
        const spousesA = this.spouses.get(idA) || new Map();
        spousesA.forEach((status, spouseId) => {
            if (!status.active || spouseId === idB) return;
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

        const spousesB = this.spouses.get(idB) || new Map();
        spousesB.forEach((status, spouseId) => {
            if (!status.active || spouseId === idA) return;
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
    }

    _areCouples(ancestors) {
        let pairs = 0;
        const ids = ancestors.map(a => a.id);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                if (this._getUnionStatus(ids[i], ids[j])) pairs++;
            }
        }
        return pairs >= Math.floor(ids.length / 2);
    }

    _isAncestor(ancestorId, descendantId) {
        const q = [descendantId];
        const v = new Set();
        while(q.length > 0) {
            const curr = q.shift();
            if(curr === ancestorId) return true;
            if(v.has(curr)) continue;
            v.add(curr);
            (this.allParents.get(curr)||[]).forEach(p => q.push(p));
        }
        return false;
    }

    _pathHasType(startId, endId, targetType) {
        const stack = [{ id: startId, found: false }];
        const visited = new Set();
        while (stack.length > 0) {
            const { id, found } = stack.pop();
            if (id === endId) return found;
            if (visited.has(id)) continue;
            visited.add(id);
            const parents = this.allParents.get(id) || [];
            const types = this.parentTypes.get(id);
            parents.forEach(pId => {
                const type = types.get(pId);
                stack.push({ id: pId, found: found || (type === targetType) });
            });
        }
        return false;
    }

    _deduplicateResults(results) {
        const unique = new Map();
        results.forEach(res => {
            let key = res.type;
            if (res.type === 'LINEAGE') key += `-${res.distA}-${res.distB}-${res.isStep}-${res.isHalf}`;
            if (res.type === 'UNION' || res.type === 'FORMER_UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.spouseId}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            if (res.type === 'STEP_PARENT' || res.type === 'STEP_CHILD') key += `-${res.parentId}`;
            if (res.type === 'STEP_SIBLING') key += `-${res.parentA}`;
            if (!unique.has(key)) unique.set(key, res);
        });
        return Array.from(unique.values());
    }

    _filterRedundant(results) {
        // FILTER 1: Prefer STEP_PARENT over generic Step-Lineage (distA=1)
        const isDirectStepParent = results.some(r => r.type === 'STEP_PARENT');
        if (isDirectStepParent) {
            results = results.filter(r => !(r.type === 'LINEAGE' && r.isStep && r.distB === 1));
        }

        // FILTER 2: Prefer STEP_CHILD over generic Step-Lineage (distA=1)
        // Fixes: "Step-Son" appearing as "Lineage (Step)"
        const isDirectStepChild = results.some(r => r.type === 'STEP_CHILD');
        if (isDirectStepChild) {
            results = results.filter(r => !(r.type === 'LINEAGE' && r.isStep && r.distA === 1));
        }

        // FILTER 3: Prefer STEP_SIBLING over generic Step-Lineage (distA=1, distB=1)
        // Fixes: "Step-Sibling" appearing as "Lineage (Step)"
        const isStepSibling = results.some(r => r.type === 'STEP_SIBLING');
        if (isStepSibling) {
            results = results.filter(r => !(r.type === 'LINEAGE' && r.isStep && r.distA === 1 && r.distB === 1));
        }

        // FILTER 4: Prefer Blood Lineage over Affinal
        const isBlood = results.some(r => r.type === 'LINEAGE' && !r.isStep);
        if (isBlood) {
            results = results.filter(r => r.type !== 'AFFINAL');
        }

        return results;
    }
}

export class RelationText {
    constructor(records) {
        this.records = records;
    }

    describe(rel, genderA, nameB, nameA) {
        if (rel.type === 'IDENTITY') return { term: "Same Person", detail: "" };
        
        if (rel.type === 'UNION') {
            const t = genderA === 'M' ? "Husband" : genderA === 'F' ? "Wife" : "Spouse";
            return { term: t, detail: "Direct current union." };
        }
        if (rel.type === 'FORMER_UNION') {
            const t = genderA === 'M' ? "Ex-Husband" : genderA === 'F' ? "Ex-Wife" : "Former Spouse";
            const reason = rel.reason ? ` (${rel.reason})` : '';
            return { term: t, detail: `Relationship ended${reason}.` };
        }

        if (rel.type === 'STEP_PARENT') {
            const t = genderA === 'M' ? "Step-Father" : genderA === 'F' ? "Step-Mother" : "Step-Parent";
            const spouseName = getDisplayName(this.records[rel.parentId]);
            return { term: t, detail: `${nameA} is the spouse of ${nameB}'s parent, ${spouseName}.` };
        }
        
        if (rel.type === 'STEP_CHILD') {
            const t = genderA === 'M' ? "Step-Son" : genderA === 'F' ? "Step-Daughter" : "Step-Child";
            const parentName = getDisplayName(this.records[rel.parentId]);
            return { term: t, detail: `${nameA} is the child of ${nameB}'s spouse, ${parentName}.` };
        }

        if (rel.type === 'STEP_SIBLING') {
            const t = genderA === 'M' ? "Step-Brother" : genderA === 'F' ? "Step-Sister" : "Step-Sibling";
            const div = rel.parentsDivorced ? " (Parents Divorced)" : "";
            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);
            return { term: t, detail: `Parents linked via union${div}: ${pAName} and ${pBName}.` };
        }

        if (rel.type === 'LINEAGE') {
            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf, rel.isDouble, rel.isAdoptive, rel.isStep);
            const commonName = getDisplayName(this.records[rel.ancestorIds[0]]);
            const lcaCount = rel.ancestorIds.length;
            const sA = rel.distA === 1 ? "step" : "steps";
            const sB = rel.distB === 1 ? "step" : "steps";
            let det = `Common Ancestor: ${commonName}`;
            if (lcaCount > 1) det += ` (+ ${lcaCount - 1} other${lcaCount > 2 ? 's' : ''})`;
            det += ` (${rel.distA} ${sA} up, ${rel.distB} ${sB} up).`;
            if (rel.isStep) det += ` [via Step-Relationship]`;
            return { term: term, detail: det };
        }

        if (rel.type === 'AFFINAL') {
            return this.describeAffinal(rel, genderA, nameB, nameA);
        }

        return { term: "Unknown", detail: "" };
    }

    describeAffinal(rel, genderA, nameB, nameA) {
        const bloodDistA = rel.bloodRel.distA;
        const bloodDistB = rel.bloodRel.distB;
        const bloodGender = getGender(this.records[rel.spouseId]);
        const spouseName = getDisplayName(this.records[rel.spouseId]);

        let term = "In-Law";

        if (rel.subType === 'VIA_SPOUSE') {
            if (bloodDistA === 0 && bloodDistB > 0) {
                term = this.getAncestorTerm(bloodDistB, genderA) + "-in-law";
            } else if (bloodDistA === 1 && bloodDistB === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const relTerm = this.getBloodTerm(bloodDistA, bloodDistB, bloodGender, false, false, false, false);
                term = `${relTerm}-in-law`;
            }
            return { 
                term: term, 
                detail: `${nameA} is the spouse of ${spouseName}, who is the ${this.getBloodTerm(bloodDistA, bloodDistB, bloodGender, false, false, false, false)} of ${nameB}.` 
            };
        }

        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            if (bloodDistA === 0 && bloodDistB > 0) {
                term = this.getDescendantTerm(bloodDistA, genderA) + "-in-law";
            } else if (bloodDistA === 1 && bloodDistB === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const relTerm = this.getBloodTerm(bloodDistA, bloodDistB, genderA, false, false, false, false);
                term = `${relTerm}-in-law`;
            }
            return {
                term: term,
                detail: `${nameB} is the spouse of ${nameA}'s relative, ${spouseName}.`
            };
        }
        
        return { term: "Affinal", detail: "Complex in-law relationship." };
    }

    getBloodTerm(distA, distB, sex, isHalf, isDouble, isAdoptive, isStep) {
        let prefix = "";
        if (isStep) prefix = "Step-";
        else if (isHalf) prefix = "Half-";
        else if (isDouble) prefix = "Double ";

        let suffix = "";
        if (isAdoptive) suffix = " (Adoptive)";

        if (distA === 0) return prefix + this.getAncestorTerm(distB, sex) + suffix;
        if (distB === 0) return prefix + this.getDescendantTerm(distA, sex) + suffix;

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
        if (dist === 1) return sex === 'M' ? "Father" : sex === 'F' ? "Mother" : "Parent";
        if (dist === 2) return sex === 'M' ? "Grandfather" : sex === 'F' ? "Grandmother" : "Grandparent";
        if (dist === 3) return sex === 'M' ? "Great-Grandfather" : sex === 'F' ? "Great-Grandmother" : "Great-Grandparent";
        return `${dist - 2}x Great-Grandparent`;
    }

    getDescendantTerm(dist, sex) {
        if (dist === 1) return sex === 'M' ? "Son" : sex === 'F' ? "Daughter" : "Child";
        if (dist === 2) return sex === 'M' ? "Grandson" : sex === 'F' ? "Granddaughter" : "Grandchild";
        if (dist === 3) return sex === 'M' ? "Great-Grandson" : sex === 'F' ? "Great-Granddaughter" : "Great-Grandchild";
        return `${dist - 2}x Great-Grandchild`;
    }

    getNiblingTerm(genDiff, sex, isUncleAunt) {
        if (isUncleAunt) {
            if (genDiff === 1) return sex === 'M' ? "Uncle" : sex === 'F' ? "Aunt" : "Pibling";
            if (genDiff === 2) return sex === 'M' ? "Great-Uncle" : sex === 'F' ? "Great-Aunt" : "Grand-Uncle/Aunt";
            return `${genDiff - 2}x Great-Uncle/Aunt`;
        } else {
            if (genDiff === 1) return sex === 'M' ? "Nephew" : sex === 'F' ? "Niece" : "Nibling";
            if (genDiff === 2) return sex === 'M' ? "Great-Nephew" : sex === 'F' ? "Great-Niece" : "Grand-Nibling";
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
