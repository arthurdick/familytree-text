import cytoscape from 'cytoscape';
import elk from 'cytoscape-elk';
import FTTParser from '../FTTParser.js';

cytoscape.use(elk);

// Initialize Parser
const parser = new FTTParser();

/**
 * Helper: Calculate generations to enforce cleaner layering.
 * Uses a simple top-down traversal from root candidates.
 */
function calculateGenerations(elements, records) {
    const idToGen = {};
    const queue = [];
    const visited = new Set();

    // 1. Identify Roots (Nodes with no PARENTs)
    Object.values(records).forEach(rec => {
        if (rec.type === 'INDIVIDUAL' && (!rec.data.PARENT || rec.data.PARENT.length === 0)) {
            idToGen[rec.id] = 0;
            queue.push({
                id: rec.id,
                gen: 0
            });
            visited.add(rec.id);
        }
    });

    // 2. BFS to assign generations
    while (queue.length > 0) {
        const current = queue.shift();

        // Check unions (Same generation)
        const record = records[current.id];
        if (record && record.data.UNION) {
            record.data.UNION.forEach(u => {
                const spouseId = u.parsed[0];
                if (spouseId && !visited.has(spouseId)) {
                    idToGen[spouseId] = current.gen;
                    visited.add(spouseId);
                    queue.push({
                        id: spouseId,
                        gen: current.gen
                    });
                }
            });
        }

        // Check children (Next generation)
        // Note: In FTT, children point to parents. We have to reverse lookup or check explicit CHILD lists if available.
        // Since we built 'elements', we can scan edges efficiently.
    }

    // Refinement: Scan Cytoscape edges to propagate generations down from Parents to Union Hubs to Children
    // This is a simplified pass; ELK handles topological sorting well, but explicit tiers help.
    // We will return a map to be used in 'layoutOptions'.
    return idToGen;
}

function convertToCytoscape(parsedData) {
    const elements = [];
    const records = parsedData.records;
    const createdNodeIds = new Set();
    let unionCounter = 0;

    // Tracking Hubs
    const pairToHubId = {};
    const soloToHubId = {};

    // --- Helper: Node Creation ---
    function addNode(id, label, subLabel, type) {
        if (createdNodeIds.has(id)) return;
        elements.push({
            data: {
                id,
                label,
                subLabel,
                type
            }
        });
        createdNodeIds.add(id);
    }

    function ensurePlaceholderNode(id) {
        if (id && id.startsWith('?') && !createdNodeIds.has(id)) {
            addNode(id, id, '(Placeholder)', 'PLACEHOLDER');
        }
    }

    // --- Step 1: Create Nodes ---
    for (const [id, rec] of Object.entries(records)) {
        if (rec.type === 'SOURCE' || rec.type === 'EVENT') continue;

        let label = id;
        let subLabel = "";

        if (rec.type === 'INDIVIDUAL' || rec.type === 'PLACEHOLDER') {
            if (rec.data.NAME && rec.data.NAME.length > 0) {
                label = rec.data.NAME[0].parsed[0] || id; // Display Name
                const prefName = rec.data.NAME.find(n => n.parsed[3] === 'PREF');
                if (prefName) label = prefName.parsed[0];
            }
            if (rec.data.BORN && rec.data.BORN[0].parsed[0]) {
                subLabel = rec.data.BORN[0].parsed[0]; // Birth Date
            }
        }
        addNode(id, label, subLabel, rec.type);
    }

    // --- Helper: Get/Create Hub ---
    function getHub(p1, p2) {
        const isPair = !!p2;
        const key = isPair ? `${p1}+${p2}` : `${p1}+BIO`;

        if (isPair && pairToHubId[key]) return pairToHubId[key];
        if (!isPair && soloToHubId[key]) return soloToHubId[key];

        const hubId = isPair ? `union_${unionCounter++}` : `solo_${unionCounter++}`;
        const type = isPair ? (records[p1]?.data.UNION ? 'UNION_NODE' : 'IMPLICIT_NODE') : 'SOLO_NODE';

        if (isPair) pairToHubId[key] = hubId;
        else soloToHubId[key] = hubId;

        elements.push({
            data: {
                id: hubId,
                type: type
            }
        });

        // Create Edges from Parents -> Hub
        elements.push({
            data: {
                source: p1,
                target: hubId
            },
            classes: 'spouse-edge'
        });
        if (isPair) {
            elements.push({
                data: {
                    source: p2,
                    target: hubId
                },
                classes: 'spouse-edge'
            });
        }

        return hubId;
    }

    // --- Step 2: Explicit Unions (Hubs without Children yet) ---
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

    // --- Step 3: Child Lineage (Bio vs Non-Bio) ---
    for (const [childId, rec] of Object.entries(records)) {
        if (!rec.data.PARENT) continue;

        const bioParents = [];
        const otherParents = [];

        // Sort parents into Bio vs Others
        rec.data.PARENT.forEach(p => {
            const pId = p.parsed[0];
            const pType = (p.parsed[1] || 'BIO').toUpperCase();

            ensurePlaceholderNode(pId);

            if (pType === 'BIO') {
                bioParents.push(pId);
            } else {
                otherParents.push({
                    id: pId,
                    type: pType
                });
            }
        });

        // A. Handle Biological Lineage (Via Hub)
        if (bioParents.length > 0) {
            bioParents.sort();
            const hubId = (bioParents.length >= 2) ?
                getHub(bioParents[0], bioParents[1]) :
                getHub(bioParents[0], null);

            elements.push({
                data: {
                    source: hubId,
                    target: childId
                },
                classes: 'lineage-edge'
            });
        }

        // B. Handle Non-Biological Lineage (Direct Edge)
        otherParents.forEach(op => {
            elements.push({
                data: {
                    source: op.id,
                    target: childId,
                    edgeType: op.type
                },
                classes: 'non-bio-edge'
            });
        });
    }

    // --- Step 4: Associations ---
    for (const [id, rec] of Object.entries(records)) {
        if (rec.data.ASSOC) {
            rec.data.ASSOC.forEach(assoc => {
                // Parse Structure: ID | ROLE | START | END | DETAILS
                const targetId = assoc.parsed[0];
                const role = assoc.parsed[1] || 'ASSOC';

                if (!targetId) return;

                // Ensure the associate exists in the graph (even if just a placeholder)
                ensurePlaceholderNode(targetId);

                elements.push({
                    data: {
                        source: id,
                        target: targetId,
                        label: role
                    },
                    classes: 'assoc-edge' // Matches existing CSS in index.html
                });
            });
        }
    }

    return elements;
}

