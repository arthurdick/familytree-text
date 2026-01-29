import FTTParser from "../../implementations/js/FTTParser.js";
import {
    RelationshipCalculator,
    RelationText,
    getDisplayName,
    getGender
} from "../../implementations/js/RelationshipCalculator.js";

document.addEventListener("DOMContentLoaded", () => {
    const btnCalc = document.getElementById("btn-calc");
    const txtSource = document.getElementById("ftt-source");
    const inpId1 = document.getElementById("id1");
    const inpId2 = document.getElementById("id2");
    const resultBox = document.getElementById("result-box");

    const btnOpenFile = document.getElementById("btn-open-file");
    const fileInput = document.getElementById("file-input");

    const showError = (message) => {
        resultBox.textContent = "";
        const span = document.createElement("span");
        span.className = "error";
        span.textContent = message;
        resultBox.appendChild(span);
    };

    btnOpenFile.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            txtSource.value = e.target.result;
            resultBox.innerHTML =
                '<span style="color:#ccc;">File loaded. Enter IDs to calculate.</span>';
        };
        reader.readAsText(file);
        fileInput.value = "";
    });

    btnCalc.addEventListener("click", () => {
        const source = txtSource.value;
        const id1 = inpId1.value.trim();
        const id2 = inpId2.value.trim();

        if (!source || !id1 || !id2) {
            showError("Please provide FTT data and both IDs.");
            return;
        }

        try {
            const parser = new FTTParser();
            const parseResult = parser.parse(source);

            if (parseResult.errors.length > 0) {
                showError(`Parse Error: ${parseResult.errors[0]}`);
                return;
            }

            const records = parseResult.records;
            if (!records[id1]) throw new Error(`ID "${id1}" not found.`);
            if (!records[id2]) throw new Error(`ID "${id2}" not found.`);

            const calculator = new RelationshipCalculator(records);
            const relationships = calculator.calculate(id1, id2);

            renderResult(relationships, records, id1, id2);
        } catch (e) {
            showError(e.message);
            console.error(e);
        }
    });
});

// ==========================================
// Rendering & Terminology (Composite)
// ==========================================

function renderResult(relationships, records, idA, idB) {
    const nameA = getDisplayName(records[idA]);
    const nameB = getDisplayName(records[idB]);
    const genderA = getGender(records[idA]);

    const resultBox = document.getElementById("result-box");
    resultBox.textContent = "";

    const div1 = document.createElement("div");
    const strongA = document.createElement("strong");
    strongA.textContent = nameA;
    div1.appendChild(strongA);
    div1.appendChild(document.createTextNode(" is the"));
    resultBox.appendChild(div1);

    const textGen = new RelationText(records);

    if (relationships.length === 1 && relationships[0].type === "NONE") {
        const spanTerm = document.createElement("span");
        spanTerm.className = "relationship-term";
        spanTerm.textContent = "No Relation Found";
        spanTerm.style.color = "#999";
        spanTerm.style.fontSize = "1.5rem";
        resultBox.appendChild(spanTerm);
    } else {
        const terms = [];
        const details = [];

        relationships.forEach((rel) => {
            const { term, detail } = textGen.describe(rel, genderA, nameB, nameA);
            terms.push(term);
            if (detail) details.push(detail);
        });

        const spanTerm = document.createElement("span");
        spanTerm.className = "relationship-term";
        spanTerm.textContent = terms.join(" AND ");
        resultBox.appendChild(spanTerm);

        const div2 = document.createElement("div");
        div2.appendChild(document.createTextNode("of "));
        const strongB = document.createElement("strong");
        strongB.textContent = nameB;
        div2.appendChild(strongB);
        resultBox.appendChild(div2);

        if (details.length > 0) {
            const divDetail = document.createElement("div");
            divDetail.className = "path-detail";

            if (details.length > 1) {
                const ul = document.createElement("ul");
                details.forEach((detailText) => {
                    const li = document.createElement("li");

                    const lines = detailText.split("\n");
                    lines.forEach((line, index) => {
                        li.appendChild(document.createTextNode(line));
                        if (index < lines.length - 1) {
                            li.appendChild(document.createElement("br"));
                        }
                    });

                    ul.appendChild(li);
                });
                divDetail.appendChild(ul);
            } else {
                divDetail.textContent = details[0];
            }
            resultBox.appendChild(divDetail);
        }
    }
}
