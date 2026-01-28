import cytoscape from 'cytoscape';
import elk from 'cytoscape-elk';

// Register the ELK layout extension
cytoscape.use(elk);

const STORAGE_KEY = 'ftt_autosave_data';
const DEFAULT_TEMPLATE = `HEAD_FORMAT: FTT v0.1
HEAD_TITLE: Topology Test

ID: GRANDPA-01
NAME: Arthur Smith
BORN: 1920
UNION: GRANDMA-01 | MARR | 1945 ||

ID: GRANDMA-01
NAME: Mary Jones
BORN: 1922

ID: DAD-01
NAME: John Smith
BORN: 1950
PARENT: GRANDPA-01 | BIO ||
PARENT: GRANDMA-01 | BIO ||
UNION: MOM-01 | MARR | 1975 ||

ID: MOM-01
NAME: Sarah Doe
BORN: 1952

ID: SON-01
NAME: Junior Smith
BORN: 1980
PARENT: DAD-01 | BIO ||
PARENT: MOM-01 | BIO ||
EVENT: OCC | 2005 || Engineer`;

// --- Worker Setup ---
// Initialize the Web Worker to handle parsing and graph generation off the main thread
const worker = new Worker(new URL('../src/worker.js', import.meta.url), { type: 'module' });

// Helper: Escape Regex special characters
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const editor = document.getElementById('editor');
    const btnRender = document.getElementById('btn-render');
    const errorBox = document.getElementById('error-box');
    
    // File Menu Elements
    const btnFileMenu = document.getElementById('btn-file-menu');
    const fileMenuContent = document.getElementById('file-menu-content');
    const btnNew = document.createElement('button'); // Created dynamically
    const btnOpen = document.getElementById('btn-open');
    const btnSave = document.getElementById('btn-save');
    const btnExportPng = document.getElementById('btn-export-png');
    const fileInput = document.getElementById('file-input');

    // Add New File Button to DOM
    btnNew.textContent = "New File (Reset)";
    btnNew.id = "btn-new";
    fileMenuContent.insertBefore(btnNew, fileMenuContent.firstChild);

    let cachedLineHeight = 20; // Safe fallback

    function updateLineHeight() {
        const computedStyle = window.getComputedStyle(editor);
        const lhStr = computedStyle.lineHeight;
        
        // Use explicit pixel value if available
        if (lhStr.endsWith('px')) {
            cachedLineHeight = parseFloat(lhStr);
            return;
        }

        // Measure strictly if 'normal' or unitless
        const tempSpan = document.createElement('span');
        tempSpan.style.fontFamily = computedStyle.fontFamily;
        tempSpan.style.fontSize = computedStyle.fontSize;
        tempSpan.style.lineHeight = lhStr;
        tempSpan.style.whiteSpace = 'pre';
        tempSpan.style.visibility = 'hidden';
        tempSpan.style.position = 'absolute';
        tempSpan.textContent = 'Mg'; // Mixed ascenders/descenders

        document.body.appendChild(tempSpan);
        cachedLineHeight = tempSpan.offsetHeight;
        document.body.removeChild(tempSpan);
    }

    // Initialize & Listen for Resize
    updateLineHeight();
    window.addEventListener('resize', () => {
        updateLineHeight();
    });

    const cy = cytoscape({
        container: document.getElementById('cy'),
        style: [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'text-valign': 'center', 'text-halign': 'center',
                    'color': '#333', 'font-size': '12px', 'font-weight': 'bold',
                    'width': (ele) => {
                        const label = ele.data('label') || '';
                        const lines = label.split('\n');
                        const maxLen = Math.max(...lines.map(l => l.length));
                        return (maxLen * 9) + 24; 
                    },
                    'height': (ele) => {
                        const label = ele.data('label') || '';
                        const lines = label.split('\n');
                        return (lines.length * 20) + 20; 
                    },
                    'padding': '12px', 'background-color': '#fff',
                    'border-width': 2, 'border-color': '#555',
                    'shape': 'round-rectangle'
                }
            },
            {
                selector: 'node[type="INDIVIDUAL"]',
                style: { 'background-color': '#e7f5ff', 'border-color': '#1c7ed6', 'text-wrap': 'wrap', 'label': (n) => n.data('label') + (n.data('subLabel') ? '\n' + n.data('subLabel') : '') }
            },
            {
                selector: 'node[type="PLACEHOLDER"]',
                style: { 'background-color': '#f8f9fa', 'border-color': '#adb5bd', 'border-style': 'dashed', 'text-wrap': 'wrap', 'label': (n) => n.data('label') }
            },
            {
                selector: '.current-record',
                style: { 'border-color': '#fd7e14', 'border-width': 4, 'background-color': '#fff4e6', 'shadow-blur': 10, 'shadow-color': '#fd7e14', 'transition-property': 'border-width, border-color, background-color', 'transition-duration': '0.2s' }
            },
            {
                selector: 'node[type="UNION_NODE"]',
                style: { 'width': 10, 'height': 10, 'background-color': '#cc5de8', 'border-width': 0, 'shape': 'diamond', 'label': '' }
            },
            {
                selector: 'node[type="IMPLICIT_NODE"]',
                style: { 'width': 6, 'height': 6, 'background-color': '#868e96', 'border-width': 0, 'shape': 'ellipse', 'label': '' }
            },
            {
                selector: 'node[type="SOLO_NODE"]',
                style: { 'width': 16, 'height': 16, 'background-color': '#fff', 'border-width': 1, 'border-color': '#20c997', 'shape': 'ellipse', 'label': '' }
            },
            { selector: 'node[type="SOLO_NODE"][label]', style: { 'label': 'data(label)', 'font-size': '6px', 'color': '#20c997' } },
            { selector: 'edge', style: { 'curve-style': 'bezier', 'arrow-scale': 0.8, 'width': 1 } },
            { selector: '.spouse-edge', style: { 'width': 1, 'line-color': '#adb5bd', 'curve-style': 'bezier', 'target-arrow-shape': 'none' } },
            { selector: '.lineage-edge', style: { 'width': 2, 'line-color': '#495057', 'curve-style': 'taxi', 'taxi-direction': 'vertical', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#495057' } },
            { selector: '.non-bio-edge', style: { 'width': 2, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'label': 'data(edgeType)', 'font-size': '9px', 'text-background-opacity': 1, 'text-background-color': '#fff', 'text-background-padding': '2px' } },
            { selector: 'edge[edgeType="ADO"]', style: { 'line-color': '#20c997', 'target-arrow-color': '#20c997', 'line-style': 'dashed' } },
            { selector: 'edge[edgeType="STE"]', style: { 'line-color': '#fd7e14', 'target-arrow-color': '#fd7e14', 'line-style': 'dotted' } },
            { selector: 'edge[edgeType="FOS"]', style: { 'line-color': '#be4bdb', 'target-arrow-color': '#be4bdb', 'line-style': 'dashed', 'line-dash-pattern': [6, 3] } },
            { selector: '.assoc-edge', style: { 'width': 1.5, 'line-color': '#fab005', 'line-style': 'dotted', 'curve-style': 'bezier', 'target-arrow-shape': 'none', 'label': 'data(label)', 'font-size': '10px', 'color': '#d08800', 'text-background-opacity': 1, 'text-background-color': '#fff' } }
        ]
    });

    // --- Persistence Logic ---

    // Load from storage or use default
    function loadInitialContent() {
        const savedData = localStorage.getItem(STORAGE_KEY);
        if (savedData) {
            editor.value = savedData;
        } else {
            editor.value = DEFAULT_TEMPLATE;
        }
    }

    // Save to storage
    function saveContent() {
        localStorage.setItem(STORAGE_KEY, editor.value);
    }

    // --- Jump to Line Helper ---
    function jumpToLine(lineNum) {
        if (!lineNum || lineNum < 1) return;
        const text = editor.value;
        const lines = text.split('\n');
        
        let charIndex = 0;
        for (let i = 0; i < lineNum - 1; i++) {
            if (i < lines.length) {
                charIndex += lines[i].length + 1;
                // +1 for newline character
            }
        }

        editor.focus();
        editor.setSelectionRange(charIndex, charIndex);
        
        // Center the line in view
        const scrollPos = (lineNum - 5) * cachedLineHeight;
        editor.scrollTop = scrollPos > 0 ? scrollPos : 0;
    }

    // --- Worker Response Handler ---
    worker.onmessage = (e) => {
        const { type, payload } = e.data;

        if (type === 'CRITICAL_ERROR') {
            const div = document.createElement('div');
            div.className = 'msg-critical';
            div.textContent = `Critical Render Error: ${payload.message}`;
            errorBox.appendChild(div);
            errorBox.style.display = 'block';
            return;
        }

        if (type === 'SUCCESS') {
            const { elements, errors, warnings } = payload;
            
            // 1. Update UI Validation
            const hasErrors = errors && errors.length > 0;
            const hasWarnings = warnings && warnings.length > 0;

            if (hasErrors || hasWarnings) {
                errorBox.style.display = 'block';
                errorBox.innerHTML = ''; 

                const createMessageRow = (item, type) => {
                    const div = document.createElement('div');
                    div.className = `msg-row ${type === 'ERROR' ? 'error' : 'warning'}`;

                    const spanLine = document.createElement('span');
                    spanLine.className = 'msg-line';
                    spanLine.textContent = `L${item.line}`;

                    const spanCode = document.createElement('span');
                    spanCode.className = 'msg-code';
                    spanCode.textContent = `[${item.code}]`;

                    const spanText = document.createElement('span');
                    spanText.className = 'msg-text';
                    spanText.textContent = item.message;

                    div.appendChild(spanLine);
                    div.appendChild(spanCode);
                    div.appendChild(spanText);
                    div.addEventListener('click', () => jumpToLine(item.line));
                    return div;
                };

                // Add Header
                const header = document.createElement('div');
                header.className = 'msg-header';
                header.textContent = `Analysis: ${errors.length} Error(s), ${warnings.length} Warning(s)`;
                errorBox.appendChild(header);

                // Append Messages (Errors first, then Warnings)
                if (errors) errors.forEach(err => errorBox.appendChild(createMessageRow(err, 'ERROR')));
                if (warnings) warnings.forEach(warn => errorBox.appendChild(createMessageRow(warn, 'WARNING')));
                
            } else {
                errorBox.style.display = 'none';
                errorBox.innerHTML = '';
            }

            // 2. Load Elements into Cytoscape & Run Layout
            try {
                cy.elements().remove();
                cy.add(elements);
                cy.layout({
                    name: 'elk',
                    elk: {
                        algorithm: 'layered', 'elk.direction': 'DOWN', 'elk.spacing.nodeNode': 50,
                        'elk.layered.spacing.nodeNodeBetweenLayers': 80,
                        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.edgeRouting': 'ORTHOGONAL',
                        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
                    }
                }).run();
            } catch (err) {
                console.error("Layout Error:", err);
            }
        }
    };

    // --- Async Render Trigger ---
    function render() {
        // Post the editor content to the worker. 
        // The worker will parse, calc ranks, generate graph elements, and return them.
        worker.postMessage({ fttContent: editor.value });
    }

    // --- File Handlers ---

    // 0. New File (Reset)
    btnNew.addEventListener('click', () => {
        fileMenuContent.classList.remove('show');
        if (confirm("Are you sure you want to clear the editor? This will erase unsaved changes.")) {
            editor.value = DEFAULT_TEMPLATE;
            saveContent(); // Force update storage
            render();
        }
    });

    // 1. Open File
    btnOpen.addEventListener('click', () => {
        fileMenuContent.classList.remove('show');
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            editor.value = e.target.result;
            saveContent(); // Update storage
            render(); // Auto-render on load
        };
        reader.readAsText(file);
        // Reset input so same file can be selected again if needed
        fileInput.value = ''; 
    });

    // 2. Save File (.ftt)
    btnSave.addEventListener('click', () => {
        fileMenuContent.classList.remove('show');
        const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'family_tree.ftt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // 3. Export Image (.png)
    btnExportPng.addEventListener('click', () => {
        fileMenuContent.classList.remove('show');
        const pngBlob = cy.png({ full: true, output: 'blob', bg: 'white', scale: 2 });
        const url = URL.createObjectURL(pngBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'family_tree.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    // --- UI Interactions ---

    // Toggle Dropdown
    btnFileMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        fileMenuContent.classList.toggle('show');
    });

    // Close Dropdown on click outside
    window.addEventListener('click', (e) => {
        if (!e.target.matches('#btn-file-menu')) {
            if (fileMenuContent.classList.contains('show')) {
                fileMenuContent.classList.remove('show');
            }
        }
    });

    // Shortcut: Ctrl+Enter / Cmd+Enter to Render
    editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            render();
            // Optional visual feedback
            btnRender.style.transform = "scale(0.95)";
            setTimeout(() => btnRender.style.transform = "", 100);
        }
    });

    // Sync: Graph -> Editor
    cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        const id = node.id();
        if (['UNION_NODE', 'IMPLICIT_NODE', 'SOLO_NODE'].includes(node.data('type'))) return;
        
        const text = editor.value;
        const escapedId = escapeRegExp(id);
        const regex = new RegExp(`^ID:\\s*${escapedId}\\s*$`, 'm');
        const match = text.match(regex);

        if (match) {
            const index = match.index;
            const lineNum = text.substring(0, index).split('\n').length;

            editor.focus();
            editor.setSelectionRange(index, index + match[0].length);
            
            // Scroll so the line is roughly vertically centered (minus 3 lines padding)
            editor.scrollTop = (lineNum - 3) * cachedLineHeight;
            
            // Force sync immediately so highlight appears even if editor was blurred
            syncGraphToCursor();
        }
    });

    // Sync: Editor -> Graph
    function syncGraphToCursor() {
        const cursorIndex = editor.selectionStart;
        const text = editor.value;
        const textBeforeCursor = text.substring(0, cursorIndex);
        
        // Find current line index (0-based)
        const lineCount = textBeforeCursor.split('\n').length;
        const allLines = text.split('\n');
        
        let foundId = null;

        // Iterate backwards from current line to find the nearest ID
        for (let i = lineCount - 1; i >= 0; i--) {
            const line = allLines[i];
            // If we hit a block separator, we stop looking up.
            if (line.startsWith('---')) {
                break;
            }

            const match = line.match(/^ID:\s*([^\s]+)/);
            if (match) {
                foundId = match[1];
                break;
            }
        }

        cy.nodes().removeClass('current-record');
        if (foundId) {
            const targetNode = cy.getElementById(foundId);
            if (targetNode.length > 0) targetNode.addClass('current-record');
        }
    }

    // Auto-Save / Cursor Sync Debouncer
    let timeout;
    editor.addEventListener('keyup', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            syncGraphToCursor();
            saveContent(); // Save on keyup
        }, 200);
    });

    // Also sync/save on click
    editor.addEventListener('mouseup', () => {
        syncGraphToCursor();
        saveContent();
    });

    // Clear highlight when focus is lost (clicking outside)
    editor.addEventListener('blur', () => {
        cy.nodes().removeClass('current-record');
    });

    // Restore highlight when focus is regained
    editor.addEventListener('focus', () => {
        syncGraphToCursor();
    });

    btnRender.addEventListener('click', render);

    // Initial Load
    loadInitialContent();
    render();
});
