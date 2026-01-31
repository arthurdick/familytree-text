/**
 * RelationshipCalculator.js
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
        Object.values(records).forEach((rec) => {
            const lList = [];
            const aList = [];
            const typeMap = new Map();

            if (!this.childrenMap.has(rec.id)) this.childrenMap.set(rec.id, new Set());

            // Process Parents
            if (rec.data.PARENT) {
                rec.data.PARENT.forEach((p) => {
                    const pId = p.parsed[0];
                    const pType = (p.parsed[1] || "BIO").toUpperCase().trim();

                    aList.push(pId);
                    typeMap.set(pId, pType);

                    if (!this.childrenMap.has(pId)) this.childrenMap.set(pId, new Set());
                    this.childrenMap.get(pId).add(rec.id);

                    const VALID_LINEAGE = ["BIO", "ADO", "LEGL", "SURR", "DONR"];
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
                rec.data.UNION.forEach((u) => {
                    const partnerId = u.parsed[0];
                    const type = (u.parsed[1] || "MARR").toUpperCase();
                    const endDate = u.parsed[3];
                    const endReason = u.parsed[4];

                    const isEnded = !!endReason || (!!endDate && endDate !== "..");

                    sMap.set(partnerId, {
                        active: !isEnded,
                        reason: endReason || (isEnded ? "End Date" : null),
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

            bioParents.forEach((bioPId) => {
                const spouses = this.spouses.get(bioPId);
                if (!spouses) return;

                spouses.forEach((status, spouseId) => {
                    const existingParents = this.allParents.get(childId);

                    if (!existingParents.includes(spouseId)) {
                        existingParents.push(spouseId);

                        let type = "STE_EX";

                        if (status.active) {
                            type = "STE";
                        } else if (status.reason === "WID") {
                            type = "STE";
                        }

                        this.parentTypes.get(childId).set(spouseId, type);
                    }
                });
            });
        }
    }

    calculate(idA, idB) {
        if (idA === idB) return [{ type: "IDENTITY" }];

        let results = [];

        // 1. Check Direct Union
        const unionStatus = this._getUnionStatus(idA, idB);
        if (unionStatus) {
            results.push({
                type: unionStatus.active ? "UNION" : "FORMER_UNION",
                target: idB,
                reason: unionStatus.reason,
                unionType: unionStatus.type
            });
        }

        // 2. Check Lineage (Includes inferred step-paths)
        const lineageRels = this._findLineageRelationships(idA, idB);
        lineageRels.forEach((rel) => results.push(rel));

        // 3. Check Step-Parent / Step-Child (Direct)
        const stepRels = this._findDirectStepRelationships(idA, idB);
        stepRels.forEach((rel) => results.push(rel));

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
        if (results.length === 0) return [{ type: "NONE" }];

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
                if (type === "STE" || type === "STE_EX") {
                    results.push({
                        type: relType,
                        parentId: this._findBioParentSpouseOf(child, parent),
                        isEx: type === "STE_EX"
                    });
                }
            }
        };
        checkStep(idA, idB, "STEP_PARENT");
        checkStep(idB, idA, "STEP_CHILD");
        return results;
    }

    _findBioParentSpouseOf(childId, stepParentId) {
        const bioParents = this.lineageParents.get(childId) || [];
        for (const bioP of bioParents) {
            if (this._getUnionStatus(bioP, stepParentId)) return bioP;
        }
        return "Unknown";
    }

    _findStepSibling(idA, idB) {
        const parentsA = this.allParents.get(idA) || [];
        const parentsB = this.allParents.get(idB) || [];

        for (const pA of parentsA) {
            for (const pB of parentsB) {
                if (pA === pB) continue;

                let uStatus = this._getUnionStatus(pA, pB);

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
                        uStatus = { active: true, reason: null, type: "PART" };
                    }
                }

                if (uStatus) {
                    const sharedParents = parentsA.filter((p) => parentsB.includes(p));

                    const shareLineageParent = sharedParents.some(
                        (p) =>
                            this.lineageParents.get(idA).includes(p) &&
                            this.lineageParents.get(idB).includes(p)
                    );

                    if (!shareLineageParent) {
                        return {
                            type: "STEP_SIBLING",
                            parentA: pA,
                            parentB: pB,
                            unionActive: uStatus.active,
                            unionReason: uStatus.reason,
                            parentsDivorced: !uStatus.active && uStatus.reason !== "WID"
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

        if (!ancA.has(idA)) ancA.set(idA, []);
        ancA.get(idA).push({
            dist: 0,
            isStep: false,
            isExStep: false,
            type: "SELF",
            lineageType: "SELF",
            viaPartner: null
        });

        if (!ancB.has(idB)) ancB.set(idB, []);
        ancB.get(idB).push({
            dist: 0,
            isStep: false,
            isExStep: false,
            type: "SELF",
            lineageType: "SELF",
            viaPartner: null
        });

        const commonAncestors = [];

        for (const [id, pathsA] of ancA) {
            if (ancB.has(id)) {
                const pathsB = ancB.get(id);

                pathsA.forEach((metaA) => {
                    pathsB.forEach((metaB) => {
                        commonAncestors.push({
                            id,
                            distA: metaA.dist,
                            distB: metaB.dist,
                            isStep: metaA.isStep || metaB.isStep,
                            isExStep: metaA.isExStep || metaB.isExStep,
                            typeA: metaA.type,
                            typeB: metaB.type,
                            lineageA: metaA.lineageType,
                            lineageB: metaB.lineageType,
                            viaPartnerA: metaA.viaPartner,
                            viaPartnerB: metaB.viaPartner,
                            initialBranchA: metaA.initialBranch,
                            initialBranchB: metaB.initialBranch
                        });
                    });
                });
            }
        }

        if (commonAncestors.length === 0) return [];

        let lcas = commonAncestors.filter((candidate) => {
            return !commonAncestors.some((other) => {
                if (other.id === candidate.id) return false;

                // Standard check: Is 'other' a descendant of 'candidate'?
                // And is 'other' strictly closer to both subjects?
                const isAncestor = this._isAncestor(candidate.id, other.id);
                const isCloser = candidate.distA > other.distA && candidate.distB > other.distB;

                if (isAncestor && isCloser) {
                    // Lineage Protection:
                    // If the distant ancestor (candidate) comes from the exact same immediate
                    // parent branch (initialBranchB) as the closer ancestor (other), prune it.
                    // This handles cases where the lineage type changes mid-stream (e.g. Bio Dad -> Adoptive Grandpa).
                    // We prioritize the closer relationship (Father) over the distant one (Uncle/Grandpa).

                    if (candidate.initialBranchB === other.initialBranchB) return true;

                    // Fallback for cases where initialBranch might be identical/null (e.g. siblings)
                    // but lineage types differ significantly (Double/Ghost relationships).
                    const sameLineageA = candidate.lineageA === other.lineageA;
                    const sameLineageB = candidate.lineageB === other.lineageB;

                    if (sameLineageA && sameLineageB) {
                        return true;
                    }
                }

                return false;
            });
        });

        // Group by Tier AND Lineage Type
        // This ensures Bio and Adoptive paths to the same ancestor are kept separate
        const tiers = new Map();
        lcas.forEach((lca) => {
            const tierKey = `${lca.distA}-${lca.distB}-${lca.isStep}-${lca.isExStep}-${lca.lineageA}-${lca.lineageB}`;
            if (!tiers.has(tierKey)) tiers.set(tierKey, []);
            tiers.get(tierKey).push(lca);
        });

        const finalRels = [];
        tiers.forEach((group) => {
            const sample = group[0];
            const { distA, distB, isStep, isExStep } = sample;
            const lcaCount = group.length;

            let isHalf = false;
            let isDouble = false;
            let isAmbiguous = false;

            // BLOOD RELATIONSHIP CHECKS
            if (!isStep && !isExStep) {
                // Exclude Direct Lineage from Half/Ambiguous Logic
                if (distA === 0 || distB === 0) {
                    // Direct Parent/Child.
                    // Do not mark half/ambiguous.
                }

                // Sibling Case (1-1)
                else if (distA === 1 && distB === 1) {
                    const parentsA = this.lineageParents.get(idA) || [];
                    const parentsB = this.lineageParents.get(idB) || [];
                    const lenA = parentsA.length;
                    const lenB = parentsB.length;

                    if (lenA >= 2 && lenB >= 2) {
                        if (lcaCount === 1) isHalf = true;
                    } else if ((lenA === 2 && lenB === 1) || (lenA === 1 && lenB === 2)) {
                        if (lcaCount === 1) isAmbiguous = true;
                    } else if (lenA === 1 && lenB === 1) {
                        isAmbiguous = true;
                    }
                }

                // Avuncular Case (1-N) or (N-1)
                else if (distA === 1 || distB === 1) {
                    // Ensure we are not confusing Parent (0-1) with Uncle (1-2)
                    // (Handled by the distA===0 check at top)

                    const uId = distA === 1 ? idA : idB;
                    const parentsUncle = this.lineageParents.get(uId) || [];

                    if (lcaCount === 1) {
                        if (parentsUncle.length >= 2) {
                            isHalf = true;
                        } else {
                            // If Uncle has missing parent record, it is Ambiguous, not assumed Full.
                            isAmbiguous = true;
                        }
                    }
                }

                // Cousin Case (N-N)
                else {
                    const pA = sample.viaPartnerA;
                    const pB = sample.viaPartnerB;

                    if (pA && pB) {
                        if (pA !== pB) isHalf = true;
                    }
                }

                // Double Logic
                if (lcaCount >= 2 && distA > 1 && distB > 1) {
                    const uniqueIDs = new Set(group.map((g) => g.id));
                    if (uniqueIDs.size >= 2) {
                        if (lcaCount === 2) {
                            const p1 = group[0].id;
                            const p2 = group[1].id;
                            // Only flag isDouble if they are distinct people AND not partners
                            if (p1 !== p2 && !this._arePartners(p1, p2)) isDouble = true;
                        } else {
                            isDouble = true;
                        }
                    }
                }
            }

            let isAdoptive = false;
            let isFoster = false;

            group.forEach((lca) => {
                if (
                    ["ADO", "FOS", "LEGL"].includes(lca.typeA) ||
                    ["ADO", "FOS", "LEGL"].includes(lca.typeB)
                ) {
                    if (lca.typeA === "ADO" || lca.typeB === "ADO") isAdoptive = true;
                    if (lca.typeA === "FOS" || lca.typeB === "FOS") isFoster = true;
                }
                if (lca.lineageA === "ADO" || lca.lineageB === "ADO") isAdoptive = true;
            });

            finalRels.push({
                type: "LINEAGE",
                ancestorIds: group.map((g) => g.id),
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
        if (idA === idB) return false;

        if (this._getUnionStatus(idA, idB)) return true;

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

        const queue = [
            {
                id: startId,
                dist: 0,
                isStep: false,
                isExStep: false,
                lineageType: "BIO",
                viaPartner: null,
                viaNode: null,
                initialBranch: null
            }
        ];

        while (queue.length > 0) {
            const { id, dist, isStep, isExStep, lineageType, initialBranch } = queue.shift();

            const parents = this.allParents.get(id) || [];
            const types = this.parentTypes.get(id);

            // Inline helper to find partners
            const findPartner = (childId, parentId) => {
                const allP = this.allParents.get(childId) || [];
                const tMap = this.parentTypes.get(childId);
                const currentType = tMap.get(parentId);

                if (currentType === "BIO") {
                    const bioPartner = allP.find((p) => p !== parentId && tMap.get(p) === "BIO");
                    if (bioPartner) return bioPartner;
                }
                return allP.find((p) => p !== parentId) || null;
            };

            parents.forEach((pId) => {
                const pType = types.get(pId);
                const nextIsStep = isStep || pType === "STE" || pType === "STE_EX";
                const nextIsExStep = isExStep || pType === "STE_EX";

                let nextLineageType = lineageType;
                if (pType === "ADO") nextLineageType = "ADO";
                else if (pType === "BIO") nextLineageType = lineageType;
                else if (pType === "STE") nextLineageType = "STE";

                const partnerId = findPartner(id, pId);

                // Determine Branch Root
                // If dist is 0 (Self), the parent we are moving to IS the start of the branch.
                // Otherwise, we propagate the existing branch identifier.
                const nextInitialBranch = dist === 0 ? pId : initialBranch;

                const newEntry = {
                    dist: dist + 1,
                    isStep: nextIsStep,
                    isExStep: nextIsExStep,
                    type: pType,
                    lineageType: nextLineageType,
                    viaPartner: partnerId,
                    viaNode: id, // The child node we came from
                    initialBranch: nextInitialBranch // The root parent of this path
                };

                if (!visited.has(pId)) visited.set(pId, []);
                const existing = visited.get(pId);

                // Enhanced Redundancy Check
                // We now verify 'initialBranch' uniqueness. This ensures that if we reach
                // the same Ancestor via Mom AND via Dad (Endogamy), we keep BOTH paths
                // even if they share the same distance and lineage type.
                const isRedundant = existing.some(
                    (e) =>
                        e.dist === newEntry.dist &&
                        e.lineageType === newEntry.lineageType &&
                        e.isStep === newEntry.isStep &&
                        e.viaNode === newEntry.viaNode &&
                        e.initialBranch === newEntry.initialBranch
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
        const spousesA = this.spouses.get(idA) || new Map();
        spousesA.forEach((status, spouseId) => {
            if (spouseId === idB) return;
            const rels = this._findLineageRelationships(spouseId, idB);
            rels.forEach((rel) => {
                results.push({
                    type: "AFFINAL",
                    subType: "VIA_SPOUSE",
                    spouseId: spouseId,
                    bloodRel: rel,
                    isExUnion: !status.active,
                    unionReason: status.reason
                });
            });
        });

        const spousesB = this.spouses.get(idB) || new Map();
        spousesB.forEach((status, spouseId) => {
            if (spouseId === idA) return;
            const rels = this._findLineageRelationships(idA, spouseId);
            rels.forEach((rel) => {
                results.push({
                    type: "AFFINAL",
                    subType: "VIA_BLOOD_SPOUSE",
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

                const rels = this._findLineageRelationships(spouseIdA, spouseIdB);

                rels.forEach((rel) => {
                    results.push({
                        type: "CO_AFFINAL",
                        subType: "SPOUSES_ARE_RELATIVES", // Updated generic subtype
                        spouseA: spouseIdA,
                        spouseB: spouseIdB,
                        bloodRel: rel // Capture specific lineage for text generation
                    });
                });
            });
        });
    }

    _findGeneralizedAffinalRelationships(idA, idB, results) {
        const relativesA = this._getConnectedRelatives(idA);

        for (const spouse1Id of relativesA) {
            if (spouse1Id === idA) continue;

            // Check if this relative has a spouse (Fast lookup)
            const spousesMap = this.spouses.get(spouse1Id);
            if (!spousesMap) continue;

            // Confirm the specific relationship type (e.g., Cousin, Sibling)
            const relsA = this._findLineageRelationships(idA, spouse1Id);
            if (relsA.length === 0) continue;

            for (const [spouse2Id, status] of spousesMap) {
                if (!status.active) continue; // Generally, generalized affinal links traverse current unions
                if (spouse2Id === idB) continue;

                // Check if the relative's spouse is related to idB
                const relsB = this._findLineageRelationships(spouse2Id, idB);

                if (relsB.length > 0) {
                    relsA.forEach((relA) => {
                        relsB.forEach((relB) => {
                            results.push({
                                type: "EXTENDED_AFFINAL",
                                subType: "GENERALIZED",
                                spouse1Id: spouse1Id,
                                spouse2Id: spouse2Id,
                                relA: relA,
                                relB: relB
                            });
                        });
                    });
                }
            }
        }
    }

    /**
     * Helper: BFS to find all nodes reachable via Parent/Child links (Ancestors, Descendants, Cousins, etc.)
     * Used to restrict search space for affinal lookups.
     */
    _getConnectedRelatives(startId) {
        const visited = new Set();
        const queue = [startId];
        visited.add(startId);

        const relatives = [];

        while (queue.length > 0) {
            const curr = queue.shift();
            relatives.push(curr);

            // Traverse Up (Parents)
            const parents = this.allParents.get(curr) || [];
            for (const p of parents) {
                if (!visited.has(p)) {
                    visited.add(p);
                    queue.push(p);
                }
            }

            // Traverse Down (Children)
            const children = this.childrenMap.get(curr);
            if (children) {
                for (const c of children) {
                    if (!visited.has(c)) {
                        visited.add(c);
                        queue.push(c);
                    }
                }
            }
        }
        return relatives;
    }

    _isAncestor(ancestorId, descendantId) {
        const q = [descendantId];
        const v = new Set();
        while (q.length > 0) {
            const curr = q.shift();
            if (curr === ancestorId) return true;
            if (v.has(curr)) continue;
            v.add(curr);
            (this.allParents.get(curr) || []).forEach((p) => q.push(p));
        }
        return false;
    }

    _deduplicateResults(results) {
        const unique = new Map();
        results.forEach((res) => {
            let key = res.type;
            if (res.type === "LINEAGE") {
                key += `-${res.distA}-${res.distB}-${res.isStep}-${res.isExStep}-${res.isHalf}-${res.isAmbiguous}-${res.lineageA}-${res.lineageB}`;
            }
            if (res.type === "UNION" || res.type === "FORMER_UNION") {
                key += `-${res.target}`;
            }
            if (res.type === "AFFINAL") {
                key += `-${res.subType}-${res.spouseId}-${res.bloodRel.distA}-${res.bloodRel.distB}`;
            }
            if (res.type === "CO_AFFINAL") {
                key += `-${res.spouseA}-${res.spouseB}`;
                if (res.bloodRel) {
                    key += `-${res.bloodRel.distA}-${res.bloodRel.distB}-${res.bloodRel.isHalf}-${res.bloodRel.isDouble}`;
                }
            }
            if (res.type === "EXTENDED_AFFINAL") {
                if (res.subType === "GENERALIZED") {
                    key += `-${res.subType}-${res.spouse1Id}-${res.spouse2Id}-${res.relA.distA}-${res.relB.distA}`;
                }
            }
            if (res.type === "STEP_PARENT" || res.type === "STEP_CHILD") {
                key += `-${res.parentId}-${res.isEx}`;
            }
            if (res.type === "STEP_SIBLING") {
                key += `-${res.parentA}-${res.parentB}`;
            }

            if (!unique.has(key)) unique.set(key, res);
        });
        return Array.from(unique.values());
    }

    _filterRedundant(results) {
        const hasSpecificRel = results.some(
            (r) => r.type !== "EXTENDED_AFFINAL" && r.type !== "NONE"
        );
        if (hasSpecificRel) {
            results = results.filter((r) => r.type !== "EXTENDED_AFFINAL");
        }

        const isDirectStepParent = results.some((r) => r.type === "STEP_PARENT");
        if (isDirectStepParent) {
            // Remove redundant LINEAGE (Step)
            results = results.filter(
                (r) => !(r.type === "LINEAGE" && (r.isStep || r.isExStep) && r.distB === 1)
            );
            // Remove redundant AFFINAL (Step-Parent via Spouse)
            // If we already know they are a Step-Parent, we don't need the "Spouse of Parent" affinal entry,
            // which often carries the incorrect "Former" tag due to widowhood logic.
            results = results.filter(
                (r) =>
                    !(r.type === "AFFINAL" && r.subType === "VIA_SPOUSE" && r.bloodRel.distA === 0)
            );
        }

        const isDirectStepChild = results.some((r) => r.type === "STEP_CHILD");
        if (isDirectStepChild) {
            // Remove redundant LINEAGE (Step)
            results = results.filter(
                (r) => !(r.type === "LINEAGE" && (r.isStep || r.isExStep) && r.distA === 1)
            );
            // Remove redundant AFFINAL (Step-Child via Blood Spouse)
            results = results.filter(
                (r) =>
                    !(
                        r.type === "AFFINAL" &&
                        r.subType === "VIA_BLOOD_SPOUSE" &&
                        r.bloodRel.distB === 0
                    )
            );
        }

        const isStepSibling = results.some((r) => r.type === "STEP_SIBLING");
        if (isStepSibling) {
            results = results.filter(
                (r) =>
                    !(
                        r.type === "LINEAGE" &&
                        (r.isStep || r.isExStep) &&
                        r.distA === 1 &&
                        r.distB === 1
                    )
            );
        }

        // Deduplicate Step-Relationships derived from Spousal Pairs
        // Example: Step-Grand-Nephew -> Step-Mom (Bio) vs Step-Grand-Nephew -> Dad (Step).
        // If two Lineage results have identical distances and step-status, and their ancestors are partners, drop one.
        const stepLineages = results.filter(
            (r) => r.type === "LINEAGE" && (r.isStep || r.isExStep)
        );
        if (stepLineages.length > 1) {
            const toRemove = new Set();

            for (let i = 0; i < stepLineages.length; i++) {
                for (let j = i + 1; j < stepLineages.length; j++) {
                    const r1 = stepLineages[i];
                    const r2 = stepLineages[j];

                    // Must match in distance and type
                    if (
                        r1.distA === r2.distA &&
                        r1.distB === r2.distB &&
                        r1.isStep === r2.isStep &&
                        r1.isExStep === r2.isExStep
                    ) {
                        const anc1 = r1.ancestorIds[0];
                        const anc2 = r2.ancestorIds[0];

                        if (anc1 !== anc2 && this._arePartners(anc1, anc2)) {
                            // Redundancy found. Remove the second one.
                            toRemove.add(r2);
                        }
                    }
                }
            }

            if (toRemove.size > 0) {
                results = results.filter((r) => !toRemove.has(r));
            }
        }

        const isBlood = results.some((r) => r.type === "LINEAGE" && !r.isStep && !r.isExStep);
        if (isBlood) {
            const isDirectLineage = results.some(
                (r) =>
                    r.type === "LINEAGE" &&
                    !r.isStep &&
                    !r.isExStep &&
                    (r.distA === 0 || r.distB === 0)
            );
            if (isDirectLineage) {
                results = results.filter((r) => r.type !== "AFFINAL");
            }
            results = results.filter((r) => !(r.type === "LINEAGE" && (r.isStep || r.isExStep)));
        }

        // If someone is a Direct Ancestor (e.g., Father), suppress "Collateral" versions
        // of that same relationship type (e.g., Uncle) if they come from the same lineage type.
        // This prevents "Adoptive Father" from also appearing as "Adoptive Uncle".
        const directAncestors = results.filter((r) => r.type === "LINEAGE" && r.distA === 0);
        if (directAncestors.length > 0) {
            results = results.filter((r) => {
                if (r.type !== "LINEAGE") return true;
                if (r.distA === 0) return true; // Keep the parent relationship

                // Check if this collateral relationship (e.g. Uncle) is redundant
                // because we already have a direct ancestor (Parent) of the same lineage type (BIO/ADO)
                const isRedundant = directAncestors.some(
                    (parentRel) =>
                        // Check if Lineage Types match (e.g. both are Adoptive)
                        parentRel.isAdoptive === r.isAdoptive &&
                        parentRel.isFoster === r.isFoster &&
                        // Ensure we don't suppress distinct Biological links if the Parent is Adoptive
                        !parentRel.isStep // Step-parents are handled separately
                );

                return !isRedundant;
            });
        }

        return results;
    }
}

