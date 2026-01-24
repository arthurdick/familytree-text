import GedcomImporter from '../../implementations/js/GedcomImporter.js';
import GedcomExporter from '../../implementations/js/GedcomExporter.js';

const inputArea = document.getElementById('input-area');
const outputArea = document.getElementById('output-area');
const errorMsg = document.getElementById('error-msg');

function clearError() {
    errorMsg.textContent = '';
    outputArea.value = '';
}

// GEDCOM -> FTT
document.getElementById('btn-to-ftt').addEventListener('click', () => {
    clearError();
    const data = inputArea.value;
    if (!data.trim()) return;

    try {
        const bridge = new GedcomImporter();
        outputArea.value = bridge.convert(data);
    } catch (e) {
        errorMsg.textContent = "Conversion Error: " + e.message;
        console.error(e);
    }
});

// FTT -> GEDCOM
document.getElementById('btn-to-ged').addEventListener('click', () => {
    clearError();
    const data = inputArea.value;
    if (!data.trim()) return;

    try {
        const bridge = new GedcomExporter();
        outputArea.value = bridge.convert(data);
    } catch (e) {
        errorMsg.textContent = "Conversion Error: " + e.message;
        console.error(e);
    }
});
