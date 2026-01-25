/**
 * RelationshipCalculator.js
 * Core logic for kinship determination and text generation.
 */

export class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        this.lineageParents = new Map(); // BIO, ADO, LEGL, SURR, DONR
        this.allParents = new Map();     // All types including STE, FOS + Inferred
        this.spouses = new Map();        // ID -> Map<SpouseID, { active: boolean, reason: string, type: string }>
        this.parentTypes = new Map();    // ID -> Map<ParentID, Type>
        this.childrenMap = new Map();    // ID -> Set<ChildID> (Helper for topology)

        // 1. First Pass: Build basic maps
        Object.values(records).forEach(rec => {
            const lList = [];
            const aList = [];
            const typeMap = new Map();

            // Init children map
            if (!this.childrenMap.has(rec.id)) this.childrenMap.set(rec.id, new Set());

            // Process Parents
            if (rec.data.PARENT) {
                rec.data.PARENT.forEach(p => {
                    const pId = p.parsed[0];
                    const pType = (p.parsed[1] || 'BIO').toUpperCase().trim();

                    aList.push(pId);
                    typeMap.set(pId, pType);

                    // Track children for topology check
                    if (!this.childrenMap.has(pId)) this.childrenMap.set(pId, new Set());
                    this.childrenMap.get(pId).add(rec.id);

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
                    const type = (u.parsed[1] || 'MARR').toUpperCase();
                    const endDate = u.parsed[3];
                    const endReason = u.parsed[4];

                    const isEnded = !!endReason || (!!endDate && endDate !== '..' && endDate !== '?');
                    
                    sMap.set(partnerId, {
                        active: !isEnded,
                        reason: endReason || (isEnded ? 'End Date' : null),
                        type: type
                    });
                });
            }
            this.spouses.set(rec.id, sMap);
        });

        // 2. Second Pass: Inject Inferred Step-Parents (Active AND Former)
        this._injectInferredStepParents();
    }

    _injectInferredStepParents() {
        for (const [childId, bioParents] of this.lineageParents) {
            if (!bioParents || bioParents.length === 0) continue;

            bioParents.forEach(bioPId => {
                const spouses = this.spouses.get(bioPId);
                if (!spouses) return;

                spouses.forEach((status, spouseId) => {
                    const existingParents = this.allParents.get(childId);
                    
                    // Inject if not already linked (e.g. via adoption)
                    if (!existingParents.includes(spouseId)) {
                        existingParents.push(spouseId);
                        
                        // Distinguish Active Step vs Former Step
                        const type = status.active ? 'STE' : 'STE_EX';
                        this.parentTypes.get(childId).set(spouseId, type);
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
                reason: unionStatus.reason,
                unionType: unionStatus.type
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
        
        // Helper to check step status
        const checkStep = (parent, child, relType) => {
            const types = this.parentTypes.get(child);
            if (types && types.has(parent)) {
                const type = types.get(parent);
                if (type === 'STE' || type === 'STE_EX') {
                    results.push({ 
                        type: relType, 
                        parentId: this._findBioParentSpouseOf(child, parent),
                        isEx: type === 'STE_EX' 
                    });
                }
            }
        };

        checkStep(idA, idB, 'STEP_PARENT');
        checkStep(idB, idA, 'STEP_CHILD');

        return results;
    }

    _findBioParentSpouseOf(childId, stepParentId) {
        const bioParents = this.lineageParents.get(childId) || [];
        for (const bioP of bioParents) {
            if (this._getUnionStatus(bioP, stepParentId)) return bioP;
        }
        return 'Unknown';
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

        ancA.set(idA, { dist: 0, isStep: false, isExStep: false, type: 'SELF' });
        ancB.set(idB, { dist: 0, isStep: false, isExStep: false, type: 'SELF' });

        const commonAncestors = [];
        for (const [id, metaA] of ancA) {
            if (ancB.has(id)) {
                const metaB = ancB.get(id);
                commonAncestors.push({
                    id,
                    distA: metaA.dist,
                    distB: metaB.dist,
                    isStep: metaA.isStep || metaB.isStep,
                    isExStep: metaA.isExStep || metaB.isExStep,
                    typeA: metaA.type,
                    typeB: metaB.type
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
            const tierKey = `${lca.distA}-${lca.distB}-${lca.isStep}-${lca.isExStep}`;
            if (!tiers.has(tierKey)) tiers.set(tierKey, []);
            tiers.get(tierKey).push(lca);
        });

        const finalRels = [];
        tiers.forEach((group, tierKey) => {
            const sample = group[0];
            const { distA, distB, isStep, isExStep } = sample;
            const lcaCount = group.length;

            let isHalf = false;
            let isDouble = false;

            if (!isStep && !isExStep) {
                // Sibling Logic
                if (distA === 1 && distB === 1) {
                    const parentsA = this.lineageParents.get(idA) || [];
                    const parentsB = this.lineageParents.get(idB) || [];
                    
                    // Asymmetric Half-Sibling Logic:
                    // 1. Missing data (both have 1 parent) = Full
                    // 2. Explicit asymmetry (one has 2, only 1 shared) = Half
                    if (lcaCount === 1 && (parentsA.length === 2 || parentsB.length === 2)) {
                        isHalf = true;
                    }
                } 
                // Cousin Logic
                else if (distA > 1 && distB > 1) {
                    if (lcaCount >= 4 && this._areCouples(group)) {
                        isDouble = true;
                    }
                    else if (lcaCount === 1) {
                        isHalf = true;
                    }
                }
            }

            let isAdoptive = false;
            let isFoster = false;
            
            group.forEach(lca => {
                if (['ADO', 'FOS', 'LEGL'].includes(lca.typeA) || ['ADO', 'FOS', 'LEGL'].includes(lca.typeB)) {
                    if (lca.typeA === 'ADO' || lca.typeB === 'ADO') isAdoptive = true;
                    if (lca.typeA === 'FOS' || lca.typeB === 'FOS') isFoster = true; 
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
                isFoster,
                isStep,
                isExStep
            });
        });

        return finalRels;
    }

    _getAllAncestors(startId) {
        const visited = new Map();
        const queue = [{ id: startId, dist: 0, isStep: false, isExStep: false }];

        while (queue.length > 0) {
            const { id, dist, isStep, isExStep } = queue.shift();
            
            const parents = this.allParents.get(id) || [];
            const types = this.parentTypes.get(id);

            parents.forEach(pId => {
                const pType = types.get(pId);
                const nextIsStep = isStep || (pType === 'STE' || pType === 'STE_EX');
                const nextIsExStep = isExStep || (pType === 'STE_EX');

                if (!visited.has(pId)) {
                    visited.set(pId, { dist: dist + 1, isStep: nextIsStep, isExStep: nextIsExStep, type: pType });
                    queue.push({ id: pId, dist: dist + 1, isStep: nextIsStep, isExStep: nextIsExStep });
                } else {
                    const existing = visited.get(pId);
                    if (existing.isStep && !nextIsStep) {
                        visited.set(pId, { dist: dist + 1, isStep: false, isExStep: false, type: pType });
                        queue.push({ id: pId, dist: dist + 1, isStep: false, isExStep: false });
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
        const ids = ancestors.map(a => a.id);
        const pairs = new Set();

        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const p1 = ids[i];
                const p2 = ids[j];

                if (this._getUnionStatus(p1, p2)) {
                    pairs.add([p1, p2].sort().join('+'));
                    continue;
                }

                const children1 = this.childrenMap.get(p1);
                const children2 = this.childrenMap.get(p2);
                if (children1 && children2) {
                    for (const c of children1) {
                        if (children2.has(c)) {
                            pairs.add([p1, p2].sort().join('+'));
                            break; 
                        }
                    }
                }
            }
        }
        return pairs.size >= Math.floor(ids.length / 2);
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

    _deduplicateResults(results) {
        const unique = new Map();
        results.forEach(res => {
            let key = res.type;
            if (res.type === 'LINEAGE') key += `-${res.distA}-${res.distB}-${res.isStep}-${res.isExStep}-${res.isHalf}`;
            if (res.type === 'UNION' || res.type === 'FORMER_UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.spouseId}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            if (res.type === 'STEP_PARENT' || res.type === 'STEP_CHILD') key += `-${res.parentId}-${res.isEx}`;
            if (res.type === 'STEP_SIBLING') key += `-${res.parentA}`;
            if (!unique.has(key)) unique.set(key, res);
        });
        return Array.from(unique.values());
    }

    _filterRedundant(results) {
        const isDirectStepParent = results.some(r => r.type === 'STEP_PARENT');
        if (isDirectStepParent) {
            results = results.filter(r => !(r.type === 'LINEAGE' && (r.isStep || r.isExStep) && r.distB === 1));
        }

        const isDirectStepChild = results.some(r => r.type === 'STEP_CHILD');
        if (isDirectStepChild) {
            results = results.filter(r => !(r.type === 'LINEAGE' && (r.isStep || r.isExStep) && r.distA === 1));
        }

        const isStepSibling = results.some(r => r.type === 'STEP_SIBLING');
        if (isStepSibling) {
            results = results.filter(r => !(r.type === 'LINEAGE' && (r.isStep || r.isExStep) && r.distA === 1 && r.distB === 1));
        }

        const isBlood = results.some(r => r.type === 'LINEAGE' && !r.isStep && !r.isExStep);
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
            const isMarr = rel.unionType === 'MARR' || rel.unionType === 'CIVL';
            const t = genderA === 'M' ? (isMarr ? "Husband" : "Partner") : 
                      genderA === 'F' ? (isMarr ? "Wife" : "Partner") : 
                      (isMarr ? "Spouse" : "Partner");
            return { term: t, detail: "Direct current union." };
        }

        if (rel.type === 'FORMER_UNION') {
            const isMarr = rel.unionType === 'MARR' || rel.unionType === 'CIVL';
            const t = genderA === 'M' ? (isMarr ? "Ex-Husband" : "Former Partner") : 
                      genderA === 'F' ? (isMarr ? "Ex-Wife" : "Former Partner") : 
                      (isMarr ? "Former Spouse" : "Former Partner");
            const reason = rel.reason ? ` (${rel.reason})` : '';
            return { term: t, detail: `Relationship ended${reason}.` };
        }

        if (rel.type === 'STEP_PARENT') {
            const prefix = rel.isEx ? "Former Step-" : "Step-";
            const t = genderA === 'M' ? "Father" : genderA === 'F' ? "Mother" : "Parent";
            const spouseName = getDisplayName(this.records[rel.parentId]);
            return { term: prefix + t, detail: `${nameA} is the spouse of ${nameB}'s parent, ${spouseName}.` };
        }
        
        if (rel.type === 'STEP_CHILD') {
            const prefix = rel.isEx ? "Former Step-" : "Step-";
            const t = genderA === 'M' ? "Son" : genderA === 'F' ? "Daughter" : "Child";
            const parentName = getDisplayName(this.records[rel.parentId]);
            return { term: prefix + t, detail: `${nameA} is the child of ${nameB}'s spouse, ${parentName}.` };
        }

        if (rel.type === 'STEP_SIBLING') {
            const t = genderA === 'M' ? "Step-Brother" : genderA === 'F' ? "Step-Sister" : "Step-Sibling";
            const div = rel.parentsDivorced ? " (Parents Divorced)" : "";
            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);
            return { term: t, detail: `Parents linked via union${div}: ${pAName} and ${pBName}.` };
        }

        if (rel.type === 'LINEAGE') {
            let specialPrefix = "";
            if (rel.distB === 1 && !rel.isStep && !rel.isExStep) {
                 if (rel.isFoster) specialPrefix = "Foster ";
                 if (rel.isAdoptive) specialPrefix = "Adopted "; 
            }

            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf, rel.isDouble, rel.isAdoptive, rel.isStep, rel.isExStep);
            
            const commonName = getDisplayName(this.records[rel.ancestorIds[0]]);
            const lcaCount = rel.ancestorIds.length;
            const sA = rel.distA === 1 ? "step" : "steps";
            const sB = rel.distB === 1 ? "step" : "steps";
            
            let det = `Common Ancestor: ${commonName}`;
            if (lcaCount > 1) det += ` (+ ${lcaCount - 1} other${lcaCount > 2 ? 's' : ''})`;
            det += ` (${rel.distA} ${sA} up, ${rel.distB} ${sB} up).`;
            
            if (rel.isStep) det += ` [via Step-Relationship]`;
            if (rel.isExStep) det += ` [via Former Step-Relationship]`;

            return { term: specialPrefix + term, detail: det };
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
                const relTerm = this.getBloodTerm(bloodDistA, bloodDistB, bloodGender, false, false, false, false, false);
                term = `${relTerm}-in-law`;
            }
            return { 
                term: term, 
                detail: `${nameA} is the spouse of ${spouseName}, who is the ${this.getBloodTerm(bloodDistA, bloodDistB, bloodGender, false, false, false, false, false)} of ${nameB}.` 
            };
        }

        if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            if (bloodDistA === 0 && bloodDistB > 0) {
                term = this.getDescendantTerm(bloodDistA, genderA) + "-in-law";
            } else if (bloodDistA === 1 && bloodDistB === 1) {
                term = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling") + "-in-law";
            } else {
                const relTerm = this.getBloodTerm(bloodDistA, bloodDistB, genderA, false, false, false, false, false);
                term = `${relTerm}-in-law`;
            }
            return {
                term: term,
                detail: `${nameB} is the spouse of ${nameA}'s relative, ${spouseName}.`
            };
        }
        
        return { term: "Affinal", detail: "Complex in-law relationship." };
    }

    getBloodTerm(distA, distB, sex, isHalf, isDouble, isAdoptive, isStep, isExStep) {
        let prefix = "";
        if (isExStep) prefix = "Former Step-";
        else if (isStep) prefix = "Step-";
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