export class RelationText {
    constructor(records) {
        this.records = records;
    }

    describe(rel, genderA, nameB, nameA) {
        if (rel.type === "IDENTITY") return { term: "Same Person", detail: "" };
        if (rel.type === "UNION") {
            const isMarr = rel.unionType === "MARR" || rel.unionType === "CIVL";
            const t =
                genderA === "M"
                    ? isMarr
                        ? "Husband"
                        : "Partner"
                    : genderA === "F"
                      ? isMarr
                          ? "Wife"
                          : "Partner"
                      : isMarr
                        ? "Spouse"
                        : "Partner";
            return { term: t, detail: "Direct current union." };
        }

        if (rel.type === "FORMER_UNION") {
            const isMarr = rel.unionType === "MARR" || rel.unionType === "CIVL";
            const t =
                genderA === "M"
                    ? isMarr
                        ? "Ex-Husband"
                        : "Former Partner"
                    : genderA === "F"
                      ? isMarr
                          ? "Ex-Wife"
                          : "Former Partner"
                      : isMarr
                        ? "Former Spouse"
                        : "Former Partner";
            const reason = rel.reason ? ` (${rel.reason})` : "";
            return { term: t, detail: `Relationship ended${reason}.` };
        }

        if (rel.type === "STEP_PARENT") {
            const prefix = rel.isEx ? "Former Step-" : "Step-";
            const t = genderA === "M" ? "Father" : genderA === "F" ? "Mother" : "Parent";
            const spouseName = getDisplayName(this.records[rel.parentId]);
            return {
                term: prefix + t,
                detail: `${nameA} is the spouse of ${nameB}'s parent, ${spouseName}.`
            };
        }

        if (rel.type === "STEP_CHILD") {
            const prefix = rel.isEx ? "Former Step-" : "Step-";
            const t = genderA === "M" ? "Son" : genderA === "F" ? "Daughter" : "Child";
            const parentName = getDisplayName(this.records[rel.parentId]);
            return {
                term: prefix + t,
                detail: `${nameA} is the child of ${nameB}'s spouse, ${parentName}.`
            };
        }

        if (rel.type === "STEP_SIBLING") {
            const prefix = rel.parentsDivorced ? "Former " : "";

            const t =
                genderA === "M" ? "Step-Brother" : genderA === "F" ? "Step-Sister" : "Step-Sibling";

            let status = "";
            if (rel.unionReason === "WID") status = " (Widowed)";
            else if (rel.unionReason === "DIV" || rel.parentsDivorced) status = " (Divorced)";
            else if (rel.unionReason) status = ` (${rel.unionReason})`;

            const pAName = getDisplayName(this.records[rel.parentA]);
            const pBName = getDisplayName(this.records[rel.parentB]);

            return {
                term: prefix + t,
                detail: `Parents linked via union${status}: ${pAName} and ${pBName}.`
            };
        }

        if (rel.type === "CO_AFFINAL") {
            const spAName = getDisplayName(this.records[rel.spouseA]);
            const spBName = getDisplayName(this.records[rel.spouseB]);

            // Dynamic term generation
            // We use genderA to frame the "-in-law" term (e.g. "Co-Brother" vs "Co-Sister")
            const bloodTerm = this.getBloodTerm(
                rel.bloodRel.distA,
                rel.bloodRel.distB,
                genderA,
                rel.bloodRel.isHalf,
                rel.bloodRel.isDouble,
                rel.bloodRel.isAdoptive,
                rel.bloodRel.isStep,
                rel.bloodRel.isExStep,
                rel.bloodRel.isAmbiguous
            );

            return {
                term: `Co-${bloodTerm}-in-law`,
                detail: `${nameA}'s spouse (${spAName}) is the ${bloodTerm} of ${nameB}'s spouse (${spBName}).`
            };
        }

        if (rel.type === "EXTENDED_AFFINAL") {
            const spouseName = getDisplayName(this.records[rel.spouseId]);
            const spouseGender = getGender(this.records[rel.spouseId]);

            if (rel.subType === "VIA_SIBLING_SPOUSE") {
                const myInLawTerm =
                    genderA === "M"
                        ? "Brother-in-law"
                        : genderA === "F"
                          ? "Sister-in-law"
                          : "Sibling-in-law";

                const relativeTerm = this.getBloodTerm(
                    rel.bloodRel.distA,
                    rel.bloodRel.distB,
                    spouseGender,
                    rel.bloodRel.isHalf,
                    rel.bloodRel.isDouble,
                    rel.bloodRel.isAdoptive,
                    rel.bloodRel.isStep,
                    rel.bloodRel.isExStep,
                    rel.bloodRel.isAmbiguous
                );
                return {
                    term: `${myInLawTerm} of ${relativeTerm}`,
                    detail: `${nameA} is the ${myInLawTerm} of ${nameB}'s ${relativeTerm}, ${spouseName}.`
                };
            }

            if (rel.subType === "VIA_BLOOD_SPOUSE_SIBLING") {
                const inLawTerm =
                    spouseGender === "M"
                        ? "Brother-in-law"
                        : spouseGender === "F"
                          ? "Sister-in-law"
                          : "Sibling-in-law";

                const relativeTerm = this.getBloodTerm(
                    rel.bloodRel.distA,
                    rel.bloodRel.distB,
                    genderA,
                    rel.bloodRel.isHalf,
                    rel.bloodRel.isDouble,
                    rel.bloodRel.isAdoptive,
                    rel.bloodRel.isStep,
                    rel.bloodRel.isExStep,
                    rel.bloodRel.isAmbiguous
                );
                return {
                    term: `${relativeTerm} of ${inLawTerm}`,
                    detail: `${nameA} is the ${relativeTerm} of ${nameB}'s ${inLawTerm}, ${spouseName}.`
                };
            }

            if (rel.subType === "GENERALIZED") {
                const termA = this.getBloodTerm(
                    rel.relA.distA,
                    rel.relA.distB,
                    genderA,
                    rel.relA.isHalf,
                    rel.relA.isDouble,
                    rel.relA.isAdoptive,
                    rel.relA.isStep,
                    rel.relA.isExStep
                );
                const mockAffinalRel = {
                    type: "AFFINAL",
                    subType: "VIA_BLOOD_SPOUSE",
                    spouseId: rel.spouse1Id,
                    bloodRel: rel.relB,
                    isExUnion: false
                };
                const s1Gender = getGender(this.records[rel.spouse1Id]);
                const termS1toB = this.describeAffinal(
                    mockAffinalRel,
                    s1Gender,
                    nameB,
                    "TEMP"
                ).term;
                return {
                    term: `${termA} of ${termS1toB}`,
                    detail: `${nameA} is the ${termA} of ${termS1toB}, ${getDisplayName(this.records[rel.spouse1Id])}.`
                };
            }
        }

        if (rel.type === "LINEAGE") {
            let specialPrefix = "";
            let handledAdoptive = false;

            if (!rel.isStep && !rel.isExStep) {
                if (rel.distB === 1) {
                    if (rel.distA === 0) {
                        // Support Donor/Surrogate Terminology
                        if (rel.lineageA === "DONR") {
                            specialPrefix = "Sperm Donor";
                            handledAdoptive = true;
                        } else if (rel.lineageA === "SURR") {
                            specialPrefix = "Surrogate Mother";
                            handledAdoptive = true;
                        } else if (rel.isFoster) {
                            specialPrefix = "Foster ";
                            handledAdoptive = true;
                        } else if (rel.isAdoptive) {
                            specialPrefix = "Adoptive ";
                            handledAdoptive = true;
                        }
                    } else {
                        if (rel.isFoster) {
                            specialPrefix = "Foster ";
                            handledAdoptive = true;
                        } else if (rel.isAdoptive) {
                            specialPrefix = "Adopted ";
                            handledAdoptive = true;
                        }
                    }
                } else if (rel.distB === 0 && rel.distA === 1) {
                    if (rel.isFoster) {
                        specialPrefix = "Foster ";
                        handledAdoptive = true;
                    } else if (rel.isAdoptive) {
                        specialPrefix = "Adopted ";
                        handledAdoptive = true;
                    }
                }
            }

            if (!handledAdoptive && (rel.lineageA === "ADO" || rel.lineageB === "ADO")) {
                specialPrefix += "(Adoptive) ";
            }

            // If Donor/Surrogate handled above, we don't need 'Father/Mother' appended unless it's pure prefix
            let term = "";
            if (handledAdoptive && (rel.lineageA === "DONR" || rel.lineageA === "SURR")) {
                term = specialPrefix;
                specialPrefix = ""; // Clear prefix so it isn't duplicated
            } else {
                term = this.getBloodTerm(
                    rel.distA,
                    rel.distB,
                    genderA,
                    rel.isHalf,
                    rel.isDouble,
                    rel.isAdoptive,
                    rel.isStep,
                    rel.isExStep,
                    rel.isAmbiguous
                );
            }

            const commonName = getDisplayName(this.records[rel.ancestorIds[0]]);
            const lcaCount = rel.ancestorIds.length;
            const sA = rel.distA === 1 ? "step" : "steps";
            const sB = rel.distB === 1 ? "step" : "steps";

            let det = `Common Ancestor: ${commonName}`;
            if (lcaCount > 1) det += ` (+ ${lcaCount - 1} other${lcaCount > 2 ? "s" : ""})`;
            det += ` (${rel.distA} ${sA} up, ${rel.distB} ${sB} up).`;

            if (rel.isStep) det += ` [via Step-Relationship]`;
            if (rel.isExStep) det += ` [via Former Step-Relationship]`;

            return { term: specialPrefix + term, detail: det };
        }

        if (rel.type === "AFFINAL") {
            return this.describeAffinal(rel, genderA, nameB, nameA);
        }

        return { term: "Unknown", detail: "" };
    }

