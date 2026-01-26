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
        this._findGeneralizedAffinalRelationships(idA, idB, results);

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
                if (pA === pB) continue; // Skip shared parent (Handled by Lineage as Half/Full Sibling)

                // 1. Attempt to get status via explicit union
                let uStatus = this._getUnionStatus(pA, pB);
                
                // 2. If no explicit union, check for implicit partnership (Shared Children)
                if (!uStatus) {
                    const childrenA = this.childrenMap.get(pA);
                    const childrenB = this.childrenMap.get(pB);
                    let hasSharedChild = false;
                    
                    if (childrenA && childrenB) {
                         for (const child of childrenA) {
                             if (childrenB.has(child)) {
                                 hasSharedChild = true;
                                 break;
                             }
                         }
                    }

                    if (hasSharedChild) {
                        // Synthesize an active Partner status for the calculation
                        uStatus = { active: true, reason: null, type: 'PART' };
                    }
                }

                if (uStatus) {
                    const bioA = this.lineageParents.get(idA)?.includes(pA);
                    const bioB = this.lineageParents.get(idB)?.includes(pB);
                    
                    const sharedParents = parentsA.filter(p => parentsB.includes(p));
                    // Check if they share any biological/lineage parent (which would make them Half-Siblings)
                    const shareLineageParent = sharedParents.some(p => 
                        this.lineageParents.get(idA).includes(p) && 
                        this.lineageParents.get(idB).includes(p)
                    );

                    // They are Step-Siblings IF:
                    // 1. Parents are united (Explicit or Implicit)
                    // 2. They do NOT share a biological parent (Not Half-Siblings)
                    // 3. The linked parents are biological parents to A and B respectively
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
            
            let isAmbiguous = false;

            // BLOOD RELATIONSHIP CHECKS
            if (!isStep && !isExStep) {
                // 1. Half-Blood Logic (Single Common Ancestor)
                if (lcaCount === 1 && distA > 0 && distB > 0) {
                     // Sibling Case (1-1): 
                     if (distA === 1 && distB === 1) {
                        const parentsA = this.lineageParents.get(idA) || [];
                        const parentsB = this.lineageParents.get(idB) || [];
                        const lenA = parentsA.length;
                        const lenB = parentsB.length;
                        
                        // Case A: Both have 2 parents -> Positive Half
                        if (lenA >= 2 && lenB >= 2) {
                            isHalf = true;
                        }
                        // Case B: One has 2, One has 1 -> Ambiguous
                        // We share 1 parent. The one with 2 parents has a 2nd parent X.
                        // The one with 1 parent is missing data. Their 2nd parent *could* be X (Full)
                        // or *could* be Y (Half). We cannot default to Full.
                        else if ((lenA === 2 && lenB === 1) || (lenA === 1 && lenB === 2)) {
                            // We treat this as a distinct state, not Half, not Full.
                            // We will use a new property 'isAmbiguous'.
                        }
                     } 
                     // Avuncular Case (1-N):
                    else if (distA === 1 || distB === 1) {
                        const uncleId = distA === 1 ? idA : idB;
                        const nephewId = distA === 1 ? idB : idA;
                        
                        const parentsUncle = this.lineageParents.get(uncleId) || [];
                        
                        // 1. Proven Half: Uncle has 2 parents, but we only matched 1.
                        if (parentsUncle.length >= 2) {
                            isHalf = true;
                        }
                        // 2. Ambiguous: Uncle has 1 parent (Missing Data).
                        // We check if the Nephew's linking parent (Uncle's Sibling) has 2 parents.
                        else if (parentsUncle.length === 1) {
                            // Only perform this check for direct Uncle/Nephew (dist=2) 
                            // to avoid expensive traversals for Great-Uncles.
                            const distNephew = distA === 1 ? distB : distA;
                            
                            if (distNephew === 2) {
                                // Identify the Nephew's parent who descends from the LCA
                                const lcaId = group[0].id;
                                const parentsNephew = this.lineageParents.get(nephewId) || [];
                                
                                const siblingOfUncle = parentsNephew.find(p => 
                                    (this.lineageParents.get(p) || []).includes(lcaId)
                                );

                                if (siblingOfUncle) {
                                    const parentsSibling = this.lineageParents.get(siblingOfUncle) || [];
                                    
                                    // Sibling has 2 parents (Full context), Uncle has 1 (Missing context).
                                    // We cannot assume Uncle shares the second parent.
                                    if (parentsSibling.length === 2) {
                                        isAmbiguous = true;
                                    }
                                }
                            }
                        }
                    }
                     // Cousin Case (N-N):
                     else {
                        const ancestorId = group[0].id;
                        const spouseMap = this.spouses.get(ancestorId);
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
            
            // Determine ambiguity based on the Sibling logic above
            if (!isStep && !isExStep && lcaCount === 1 && distA === 1 && distB === 1 && !isHalf) {
                const parentsA = this.lineageParents.get(idA) || [];
                const parentsB = this.lineageParents.get(idB) || [];
                if ((parentsA.length === 2 && parentsB.length === 1) || 
                    (parentsA.length === 1 && parentsB.length === 2)) {
                    isAmbiguous = true;
                }
            }

            finalRels.push({
                type: 'LINEAGE',
                ancestorIds: group.map(g => g.id),
                distA,
                distB,
                isHalf,
                isAmbiguous,
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
    
    _findGeneralizedAffinalRelationships(idA, idB, results) {
        // Iterate over all known unions in the graph to find a "Bridge"
        // Pattern: A -> (Lineage) -> Spouse1 <-> Spouse2 -> (Lineage) -> B
        
        for (const [spouse1Id, spouses] of this.spouses) {
            // Optimization: First check if A is related to Spouse 1
            // This prunes the search space significantly.
            
            // Skip if Spouse1 IS A (Direct Affinal, handled elsewhere)
            if (spouse1Id === idA) continue;

            const relsA = this._findLineageRelationships(idA, spouse1Id);
            if (relsA.length === 0) continue; // A is not related to this side of the union

            for (const [spouse2Id, status] of spouses) {
                if (!status.active) continue; // Only active marriages bridge families
                if (spouse2Id === idB) continue; // Spouse2 IS B (Direct Affinal, handled elsewhere)

                // Check if Spouse 2 is related to B
                const relsB = this._findLineageRelationships(spouse2Id, idB);
                
                if (relsB.length > 0) {
                    // Path Found: A -> Spouse1 <-> Spouse2 -> B
                    // We generate a result for every valid lineage combination
                    relsA.forEach(relA => {
                        relsB.forEach(relB => {
                            results.push({
                                type: 'EXTENDED_AFFINAL',
                                subType: 'GENERALIZED',
                                spouse1Id: spouse1Id, // A's relative
                                spouse2Id: spouse2Id, // B's relative
                                relA: relA, // A -> Spouse1
                                relB: relB  // Spouse2 -> B
                            });
                        });
                    });
                }
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
            
            // Standard Lineage
            if (res.type === 'LINEAGE') {
                key += `-${res.distA}-${res.distB}-${res.isStep}-${res.isExStep}-${res.isHalf}-${res.isAmbiguous}-${res.lineageA}-${res.lineageB}`;
            }
            
            // Unions
            if (res.type === 'UNION' || res.type === 'FORMER_UNION') {
                key += `-${res.target}`;
            }
            
            // Standard Affinal
            if (res.type === 'AFFINAL') {
                key += `-${res.subType}-${res.spouseId}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            }
            
            // Co-Affinal
            if (res.type === 'CO_AFFINAL') {
                key += `-${res.spouseA}-${res.spouseB}`;
            }

            // Extended Affinal (UPDATED)
            if (res.type === 'EXTENDED_AFFINAL') {
                if (res.subType === 'GENERALIZED') {
                    // New Schema: uses spouse1Id, spouse2Id, relA, relB
                    key += `-${res.subType}-${res.spouse1Id}-${res.spouse2Id}-${res.relA.distA}-${res.relB.distA}`;
                } else {
                    // Legacy Schema: uses siblingId, spouseId, bloodRel
                    // Kept for safety if mixed results exist
                    key += `-${res.subType}-${res.siblingId}-${res.spouseId}-${res.bloodRel.distA}`;
                }
            }

            // Step-Relationships
            if (res.type === 'STEP_PARENT' || res.type === 'STEP_CHILD') {
                key += `-${res.parentId}-${res.isEx}`;
            }
            if (res.type === 'STEP_SIBLING') {
                key += `-${res.parentA}-${res.parentB}`;
            }
            
            if (!unique.has(key)) unique.set(key, res);
        });
        return Array.from(unique.values());
    }

    _filterRedundant(results) {
        // 1. NOISE FILTER: Extended Affinal is a fallback.
        // If we found a specific relationship (Lineage, Union, Standard In-Law, Step-Family),
        // we discard the verbose generalized paths.
        const hasSpecificRel = results.some(r => 
            r.type !== 'EXTENDED_AFFINAL' && r.type !== 'NONE'
        );
        
        if (hasSpecificRel) {
            results = results.filter(r => r.type !== 'EXTENDED_AFFINAL');
        }

        // 2. Filter Lineage steps if a Direct Step relationship exists
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

        // 3. Blood Lineage Logic (Endogamy Support)
        const isBlood = results.some(r => r.type === 'LINEAGE' && !r.isStep && !r.isExStep);
        if (isBlood) {
            // Rule A: Blood trumps Affinal ONLY if it is DIRECT LINEAGE.
            // (e.g. You cannot be an In-Law to your own Child, but you CAN be an In-Law to your Cousin).
            const isDirectLineage = results.some(r => 
                r.type === 'LINEAGE' && !r.isStep && !r.isExStep && (r.distA === 0 || r.distB === 0)
            );

            if (isDirectLineage) {
                results = results.filter(r => r.type !== 'AFFINAL');
            }

            // Rule B: Blood trumps Step-Lineage (Redundancy Filter)
            // (e.g. Genetic Half-Uncle trumps Step-Uncle).
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
                    rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, rel.bloodRel.isStep, rel.bloodRel.isExStep, rel.bloodRel.isAmbiguous
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
                    rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, rel.bloodRel.isStep, rel.bloodRel.isExStep, rel.bloodRel.isAmbiguous
                );
                
                return {
                    term: `${relativeTerm} of ${inLawTerm}`,
                    detail: `${nameA} is the ${relativeTerm} of ${nameB}'s ${inLawTerm}, ${spouseName}.`
                };
            }
            
            // Generalized Handler
            if (rel.subType === 'GENERALIZED') {
                // Logic: Describe A's relation to Spouse1, then B's relation to Spouse1 (as an in-law).
                // Formula: "[Term A->S1] of [Term B->S1]"
                // Example: A=Father, S1=Sister, S2=Husband, B=Husband's Brother.
                // A is Father of S1. B is Brother-in-Law of S1.
                // Result: "Father of Brother-in-Law".

                // 1. Get A's relationship to Spouse 1 (e.g., "Father")
                const termA = this.getBloodTerm(
                    rel.relA.distA, rel.relA.distB, genderA,
                    rel.relA.isHalf, rel.relA.isDouble, rel.relA.isAdoptive, rel.relA.isStep, rel.relA.isExStep
                );

                // 2. Get B's relationship to Spouse 1 (The In-Law term)
                // We fake an Affinal relationship object for B->S1 to reuse logic
                const mockAffinalRel = {
                    type: 'AFFINAL',
                    subType: 'VIA_BLOOD_SPOUSE', // B -> Rel(S2) -> Spouse(S1)
                    spouseId: rel.spouse1Id,
                    bloodRel: rel.relB, // S2 -> B
                    isExUnion: false
                };
                
                const s1Gender = getGender(this.records[rel.spouse1Id]);
                const termS1toB = this.describeAffinal(mockAffinalRel, s1Gender, nameB, "TEMP").term;

                return {
                    term: `${termA} of ${termS1toB}`,
                    detail: `${nameA} is the ${termA} of ${termS1toB}, ${getDisplayName(this.records[rel.spouse1Id])}.`
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

            const term = this.getBloodTerm(rel.distA, rel.distB, genderA, rel.isHalf, rel.isDouble, rel.isAdoptive, rel.isStep, rel.isExStep, rel.isAmbiguous);
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
            return this.getBloodTerm(dA, dB, g, rel.bloodRel.isHalf, rel.bloodRel.isDouble, rel.bloodRel.isAdoptive, isStep, isExStep, rel.bloodRel.isAmbiguous);
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

    getBloodTerm(distA, distB, sex, isHalf, isDouble, isAdoptive, isStep, isExStep, isAmbiguous) {
        let prefix = "";
        if (isExStep) prefix = "Former Step-";
        else if (isStep) prefix = "Step-";
        else if (isHalf) prefix = "Half-";
        else if (isDouble) prefix = "Double ";

        let suffix = "";
        if (isAmbiguous) suffix += " (Ambiguous)";

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
