import FTTParser from '../../implementations/js/FTTParser.js';

const parser = new FTTParser();

self.onmessage = (e) => {
    const { fttContent } = e.data;
    try {
        const result = parser.parse(fttContent);
        const ranks = calculateGenerations(result.records);
        const elements = convertToCytoscape(result, ranks); 

        self.postMessage({
            type: 'SUCCESS',
            payload: {
                elements,
                errors: result.errors,
                warnings: result.warnings
            }
        });
    } catch (err) {
        self.postMessage({
            type: 'CRITICAL_ERROR',
            payload: { message: err.message }
        });
    }
};

function calculateGenerations(records) {
    const idToRank = {};
    const parent = new Map();
    const rank = new Map();
    Object.keys(records).forEach(id => {
        parent.set(id, id);
        rank.set(id, 0);
    });
    function find(i) {
        if (parent.get(i) !== i) {
            parent.set(i, find(parent.get(i)));
        }
        return parent.get(i);
    }
    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            const rankI = rank.get(rootI);
            const rankJ = rank.get(rootJ);
            if (rankI < rankJ) {
                parent.set(rootI, rootJ);
            } else if (rankI > rankJ) {
                parent.set(rootJ, rootI);
            } else {
                parent.set(rootJ, rootI);
                rank.set(rootI, rankI + 1);
            }
        }
    }
    Object.values(records).forEach(rec => {
        if (rec.data.UNION) {
            rec.data.UNION.forEach(u => {
                const partner = u.parsed[0];
                if (records[partner]) union(rec.id, partner);
            });
        }
    });
    const clusterMap = new Map();
    Object.keys(records).forEach(id => clusterMap.set(id, find(id)));
    
    // Add implicit parents to cluster logic to avoid crashes
    // (Ideally implicit parents are handled, but for rank calc we focus on records.
    //  Implicit parents will default to rank 0 later if not found here.)
    
    const uniqueClusters = new Set(clusterMap.values());
    const clusterGraph = new Map();
    uniqueClusters.forEach(cId => {
        clusterGraph.set(cId, { parents: new Set(), rank: 0 });
    });
    Object.values(records).forEach(child => {
        if (child.data.PARENT) {
            const childCluster = clusterMap.get(child.id);
            child.data.PARENT.forEach(p => {
                const parentId = p.parsed[0];
                if (records[parentId]) {
                    const parentCluster = clusterMap.get(parentId);
                    if (parentCluster !== childCluster) {
                        clusterGraph.get(childCluster).parents.add(parentCluster);
                    }
                }
            });
        }
    });

    const memo = new Map();
    const visiting = new Set();
    function getRank(cId) {
        if (memo.has(cId)) return memo.get(cId);
        if (visiting.has(cId)) return 0;
        visiting.add(cId);
        let maxParentRank = -1;
        const node = clusterGraph.get(cId);
        if (node && node.parents.size > 0) {
            node.parents.forEach(pId => {
                const pRank = getRank(pId);
                if (pRank > maxParentRank) maxParentRank = pRank;
            });
        }
        visiting.delete(cId);
        const myRank = maxParentRank + 2; 
        memo.set(cId, myRank);
        return myRank;
    }
    uniqueClusters.forEach(cId => getRank(cId));
    Object.keys(records).forEach(id => {
        const cId = clusterMap.get(id);
        idToRank[id] = memo.get(cId) || 0;
    });
    return idToRank;
}

