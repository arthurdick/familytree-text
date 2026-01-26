/**
 * RelationshipCalculator.js
 * Core logic for kinship determination and text generation.
 */

export class RelationshipCalculator {
    constructor(records) {
        this.records = records;
        this.lineageParents = new Map(); // BIO, ADO, LEGL, SURR, DONR
        this.allParents = new Map(); // All types including STE, FOS + Inferred
        this.spouses = new Map(); // ID -> Map<SpouseID, { active, reason, type }>
        this.parentTypes = new Map(); // ID -> Map<ParentID, Type>
        this.childrenMap = new Map(); // ID -> Set<ChildID> (Helper for topology)

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

        // 5. Check Co-Affinal (Spouses of Siblings)
        this._findCoAffinalRelationships(idA, idB, results);

        // 6. Check Deep Extended Affinal
        this._findExtendedAffinalRelationships(idA, idB, results);

        // 7. Check Step-Siblings
        const stepSib = this._findStepSibling(idA, idB);
        if (stepSib) results.push(stepSib);

        // Fallback
        if (results.length === 0) return [{ type: 'NONE' }];

        // 8. Deduplicate & Filter
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
                    // Check if they share any biological/lineage parent
                    const shareLineageParent = sharedParents.some(p => 
                        this.lineageParents.get(idA).includes(p) && 
                        this.lineageParents.get(idB).includes(p)
                    );

                    if (!shareLineageParent && bioA && bioB) {
                        return {
                            type: 'STEP_SIBLING',
                            parentA: pA,
                            parentB: pB,
                            unionActive: uStatus.active,
                            unionReason: uStatus.reason,
                            parentsDivorced: !uStatus.active && uStatus.reason !== 'WID'
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

        // Add SELF to maps
        if(!ancA.has(idA)) ancA.set(idA, []);
        ancA.get(idA).push({ dist: 0, isStep: false, isExStep: false, type: 'SELF', lineageType: 'SELF' });

        if(!ancB.has(idB)) ancB.set(idB, []);
        ancB.get(idB).push({ dist: 0, isStep: false, isExStep: false, type: 'SELF', lineageType: 'SELF' });

        const commonAncestors = [];

        // Cross-reference all paths
        for (const [id, pathsA] of ancA) {
            if (ancB.has(id)) {
                const pathsB = ancB.get(id);
                // Cross product of valid paths to this ancestor
                pathsA.forEach(metaA => {
                    pathsB.forEach(metaB => {
                        commonAncestors.push({
                            id,
                            distA: metaA.dist,
                            distB: metaB.dist,
                            isStep: metaA.isStep || metaB.isStep,
                            isExStep: metaA.isExStep || metaB.isExStep,
                            typeA: metaA.type,
                            typeB: metaB.type,
                            lineageA: metaA.lineageType,
                            lineageB: metaB.lineageType
                        });
                    });
                });
            }
        }

        if (commonAncestors.length === 0) return [];

        // Filter LCAs (Remove ancestors of ancestors)
        let lcas = commonAncestors.filter(candidate => {
            return !commonAncestors.some(other => {
                if (other.id === candidate.id) return false; 
                return this._isAncestor(candidate.id, other.id) && 
                       (candidate.distA > other.distA) && 
                       (candidate.distB > other.distB);
            });
        });

        // Group by Tier (Distance + Step Status)
        const tiers = new Map();
        lcas.forEach(lca => {
            const tierKey = `${lca.distA}-${lca.distB}-${lca.isStep}-${lca.isExStep}-${lca.lineageA}-${lca.lineageB}`;
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

            // BLOOD RELATIONSHIP CHECKS
            if (!isStep && !isExStep) {
                // 1. Half-Blood Logic (Single Common Ancestor)
                // GUARD: Direct ancestors/descendants (dist=0) are never 'Half'.
                if (lcaCount === 1 && distA > 0 && distB > 0) {
                    // Sibling Case (1-1): 
                    // Only assert Half-Sibling if we have positive proof of divergence.
                    // (i.e. Both parties have 2 known parents, but only 1 matches).
                    if (distA === 1 && distB === 1) {
                        const parentsA = this.lineageParents.get(idA) || [];
                        const parentsB = this.lineageParents.get(idB) || [];
                        
                        // strictly require both to have 2 parents
                        if (parentsA.length >= 2 && parentsB.length >= 2) {
                            isHalf = true;
                        }
                    } 
                    // Avuncular Case (1-N):
                    // If the Uncle/Aunt (who is 1 step from LCA) has 2 known parents,
                    // but we only share 1 (lcaCount=1), it implies the second parent is different.
                    else if (distA === 1 || distB === 1) {
                        const uncleId = distA === 1 ? idA : idB;
                        const parents = this.lineageParents.get(uncleId) || [];
                        if (parents.length >= 2) {
                            isHalf = true;
                        }
                    }
                    // Cousin Case (N-N):
                    // If we only find 1 common ancestor, it COULD be a Half-Cousin, 
                    // or it COULD be missing data (e.g. Grandma is not in the file).
                    // Heuristic: Only assume "Half" if the ancestor has known multiple partners.
                    else {
                        const ancestorId = group[0].id;
                        const spouseMap = this.spouses.get(ancestorId);
                        
                        // If the ancestor has 2 or more partners recorded, 
                        // it's statistically likely this is a Half-relationship.
                        // Otherwise, give benefit of the doubt (Full).
                        if (spouseMap && spouseMap.size >= 2) {
                            isHalf = true;
                        } else {
                            isHalf = false;
                        }
                    }
                } 
                
                // 2. Double Logic (Restricted to Cousins)
                // We only check Double for dist > 1.
                else if (lcaCount >= 2 && distA > 1 && distB > 1) {
                    if (lcaCount === 2) {
                        // If the 2 ancestors are NOT partners, it's Double (distinct lineages)
                        const p1 = group[0].id;
                        const p2 = group[1].id;
                        if (!this._arePartners(p1, p2)) {
                            isDouble = true;
                        }
                    } else {
                        // 3+ ancestors implies Double (or Triple)
                        isDouble = true;
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
                if (lca.lineageA === 'ADO' || lca.lineageB === 'ADO') isAdoptive = true;
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
                isExStep,
                lineageA: sample.lineageA,
                lineageB: sample.lineageB
            });
        });

        return finalRels;
    }

    _arePartners(idA, idB) {
        // 1. Explicit Union
        if (this._getUnionStatus(idA, idB)) return true;

        // 2. Shared Children (Implicit Union)
        const childrenA = this.childrenMap.get(idA);
        const childrenB = this.childrenMap.get(idB);
        if (childrenA && childrenB) {
            for (const c of childrenA) {
                if (childrenB.has(c)) return true;
            }
        }
        return false;
    }

    _getAllAncestors(startId) {
        const visited = new Map();
        const queue = [{ id: startId, dist: 0, isStep: false, isExStep: false, lineageType: 'BIO' }];

        while (queue.length > 0) {
            const { id, dist, isStep, isExStep, lineageType } = queue.shift();

            const parents = this.allParents.get(id) || [];
            const types = this.parentTypes.get(id);

            parents.forEach(pId => {
                const pType = types.get(pId);
                const nextIsStep = isStep || (pType === 'STE' || pType === 'STE_EX');
                const nextIsExStep = isExStep || (pType === 'STE_EX');
                
                let nextLineageType = lineageType;
                if (pType === 'ADO') nextLineageType = 'ADO';
                else if (pType === 'BIO') nextLineageType = lineageType; 
                else if (pType === 'STE') nextLineageType = 'STE';

                const newEntry = { 
                    dist: dist + 1, 
                    isStep: nextIsStep, 
                    isExStep: nextIsExStep, 
                    type: pType, 
                    lineageType: nextLineageType 
                };

                if (!visited.has(pId)) visited.set(pId, []);
                
                const existing = visited.get(pId);
                const isRedundant = existing.some(e => 
                    e.dist === newEntry.dist && 
                    e.lineageType === newEntry.lineageType &&
                    e.isStep === newEntry.isStep
                );

                if (!isRedundant) {
                    existing.push(newEntry);
                    queue.push({ id: pId, ...newEntry });
                }
            });
        }
        return visited;
    }

    _findAffinalRelationships(idA, idB, results) {
        // A's Spouse -> Relative of B
        // (A is the spouse of someone related to B)
        const spousesA = this.spouses.get(idA) || new Map();
        spousesA.forEach((status, spouseId) => {
            if (spouseId === idB) return;
            
            const rels = this._findLineageRelationships(spouseId, idB);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel,
                    isExUnion: !status.active, 
                    unionReason: status.reason
                });
            });
        });

