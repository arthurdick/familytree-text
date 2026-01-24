import FTTParser from '../../implementations/js/FTTParser.js';

const parser = new FTTParser();

// Listen for messages from the main thread
self.onmessage = (e) => {
    const { fttContent } = e.data;

    try {
        // 1. Heavy Lift: Parse
        const result = parser.parse(fttContent);

        // 2. Heavy Lift: Calculate Ranks (Generations)
        const ranks = calculateGenerations(result.records);

        // 3. Heavy Lift: Generate Cytoscape Elements
        const elements = convertToCytoscape(result, ranks);

        // Send back the prepared data
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

/**
 * ============================================================
 * Logic Moved from visualizer.js
 * ============================================================
 */

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

function convertToCytoscape(parsedData, ranks) {
    const elements = [];
    const records = parsedData.records;
    const createdNodeIds = new Set();
    let unionCounter = 0;
    const pairToHubId = {};
    const soloToHubId = {};

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
        if (id && id.startsWith('?') && !createdNodeIds.has(id)) {
            addNode(id, id, '(Placeholder)', 'PLACEHOLDER');
        }
    }

    for (const [id, rec] of Object.entries(records)) {
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
            data: {
                id: hubId, type: type,
                elk: { 'org.eclipse.elk.layered.layerIndex': hubRank }
            }
        });

        elements.push({ data: { source: p1, target: hubId }, classes: 'spouse-edge' });
        if (isPair) {
            elements.push({ data: { source: p2, target: hubId }, classes: 'spouse-edge' });
        }
        return hubId;
    }

    // Process Unions
    for (const [id, rec] of Object.entries(records)) {
        if (rec.data.UNION) {
            rec.data.UNION.forEach(u => {
                const partnerId = u.parsed[0];
                if (!partnerId) return;
                ensurePlaceholderNode(partnerId);
                const [p1, p2] = [id, partnerId].sort();
                getHub(p1, p2);
            });
        }
    }

    // Process Lineage (Parents)
    for (const [childId, rec] of Object.entries(records)) {
        if (!rec.data.PARENT) continue;

        const relationshipGroups = new Map();
        rec.data.PARENT.forEach(p => {
            const pId = p.parsed[0];
            const pType = (p.parsed[1] || 'BIO').toUpperCase();
            if (!pId) return;
            ensurePlaceholderNode(pId);

            let partnerId = null;
            const parentRec = records[pId];
            if (parentRec && parentRec.data.UNION) {
                partnerId = parentRec.data.UNION.find(u => 
                    rec.data.PARENT.some(p2 => p2.parsed[0] === u.parsed[0])
                )?.parsed[0];
            }

            const groupKey = partnerId ? [pId, partnerId].sort().join('+') : pId;
            if (!relationshipGroups.has(groupKey)) {
                relationshipGroups.set(groupKey, { 
                    parents: partnerId ? [pId, partnerId].sort() : [pId], 
                    types: new Set() 
                });
            }
            relationshipGroups.get(groupKey).types.add(pType);
        });

        relationshipGroups.forEach((group) => {
            const isPair = group.parents.length === 2;
            const hubId = isPair ? 
                getHub(group.parents[0], group.parents[1]) : 
                getHub(group.parents[0], null);
            
            const isBio = group.types.has('BIO');
            const primaryType = isBio ? 'BIO' : [...group.types][0];

            elements.push({
                data: { source: hubId, target: childId, edgeType: primaryType },
                classes: isBio ? 'lineage-edge' : 'non-bio-edge'
            });
        });
    }

    // Process Associates
    for (const [id, rec] of Object.entries(records)) {
        if (rec.data.ASSOC) {
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