function calculateNodeVisualOrder(records, ranks, allNodeIds) {
    const visualOrder = new Map(); 
    const idsByRank = new Map();

    // 1. Group IDs by Rank (Including implicit ones which default to 0)
    allNodeIds.forEach(id => {
        const r = ranks[id] || 0;
        if (!idsByRank.has(r)) idsByRank.set(r, []);
        idsByRank.get(r).push(id);
    });

    const maxRank = Math.max(...Array.from(idsByRank.keys()), 0);

    for (let r = 0; r <= maxRank; r++) {
        const ids = idsByRank.get(r) || [];
        
        ids.forEach((id, index) => {
            const rec = records[id];
            
            // Base Score
            let score = index * 0.0001;

            // Only apply parent logic if record exists
            if (rec && rec.data.PARENT && rec.data.PARENT.length > 0) {
                let parentScoreSum = 0;
                let parentCount = 0;

                rec.data.PARENT.forEach(p => {
                    const pId = p.parsed[0];
                    if (visualOrder.has(pId)) {
                        parentScoreSum += visualOrder.get(pId);
                        parentCount++;
                    }
                });

                if (parentCount > 0) {
                    score += (parentScoreSum / parentCount);
                }

                const primaryParentRef = rec.data.PARENT[0];
                const pId = primaryParentRef.parsed[0];
                // Check parent in records or implicit map?
                // For simplicity, we only optimize sorting if parent is in records
                const parentRec = records[pId];
                if (parentRec && parentRec.data.CHILD) {
                    const myIndex = parentRec.data.CHILD.findIndex(c => c.parsed[0] === id);
                    if (myIndex !== -1) {
                        score += (myIndex + 1);
                    }
                }
            } else {
                score += (index * 100);
            }
            visualOrder.set(id, score);
        });
    }

    return visualOrder;
}