    describeAffinal(rel, genderA, nameB, nameA) {
        const bloodDistA = rel.bloodRel.distA;
        const bloodDistB = rel.bloodRel.distB;
        const bloodGender = getGender(this.records[rel.spouseId]);
        const spouseName = getDisplayName(this.records[rel.spouseId]);

        const prefixEx = (t) => (rel.isExUnion ? `Former ${t}` : t);
        const isStep = rel.bloodRel.isStep;
        const isExStep = rel.bloodRel.isExStep;

        const getBaseTerm = (dA, dB, g) => {
            return this.getBloodTerm(
                dA,
                dB,
                g,
                rel.bloodRel.isHalf,
                rel.bloodRel.isDouble,
                rel.bloodRel.isAdoptive,
                isStep,
                isExStep,
                rel.bloodRel.isAmbiguous
            );
        };

        // Helper to handle Step-Prefixing consistent with other Affinal terms
        const applyStep = (coreTerm) => {
            if (isExStep) return `Former Step-${coreTerm}`;
            if (isStep) return `Step-${coreTerm}`;
            return coreTerm;
        };

        let term = "In-Law";
        let detail = "";

        if (rel.subType === "VIA_SPOUSE") {
            // CASE 1: Child-in-law (Spouse's Child)
            if (bloodDistB === 0) {
                const core = this.getDescendantTerm(bloodDistA, genderA);
                term = prefixEx(`${core}-in-law`);
            }
            // CASE 2: Parent-in-law (Spouse's Parent)
            else if (bloodDistA === 0) {
                const core = this.getAncestorTerm(bloodDistB, genderA);
                // Note: Step-Parents are typically handled by "STEP_PARENT" type,
                // but this covers "Step-Mother-in-law" (Spouse's Step-Mom)
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 3: Sibling-in-law (Spouse's Sibling)
            else if (bloodDistA === 1 && bloodDistB === 1) {
                const core = genderA === "M" ? "Brother" : genderA === "F" ? "Sister" : "Sibling";
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 4: Aunt/Uncle-in-law (Spouse's Aunt/Uncle)
            else if (bloodDistA === 1 && bloodDistB > 1) {
                // Spouse (A in lineage) is Child of Ancestor. Target (B) is Grandchild+.
                // Spouse is Uncle/Aunt. I am Uncle/Aunt-in-law.
                const core = this.getNiblingTerm(bloodDistB - 1, genderA, true);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 5: Niece/Nephew-in-law (Spouse's Niece/Nephew)
            else if (bloodDistB === 1 && bloodDistA > 1) {
                // Spouse (A) is Grandchild+. Target (B) is Child of Ancestor.
                // Spouse is Nibling. I am Niece/Nephew-in-law.
                const core = this.getNiblingTerm(bloodDistA - 1, genderA, false);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // FALLBACK: Cousin-in-law, etc.
            else {
                term = prefixEx(`${getBaseTerm(bloodDistA, bloodDistB, genderA)}-in-law`);
            }

            detail = `${nameA} is the ${rel.isExUnion ? "former " : ""}spouse of ${spouseName}, who is the ${getBaseTerm(bloodDistA, bloodDistB, bloodGender)} of ${nameB}.`;
        } else if (rel.subType === "VIA_BLOOD_SPOUSE") {
            // CASE 1: Parent-in-law (Spouse of Parent)
            if (bloodDistA === 0) {
                const core = this.getAncestorTerm(bloodDistB, genderA);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 2: Child-in-law (Spouse of Child)
            else if (bloodDistB === 0) {
                const core = this.getDescendantTerm(bloodDistA, genderA);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 3: Sibling-in-law (Spouse of Sibling)
            else if (bloodDistA === 1 && bloodDistB === 1) {
                const core = genderA === "M" ? "Brother" : genderA === "F" ? "Sister" : "Sibling";
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 4: Aunt/Uncle-in-law (Spouse of Aunt/Uncle)
            else if (bloodDistA === 1 && bloodDistB > 1) {
                // I (A) am Child of Ancestor. Relative (R) is Grandchild+.
                // I am Uncle/Aunt. B is Spouse of Nibling.
                // This makes me the Uncle/Aunt-in-law of B.
                const core = this.getNiblingTerm(bloodDistB - 1, genderA, true);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // CASE 5: Niece/Nephew-in-law (Spouse of Niece/Nephew)
            else if (bloodDistB === 1 && bloodDistA > 1) {
                // I (A) am Grandchild+. Relative (R) is Child of Ancestor.
                // I am Nibling. B is Spouse of Uncle.
                // This makes me the Niece/Nephew-in-law of B.
                const core = this.getNiblingTerm(bloodDistA - 1, genderA, false);
                term = prefixEx(`${applyStep(core)}-in-law`);
            }
            // FALLBACK
            else {
                term = prefixEx(`${getBaseTerm(bloodDistA, bloodDistB, genderA)}-in-law`);
            }

            detail = `${nameB} is the ${rel.isExUnion ? "former " : ""}spouse of ${nameA}'s relative, ${spouseName}.`;
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
            return prefix + (sex === "M" ? "Brother" : sex === "F" ? "Sister" : "Sibling") + suffix;
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
        if (dist === 1) return sex === "M" ? "Father" : sex === "F" ? "Mother" : "Parent";
        if (dist === 2)
            return sex === "M" ? "Grandfather" : sex === "F" ? "Grandmother" : "Grandparent";
        if (dist === 3)
            return sex === "M"
                ? "Great-Grandfather"
                : sex === "F"
                  ? "Great-Grandmother"
                  : "Great-Grandparent";
        return `${dist - 2}x Great-Grandparent`;
    }

    getDescendantTerm(dist, sex) {
        if (dist === 1) return sex === "M" ? "Son" : sex === "F" ? "Daughter" : "Child";
        if (dist === 2)
            return sex === "M" ? "Grandson" : sex === "F" ? "Granddaughter" : "Grandchild";
        if (dist === 3)
            return sex === "M"
                ? "Great-Grandson"
                : sex === "F"
                  ? "Great-Granddaughter"
                  : "Great-Grandchild";
        return `${dist - 2}x Great-Grandchild`;
    }

    getNiblingTerm(genDiff, sex, isUncleAunt) {
        if (isUncleAunt) {
            if (genDiff === 1)
                return sex === "M" ? "Uncle" : sex === "F" ? "Aunt" : "Parent's Sibling";
            if (genDiff === 2)
                return sex === "M"
                    ? "Great-Uncle"
                    : sex === "F"
                      ? "Great-Aunt"
                      : "Grand-Uncle/Aunt";
            return `${genDiff - 2}x Great-Uncle/Aunt`;
        } else {
            if (genDiff === 1)
                return sex === "M" ? "Nephew" : sex === "F" ? "Niece" : "Sibling's Child";
            if (genDiff === 2)
                return sex === "M"
                    ? "Great-Nephew"
                    : sex === "F"
                      ? "Great-Niece"
                      : "Grand-Niece/Nephew";
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
        const pref = rec.data.NAME.find((n) => n.parsed[3] === "PREF");
        if (pref) return pref.parsed[0];
        if (rec.data.NAME[0]) return rec.data.NAME[0].parsed[0];
    }
    return rec.id;
}

export function getGender(rec) {
    if (rec && rec.data.SEX && rec.data.SEX[0]) {
        return rec.data.SEX[0].parsed[0].trim().toUpperCase();
    }
    return "U";
}