        // B's Spouse -> Relative of A
        // (B is the spouse of someone related to A)
        const spousesB = this.spouses.get(idB) || new Map();
        spousesB.forEach((status, spouseId) => {
            if (spouseId === idA) return;

            const rels = this._findLineageRelationships(idA, spouseId);
            rels.forEach(rel => {
                results.push({
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE',
                    spouseId: spouseId,
                    bloodRel: rel,
                    isExUnion: !status.active,
                    unionReason: status.reason
                });
            });
        });
    }

    _findCoAffinalRelationships(idA, idB, results) {
        const spousesA = this.spouses.get(idA) || new Map();
        const spousesB = this.spouses.get(idB) || new Map();

        spousesA.forEach((statusA, spouseIdA) => {
            if (!statusA.active) return;
            
            spousesB.forEach((statusB, spouseIdB) => {
                if (!statusB.active) return;
                if (spouseIdA === spouseIdB) return;

                // Check if the two spouses are siblings
                const rels = this._findLineageRelationships(spouseIdA, spouseIdB);
                rels.forEach(rel => {
                    if (rel.distA === 1 && rel.distB === 1 && !rel.isStep) {
                        results.push({
                            type: 'CO_AFFINAL',
                            subType: 'SPOUSES_ARE_SIBLINGS',
                            spouseA: spouseIdA,
                            spouseB: spouseIdB
                        });
                    }
                });
            });
        });
    }
    
    _findExtendedAffinalRelationships(idA, idB, results) {
        // CASE 1: A is the Sibling of the Spouse of B's Relative.
        // (e.g. A="Me", B="Father of my BIL". A is the Brother-in-law of B's Son)
        const parentsA = this.lineageParents.get(idA) || [];
        if (parentsA.length > 0) {
            const siblingsA = [];
            parentsA.forEach(pId => {
                const children = this.childrenMap.get(pId);
                if (children) children.forEach(c => {
                    if (c !== idA && !siblingsA.includes(c)) siblingsA.push(c);
                });
            });

            for (const sibId of siblingsA) {
                const spouses = this.spouses.get(sibId);
                if (!spouses) continue;

                spouses.forEach((status, spouseId) => {
                    if (!status.active) return;
                    const relsToSpouse = this._findLineageRelationships(spouseId, idB);
                    relsToSpouse.forEach(rel => {
                        results.push({
                            type: 'EXTENDED_AFFINAL',
                            subType: 'VIA_SIBLING_SPOUSE',
                            siblingId: sibId,
                            spouseId: spouseId,
                            bloodRel: rel // B's relationship to Spouse
                        });
                    });
                });
            }
        }

        // CASE 2: A is the Relative of the Spouse of B's Sibling.
        // (e.g. A="Father of BIL", B="Me". A is the Father of Brother-in-law)
        const parentsB = this.lineageParents.get(idB) || [];
        if (parentsB.length > 0) {
             const siblingsB = [];
             parentsB.forEach(pId => {
                const children = this.childrenMap.get(pId);
                if (children) children.forEach(c => {
                    if (c !== idB && !siblingsB.includes(c)) siblingsB.push(c);
                });
             });
             
             for (const sibId of siblingsB) {
                 const spouses = this.spouses.get(sibId);
                 if (!spouses) continue;
                 
                 spouses.forEach((status, spouseId) => {
                     if (!status.active) return;
                     // Check if A is related to the Spouse
                     const relsToSpouse = this._findLineageRelationships(idA, spouseId);
                     relsToSpouse.forEach(rel => {
                         results.push({
                             type: 'EXTENDED_AFFINAL',
                             subType: 'VIA_BLOOD_SPOUSE_SIBLING',
                             siblingId: sibId, // B's sibling
                             spouseId: spouseId, // The in-law
                             bloodRel: rel // A's relationship to Spouse
                         });
                     });
                 });
             }
        }
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
            if (res.type === 'LINEAGE') key += `-${res.distA}-${res.distB}-${res.isStep}-${res.isExStep}-${res.isHalf}-${res.lineageA}-${res.lineageB}`;
            if (res.type === 'UNION' || res.type === 'FORMER_UNION') key += `-${res.target}`;
            if (res.type === 'AFFINAL') key += `-${res.subType}-${res.spouseId}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            if (res.type === 'CO_AFFINAL') key += `-${res.spouseA}-${res.spouseB}`;
            if (res.type === 'EXTENDED_AFFINAL') key += `-${res.subType}-${res.siblingId}-${res.spouseId}-${res.bloodRel.distA}`;
            if (res.type === 'STEP_PARENT' || res.type === 'STEP_CHILD') key += `-${res.parentId}-${res.isEx}`;
            if (res.type === 'STEP_SIBLING') key += `-${res.parentA}-${res.parentB}`;
            
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

        // Check if a pure blood link exists
        const isBlood = results.some(r => r.type === 'LINEAGE' && !r.isStep && !r.isExStep);
        
        if (isBlood) {
            // Rule 1: Blood trumps Affinal (In-Laws)
            results = results.filter(r => r.type !== 'AFFINAL');

            // Rule 2: Blood trumps Step-Lineage
            // If I am your Half-Uncle, ignore that I might also be your Step-Uncle via a different marriage.
            results = results.filter(r => !(r.type === 'LINEAGE' && (r.isStep || r.isExStep)));
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
            
            let status = "";
            if (rel.unionReason === 'WID') status = " (Widowed)";
            else if (rel.unionReason === 'DIV' || (rel.parentsDivorced)) status = " (Divorced)";
            else if (rel.unionReason) status = ` (${rel.unionReason})`;
            
            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);
            return { term: t, detail: `Parents linked via union${status}: ${pAName} and ${pBName}.` };
        }

        if (rel.type === 'CO_AFFINAL') {
             const t = genderA === 'M' ? "Brother-in-law" : genderA === 'F' ? "Sister-in-law" : "Sibling-in-law";
             const spAName = getDisplayName(this.records[rel.spouseA]);
             const spBName = getDisplayName(this.records[rel.spouseB]);
             return { term: `Co-${t}`, detail: `${nameA}'s spouse (${spAName}) is a sibling of ${nameB}'s spouse (${spBName}).` };
        }
        
        if (rel.type === 'EXTENDED_AFFINAL') {
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            const spouseGender = getGender(this.records[rel.spouseId]);
            
            // CASE 1: Downward/Lateral Look (Me -> My Sibling -> Spouse -> Spouse's Parent/Relative)
            // "I am the Brother-in-law of his Son."
            if (rel.subType === 'VIA_SIBLING_SPOUSE') {
                // 1. Determine what A (Me) is to the Spouse.
                // Since I am the sibling of their partner, I am their Sibling-in-law.
                const myInLawTerm = genderA === 'M' ? "Brother-in-law" : 
                                    genderA === 'F' ? "Sister-in-law" : "Sibling-in-law";

                // 2. Determine what the Spouse is to B (Target).
                // e.g., If B is the Father, the Spouse is the Son.
                // We use getBloodTerm, but we treat the Spouse as the 'Descendant' (A) and B as the 'Ancestor' (B)
                // distA in bloodRel = Spouse's dist to Common.
                // distB in bloodRel = B's dist to Common.
                const relativeTerm = this.getBloodTerm(
                    rel.bloodRel.distA, // Spouse's distance (e.g. 1 for Son)
                    rel.bloodRel.distB, // B's distance (e.g. 0 for Father)
                    spouseGender,       // We want the Spouse's label (e.g. "Son")
                    rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, rel.bloodRel.isStep, rel.bloodRel.isExStep
                );

                return {
                    term: `${myInLawTerm} of ${relativeTerm}`,
                    detail: `${nameA} is the ${myInLawTerm} of ${nameB}'s ${relativeTerm}, ${spouseName}.`
                };
            }
            
            // CASE 2: Upward/Lateral Look (Me -> My Spouse -> My Spouse's Sibling -> Sibling's Relative)
            // "He is the Father of my Brother-in-law."
            if (rel.subType === 'VIA_BLOOD_SPOUSE_SIBLING') {
                // 1. Determine what the Spouse is to B (Brother/Sister-in-law)
                const inLawTerm = spouseGender === 'M' ? "Brother-in-law" : 
                                  spouseGender === 'F' ? "Sister-in-law" : "Sibling-in-law";
                            
                // 2. Determine what A is to the Spouse (Father, Grandfather)
                const relativeTerm = this.getBloodTerm(
                    rel.bloodRel.distA,
                    rel.bloodRel.distB,
                    genderA,
                    rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, rel.bloodRel.isStep, rel.bloodRel.isExStep
                );
                
                return {
                    term: `${relativeTerm} of ${inLawTerm}`,
                    detail: `${nameA} is the ${relativeTerm} of ${nameB}'s ${inLawTerm}, ${spouseName}.`
                };
            }
        }

        if (rel.type === 'LINEAGE') {
            let specialPrefix = "";
            let handledAdoptive = false;

            if (!rel.isStep && !rel.isExStep) {
                 if (rel.distB === 1) {
                     // B is Child of LCA (Common Ancestor)
                     if (rel.distA === 0) {
                         // A is the LCA. A is Parent of B.
                         if (rel.isFoster) { specialPrefix = "Foster "; handledAdoptive = true; }
                         else if (rel.isAdoptive) { specialPrefix = "Adoptive "; handledAdoptive = true; }
                     } else {
                         // A is Descendant of LCA. A is Sibling (distA=1) or Nibling (distA=2) of B.
                         if (rel.isFoster) { specialPrefix = "Foster "; handledAdoptive = true; }
                         else if (rel.isAdoptive) { specialPrefix = "Adopted "; handledAdoptive = true; }
                     }
                 }
                 // Handle direct Child Case (A is Child of B -> distA=1, distB=0)
                 else if (rel.distB === 0 && rel.distA === 1) {
                     if (rel.isFoster) { specialPrefix = "Foster "; handledAdoptive = true; }
                     else if (rel.isAdoptive) { specialPrefix = "Adopted "; handledAdoptive = true; }
                 }
            }

            // Append specific lineage type if mixed/adoptive path AND not already handled by specific prefix
            if (!handledAdoptive && (rel.lineageA === 'ADO' || rel.lineageB === 'ADO')) {
                specialPrefix += "(Adoptive) ";
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
        
        const prefixEx = (t) => rel.isExUnion ? `Former ${t}` : t;
        const isStep = rel.bloodRel.isStep;
        const isExStep = rel.bloodRel.isExStep;
        
        const getBaseTerm = (dA, dB, g) => {
            return this.getBloodTerm(dA, dB, g, rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, isStep, isExStep);
        };

        let term = "In-Law";
        let detail = "";

        // ---------------------------------------------------------
        // CASE 1: VIA_SPOUSE (A is the Spouse of B's Relative)
        // ---------------------------------------------------------
        // Example: A (Me) -> Spouse (Wife) -> Relative (Father). 
        // A is Son-in-Law.
        if (rel.subType === 'VIA_SPOUSE') {
            // Sub-case: Spouse is Descendant of B (distB=0).
            // e.g. Spouse is Daughter (distA=1) of B.
            // A is Son-in-Law.
            if (bloodDistB === 0) {
                const core = this.getDescendantTerm(bloodDistA, genderA);
                term = prefixEx(`${core}-in-law`);
            }
            // Sub-case: Spouse is Ancestor of B (distA=0).
            // e.g. Spouse is Mother of B.
            // A is Step-Father.
            else if (bloodDistA === 0) {
                const core = this.getAncestorTerm(bloodDistB, genderA);
                term = prefixEx(`Step-${core}`); 
            }
            // Sub-case: Spouse is Sibling of B.
            // A is Brother/Sister-in-law.
            else if (bloodDistA === 1 && bloodDistB === 1) {
                 const core = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling");
                 term = prefixEx(`${core}-in-law`);
            }
            else {
                 term = prefixEx(`${getBaseTerm(bloodDistA, bloodDistB, genderA)}-in-law`);
            }
            
            detail = `${nameA} is the ${rel.isExUnion ? 'former ' : ''}spouse of ${spouseName}, who is the ${getBaseTerm(bloodDistA, bloodDistB, bloodGender)} of ${nameB}.`;
        }

        // ---------------------------------------------------------
        // CASE 2: VIA_BLOOD_SPOUSE (A is the Relative of B's Spouse)
        // ---------------------------------------------------------
        // Example: A (FIL) -> Relative (Wife) <- Spouse (Me)
        // A is the Father-in-Law.
        else if (rel.subType === 'VIA_BLOOD_SPOUSE') {
            // Sub-case: A is Ancestor of Spouse (distA=0).
            // e.g. A is Father of Spouse.
            // A is Father-in-law.
            if (bloodDistA === 0) {
                const core = this.getAncestorTerm(bloodDistB, genderA);
                
                let finalTerm = core;
                if (isStep) finalTerm = `Step-${core}`;
                else if (isExStep) finalTerm = `Former Step-${core}`;
                
                term = prefixEx(`${finalTerm}-in-law`);
            }
            // Sub-case: A is Descendant of Spouse (distB=0).
            // e.g. A is Son of Spouse.
            // A is Step-Son (Child of Spouse).
            else if (bloodDistB === 0) {
                const core = this.getDescendantTerm(bloodDistA, genderA);
                term = prefixEx(`Step-${core}`);
            }
            // Sub-case: A is Sibling of Spouse.
            // A is Brother/Sister-in-law.
            else if (bloodDistA === 1 && bloodDistB === 1) {
                const core = (genderA === 'M' ? "Brother" : genderA === 'F' ? "Sister" : "Sibling");
                
                let finalTerm = core;
                if (isStep) finalTerm = `Step-${core}`;
                
                term = prefixEx(`${finalTerm}-in-law`);
            }
            else {
                term = prefixEx(`${getBaseTerm(bloodDistA, bloodDistB, genderA)}-in-law`);
            }

            detail = `${nameB} is the ${rel.isExUnion ? 'former ' : ''}spouse of ${nameA}'s relative, ${spouseName}.`;
        }
        
        return { term, detail };
    }

    getBloodTerm(distA, distB, sex, isHalf, isDouble, isAdoptive, isStep, isExStep) {
        let prefix = "";
        if (isExStep) prefix = "Former Step-";
        else if (isStep) prefix = "Step-";
        else if (isHalf) prefix = "Half-";
        else if (isDouble) prefix = "Double ";

        let suffix = "";

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
            if (genDiff === 1) return sex === 'M' ? "Uncle" : sex === 'F' ? "Aunt" : "Parent's Sibling";
            if (genDiff === 2) return sex === 'M' ? "Great-Uncle" : sex === 'F' ? "Great-Aunt" : "Grand-Uncle/Aunt";
            return `${genDiff - 2}x Great-Uncle/Aunt`;
        } else {
            if (genDiff === 1) return sex === 'M' ? "Nephew" : sex === 'F' ? "Niece" : "Sibling's Child";
            if (genDiff === 2) return sex === 'M' ? "Great-Nephew" : sex === 'F' ? "Great-Niece" : "Grand-Niece/Nephew";
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