function convertToCytoscape(parsedData, ranks) {
    const elements = [];
    const records = parsedData.records;
    const createdNodeIds = new Set();
    let unionCounter = 0;
    const pairToHubId = {};
    const soloToHubId = {};
    const createdLineageEdges = new Set();

    // Discovery Phase: Find Implicit Parents & Build Child Lists
    const parentToChildren = new Map();
    const allNodeIds = new Set(Object.keys(records));

    // A. Fill from Explicit Records (Manifests)
    for (const [id, rec] of Object.entries(records)) {
        if (rec.data.CHILD) {
            parentToChildren.set(id, rec.data.CHILD.map(c => c.parsed[0]));
        }
    }

    // B. Fill from Scanning Children (Find implicit parents)
    for (const [childId, childRec] of Object.entries(records)) {
        if (childRec.data.PARENT) {
            childRec.data.PARENT.forEach(p => {
                const parentId = p.parsed[0];
                allNodeIds.add(parentId); // Ensure implicit parent is in node list

                if (!parentToChildren.has(parentId)) {
                    parentToChildren.set(parentId, []);
                }
                
                // If parent is implicit (not in records), we must manually build the child list
                if (!records[parentId]) {
                    const list = parentToChildren.get(parentId);
                    if (!list.includes(childId)) {
                        list.push(childId);
                    }
                }
            });
        }
    }

    // C. Sort children of Implicit Parents (by Date)
    for (const [pId, children] of parentToChildren) {
        if (!records[pId]) {
             children.sort((a, b) => {
                 const dA = records[a]?.data.BORN?.[0]?.parsed[0] || "9999";
                 const dB = records[b]?.data.BORN?.[0]?.parsed[0] || "9999";
                 return dA.localeCompare(dB);
             });
        }
    }

    // [Step 2] Calculate Order (using expanded allNodeIds)
    const visualScores = calculateNodeVisualOrder(records, ranks, allNodeIds);

    const sortedNodeIds = Array.from(allNodeIds).sort((a, b) => {
        const scoreA = visualScores.get(a) || 0;
        const scoreB = visualScores.get(b) || 0;
        return scoreA - scoreB;
    });

    function addNode(id, label, subLabel, type) {
        if (createdNodeIds.has(id)) return;
        const rank = ranks[id] !== undefined ? ranks[id] : 0;
        elements.push({
            data: {
                id, label, subLabel, type,
                elk: { 'org.eclipse.elk.layered.layerIndex': rank }
            }
        });
        createdNodeIds.add(id);
    }

    function ensurePlaceholderNode(id) {
        if (!createdNodeIds.has(id)) {
            // Implicit/Placeholder node
            addNode(id, id, '(Unknown)', 'PLACEHOLDER');
        }
    }

    // [Step 3] Create Nodes
    for (const id of sortedNodeIds) {
        const rec = records[id];
        if (!rec) {
            ensurePlaceholderNode(id);
            continue;
        }
        if (rec.type === 'SOURCE' || rec.type === 'EVENT') continue;
        
        let label = id;
        let subLabel = "";
        if (rec.type === 'INDIVIDUAL' || rec.type === 'PLACEHOLDER') {
            if (rec.data.NAME && rec.data.NAME.length > 0) {
                label = rec.data.NAME[0].parsed[0] || id;
                const prefName = rec.data.NAME.find(n => n.parsed[3] === 'PREF');
                if (prefName) label = prefName.parsed[0];
            }
            if (rec.data.BORN && rec.data.BORN[0].parsed[0]) {
                subLabel = rec.data.BORN[0].parsed[0];
            }
        }
        addNode(id, label, subLabel, rec.type);
    }

    function getHub(p1, p2) {
        const isPair = !!p2;
        const key = isPair ? `${p1}+${p2}` : `${p1}+BIO`;
        if (isPair && pairToHubId[key]) return pairToHubId[key];
        if (!isPair && soloToHubId[key]) return soloToHubId[key];

        const hubId = isPair ? `union_${unionCounter++}` : `solo_${unionCounter++}`;
        const type = isPair ? (records[p1]?.data.UNION ? 'UNION_NODE' : 'IMPLICIT_NODE') : 'SOLO_NODE';
        if (isPair) pairToHubId[key] = hubId;
        else soloToHubId[key] = hubId;

        const p1Rank = ranks[p1] || 0;
        const hubRank = p1Rank + 1;

        elements.push({
            data: { id: hubId, type: type, elk: { 'org.eclipse.elk.layered.layerIndex': hubRank } }
        });
        elements.push({ data: { source: p1, target: hubId }, classes: 'spouse-edge' });
        if (isPair) elements.push({ data: { source: p2, target: hubId }, classes: 'spouse-edge' });
        
        return hubId;
    }

    // [Step 4] Process Unions
    for (const id of sortedNodeIds) {
        const rec = records[id];
        if (rec && rec.data.UNION) {
            rec.data.UNION.forEach(u => {
                const partnerId = u.parsed[0];
                if (!partnerId) return;
                ensurePlaceholderNode(partnerId);
                const [p1, p2] = [id, partnerId].sort();
                getHub(p1, p2);
            });
        }
    }

    // [Step 5] Process Lineage (Parent-Centric)
    for (const parentId of sortedNodeIds) {
        const children = parentToChildren.get(parentId);
        if (!children || children.length === 0) continue;

        const parentRec = records[parentId] || { data: {} }; // Mock for implicit

        // Creating a copy to reverse without mutating the map for other references
        const orderedChildren = [...children].reverse();

        orderedChildren.forEach(childId => {
            const childRec = records[childId];
            if (!childRec || !childRec.data.PARENT) return;

            const myParentTag = childRec.data.PARENT.find(p => p.parsed[0] === parentId);
            if (!myParentTag) return;

            const relationType = (myParentTag.parsed[1] || 'BIO').toUpperCase();
            const isBio = relationType === 'BIO';

            // Resolve Partner
            let partnerId = null;
            if (parentRec.data.UNION) {
                partnerId = parentRec.data.UNION.find(u => 
                    childRec.data.PARENT.some(p => p.parsed[0] === u.parsed[0])
                )?.parsed[0];
            }

            // Get Hub
            const p1 = parentId;
            const p2 = partnerId;
            let hubId;
            if (p2) {
                const parents = [p1, p2].sort();
                hubId = getHub(parents[0], parents[1]);
            } else {
                hubId = getHub(p1, null);
            }

            const edgeKey = `${hubId}->${childId}`;
            if (!createdLineageEdges.has(edgeKey)) {
                createdLineageEdges.add(edgeKey);
                elements.push({
                    data: { source: hubId, target: childId, edgeType: relationType },
                    classes: isBio ? 'lineage-edge' : 'non-bio-edge'
                });
            }
        });
    }

    // [Step 6] Process Associates
    for (const id of sortedNodeIds) {
        const rec = records[id];
        if (rec && rec.data.ASSOC) {
            rec.data.ASSOC.forEach(assoc => {
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || 'ASSOC';
                if (!targetId) return;
                ensurePlaceholderNode(targetId);
                elements.push({
                    data: { source: id, target: targetId, label: role },
                    classes: 'assoc-edge'
                });
            });
        }
    }

    return elements;
}