document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('editor');
    const btnRender = document.getElementById('btn-render');
    const btnExport = document.getElementById('btn-export');
    const errorBox = document.getElementById('error-box');

    const cy = cytoscape({
        container: document.getElementById('cy'),
        style: [
            // -------------------------------------------------------------------------
            // 1. Base Node Styles
            // -------------------------------------------------------------------------
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'color': '#333',
                    'font-size': '12px',
                    'font-weight': 'bold',
                    'width': (ele) => {
                        const label = ele.data('label') || '';
                        const lines = label.split('\n');
                        const maxLen = Math.max(...lines.map(l => l.length));
                        // Approx: 9px per char + 24px padding buffer
                        return (maxLen * 9) + 24; 
                    },
                    'height': (ele) => {
                        const label = ele.data('label') || '';
                        const lines = label.split('\n');
                        // Approx: 20px per line + 20px padding buffer
                        return (lines.length * 20) + 20; 
                    },
                    'padding': '12px',
                    'background-color': '#fff',
                    'border-width': 2,
                    'border-color': '#555',
                    'shape': 'round-rectangle'
                }
            },

            // -------------------------------------------------------------------------
            // 2. Entity Types
            // -------------------------------------------------------------------------
            {
                selector: 'node[type="INDIVIDUAL"]',
                style: {
                    'background-color': '#e7f5ff',
                    'border-color': '#1c7ed6',
                    'text-wrap': 'wrap',
                    'label': (n) => n.data('label') + (n.data('subLabel') ? '\n' + n.data('subLabel') : '')
                }
            },
            {
                selector: 'node[type="PLACEHOLDER"]',
                style: {
                    'background-color': '#f8f9fa',
                    'border-color': '#adb5bd',
                    'border-style': 'dashed',
                    'text-wrap': 'wrap',
                    'label': (n) => n.data('label')
                }
            },

            // -------------------------------------------------------------------------
            // 3. Topology Hubs (Internal Nodes)
            // -------------------------------------------------------------------------
            {
                // Shared Union Hub (Purple Diamond)
                selector: 'node[type="UNION_NODE"]',
                style: {
                    'width': 10,
                    'height': 10,
                    'background-color': '#cc5de8',
                    'border-width': 0,
                    'shape': 'diamond',
                    'label': ''
                }
            },
            {
                // Implicit/Solo Hub (Small Grey Dot)
                selector: 'node[type="IMPLICIT_NODE"]',
                style: {
                    'width': 6,
                    'height': 6,
                    'background-color': '#868e96',
                    'border-width': 0,
                    'shape': 'ellipse',
                    'label': ''
                }
            },
            {
                // Solo Parent Hub (Base Shape)
                selector: 'node[type="SOLO_NODE"]',
                style: {
                    'width': 16,
                    'height': 16,
                    'background-color': '#fff',
                    'border-width': 1,
                    'border-color': '#20c997',
                    'shape': 'ellipse',
                    'label': '' // Default to empty string to satisfy mapper
                }
            },
            {
                // Solo Parent Hub (Label - Only if data exists)
                selector: 'node[type="SOLO_NODE"][label]',
                style: {
                    'label': 'data(label)',
                    'font-size': '6px',
                    'color': '#20c997'
                }
            },

            // -------------------------------------------------------------------------
            // 4. Base Edge Styles
            // -------------------------------------------------------------------------
            {
                selector: 'edge',
                style: {
                    'curve-style': 'bezier',
                    'arrow-scale': 0.8,
                    'width': 1
                }
            },

            // -------------------------------------------------------------------------
            // 5. Lineage & Relationship Edges
            // -------------------------------------------------------------------------

            // A. Spouse / Union Input (Parents -> Hub)
            {
                selector: '.spouse-edge',
                style: {
                    'width': 1,
                    'line-color': '#adb5bd',
                    'curve-style': 'bezier',
                    'target-arrow-shape': 'none'
                }
            },

            // B. Biological Lineage (Hub -> Child)
            {
                selector: '.lineage-edge',
                style: {
                    'width': 2,
                    'line-color': '#495057',
                    'curve-style': 'taxi',
                    'taxi-direction': 'vertical',
                    'target-arrow-shape': 'triangle',
                    'target-arrow-color': '#495057'
                }
            },

            // C. Non-Biological Lineage (Parent -> Child Direct)
            {
                selector: '.non-bio-edge',
                style: {
                    'width': 2,
                    'curve-style': 'bezier',
                    'target-arrow-shape': 'triangle',
                    'label': 'data(edgeType)', // Displays "ADO", "STE", etc.
                    'font-size': '9px',
                    'text-background-opacity': 1,
                    'text-background-color': '#fff',
                    'text-background-padding': '2px'
                }
            },

            // D. Specific Non-Bio Styles
            {
                selector: 'edge[edgeType="ADO"]',
                style: {
                    'line-color': '#20c997',
                    'target-arrow-color': '#20c997',
                    'line-style': 'dashed'
                }
            },
            {
                selector: 'edge[edgeType="STE"]',
                style: {
                    'line-color': '#fd7e14',
                    'target-arrow-color': '#fd7e14',
                    'line-style': 'dotted'
                }
            },
            {
                selector: 'edge[edgeType="FOS"]',
                style: {
                    'line-color': '#be4bdb',
                    'target-arrow-color': '#be4bdb',
                    'line-style': 'dashed',
                    'line-dash-pattern': [6, 3]
                }
            },

            // -------------------------------------------------------------------------
            // 6. Associates (Optional)
            // -------------------------------------------------------------------------
            {
                selector: '.assoc-edge',
                style: {
                    'width': 1.5,
                    'line-color': '#fab005',
                    'line-style': 'dotted',
                    'curve-style': 'bezier',
                    'target-arrow-shape': 'none',
                    'label': 'data(label)',
                    'font-size': '10px',
                    'color': '#d08800',
                    'text-background-opacity': 1,
                    'text-background-color': '#fff'
                }
            }
        ]
    });

    function render() {
        const result = parser.parse(editor.value);

        // Error Display
        if (result.errors.length > 0) {
            errorBox.style.display = 'block';
            errorBox.textContent = ''; // Clear previous errors

            const strong = document.createElement('strong');
            strong.textContent = 'Errors:';
            errorBox.appendChild(strong);
            
            result.errors.forEach(err => {
                errorBox.appendChild(document.createElement('br'));
                errorBox.appendChild(document.createTextNode(err));
            });
        } else {
            errorBox.style.display = 'none';
            errorBox.textContent = '';
        }

        const cyElements = convertToCytoscape(result);
        cy.elements().remove();
        cy.add(cyElements);

        // --- ELK Layout Configuration ---
        cy.layout({
            name: 'elk',
            elk: {
                // Core Algorithm: 'layered' is best for hierarchies/genealogies
                algorithm: 'layered',

                // Direction: Top-to-Bottom
                'elk.direction': 'DOWN',

                // Separation settings to prevent clutter
                'elk.spacing.nodeNode': 50, // Horizontal space between siblings
                'elk.layered.spacing.nodeNodeBetweenLayers': 80, // Vertical space between generations

                // Strategy: LONG_PATH or BRANDES_KOEPF often works well for trees
                'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',

                // Edges: Orthogonal routing for clean "circuit board" look
                'elk.edgeRouting': 'ORTHOGONAL',
            }
        }).run();
    }

    function exportImage() {
        const pngBlob = cy.png({
            full: true,
            output: 'blob',
            bg: 'white',
            scale: 2
        });
        const url = URL.createObjectURL(pngBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'family_tree.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    btnRender.addEventListener('click', render);
    btnExport.addEventListener('click', exportImage);

    if (typeof FTTParser !== 'undefined') render();
});
