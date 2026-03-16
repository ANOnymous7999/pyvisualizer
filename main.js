/**
 * main.js — Python Tutor + Manim combined execution visualizer
 * Features: execution arrow gutter, Frames panel, Heap panel, SVG arrows, GSAP animations
 */

// Use relative URL so it works both locally and on Render (e.g. https://your-app.onrender.com/execute)
const API = "/execute";

// ── State ─────────────────────────────────────────────────────────────────────
let steps = [], cur = -1, playTimer = null, editor = null, activeLineHandle = null;

// Track known frames/heap for diffing
const knownFrames = {};   // scopeKey -> {el, vars: {name -> {el, prevVal}}}
const knownHeapEls = {};   // refId -> heapEl

// ── DOM ───────────────────────────────────────────────────────────────────────
const D = id => document.getElementById(id);
const btnRun = D("btn-run"), btnClear = D("btn-clear"), stepCtr = D("step-ctr");
const btnFirst = D("pb-first"), btnPrev = D("pb-prev"), btnPlay = D("pb-play"), btnNext = D("pb-next");
const spdSlider = D("spd"), progFill = D("prog-fill");
const scopePill = D("scope-pill"), lineCode = D("line-code");
const framesPanel = D("frames-panel"), heapPanel = D("heap-panel");
const arrowSvg = D("arrow-svg"), idleEl = D("idle");
const vizRow = D("viz-row");
const vfsPanel = D("panel-vfs"), vfsContainer = D("vfs-container");
const outContent = D("out-content");
const errContent = D("err-content");
const mainLayout = D("main-layout");

// ── CodeMirror init ───────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    editor = CodeMirror(D("editor-wrap"), {
        value: defaultCode(),
        mode: "python",
        theme: "dracula",
        lineNumbers: true,
        gutters: ["exec-gutter", "CodeMirror-linenumbers"],
        indentUnit: 4, tabSize: 4, indentWithTabs: false,
        extraKeys: {
            "Tab": cm => cm.replaceSelection("    "),
            "Ctrl-Enter": handleRun,
        },
        autofocus: true,
    });
    setEnabled(false);
    document.addEventListener("keydown", onKey);

    // Define SVG arrowhead marker
    arrowSvg.innerHTML = `
    <defs>
      <marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <polygon points="0 0, 7 3.5, 0 7" fill="#6c8af7" opacity=".85"/>
      </marker>
    </defs>`;

    initResizer();
});

function defaultCode() {
    return `# Python Stack Implementation

def is_empty(stack):
    return len(stack) == 0

def push(stack, item):
    stack.append(item)
    print(f"Pushed: {item}")

def pop(stack):
    if is_empty(stack):
        print("Stack Underflow! Cannot pop.")
        return None
    else:
        return stack.pop()

def display(stack):
    if is_empty(stack):
        print("Stack is empty.")
    else:
        print("Stack elements (top to bottom):")
        for i in range(len(stack)-1, -1, -1):
            print(stack[i])

my_stack = []
push(my_stack, "Book1")
push(my_stack, "Book2")
push(my_stack, "Book3")
display(my_stack)

print(f"\\nPopped item: {pop(my_stack)}")
display(my_stack)
`;
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function handleRun() {
    if (btnRun.disabled) return;
    stopPlay();
    clearAll();
    setRunBusy(true);
    errContent.textContent = "";

    try {
        const res = await fetch(API, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: editor.getValue() }),
        });
        const data = await res.json();
        if (data.error) errContent.textContent = data.error;
        steps = data.steps || [];
        if (steps.length) {
            idleEl.style.display = "none";
            const pFrames = D("panel-frames"), pHeap = D("panel-heap");
            if (pFrames) pFrames.style.display = "flex";
            if (pHeap) pHeap.style.display = "flex";
            const vr = document.querySelector(".viz-resizer");
            if (vr) vr.style.display = "block";

            // Pre-check if VFS will be needed
            const hasVfs = steps.some(s => s.vfs && Object.keys(s.vfs).length > 0);
            if (vfsPanel) {
                vfsPanel.style.display = hasVfs ? "flex" : "none";
                const ptVfs = D("ptoggle-vfs");
                if (ptVfs) ptVfs.style.display = hasVfs ? "" : "none";
                const vfsResizer = document.querySelector(".vfs-resizer");
                if (vfsResizer) vfsResizer.style.display = hasVfs ? "block" : "none";
            }
            setEnabled(true);
            goTo(0);
        } else {
            idleEl.style.display = "flex";
            idleEl.querySelector("p").textContent = data.error ? "Fix the error above." : "No steps found.";
        }
    } catch (_) {
        errContent.textContent = "Cannot reach backend — is Flask running on port 5000?";
    }
    setRunBusy(false);
}

// ── Step rendering ────────────────────────────────────────────────────────────
function goTo(idx) {
    if (!steps.length) return;
    cur = Math.max(0, Math.min(idx, steps.length - 1));
    renderStep(steps[cur]);
    updateUI();
}

function renderStep(step) {
    if (!step) return;
    const { line, scope, line_text, locals, heap, vfs } = step;

    // Set dynamic step color based on progress to help visually differentiate steps
    const hue = (200 + (cur * 35)) % 360; // 200 (Blue) to 340 (Pink) range roughly
    document.documentElement.style.setProperty('--step-color', `hsl(${hue}, 90%, 65%)`);

    // 1. Execution arrow + line glow
    setExecArrow(line);

    // 2. Center scope pill and active code line
    renderLineStrip(scope, line_text);

    // 3. Frames panel
    renderFrames(scope, line, locals);

    // Get previous step data for diffing animations
    const prevStep = cur > 0 ? steps[cur - 1] : {};
    const prevHeap = prevStep.heap || {};
    const prevVfs = prevStep.vfs || {};

    // 4. Heap panel
    renderHeap(heap || {}, prevHeap);

    // 5. VFS panel
    renderVFS(vfs || {}, prevVfs);

    // 6. Terminal Output
    renderOutput(step.stdout || "");

    // 7. SVG arrows (after DOM settles)
    setTimeout(drawArrows, 10);
}

function renderOutput(fullText) {
    if (!fullText || !fullText.trim()) {
        outContent.innerHTML = "";
        return;
    }

    // Colorize the lines
    const lines = fullText.split("\n");
    const coloredHTML = lines.map(line => {
        if (!line.trim()) return "";
        let html = h(line);
        if (line.includes("Pushed:")) {
            html = html.replace(/Pushed: (.*)/, '<span class="out-push">Pushed:</span> <span class="out-val">$1</span>');
        } else if (line.includes("Popped item:")) {
            html = html.replace(/Popped item: (.*)/, '<span class="out-pop">Popped item:</span> <span class="out-val">$1</span>');
        } else if (line.includes("Stack elements")) {
            html = `<span class="out-stack">${html}</span>`;
        } else if (line.startsWith("Book")) {
            html = `<span class="out-val">  ${html}</span>`;
        } else if (line.includes("Loaded Data:") || line.includes("Loaded")) {
            html = `<span class="out-push">${html}</span>`;
        }
        return `<div>${html}</div>`;
    }).join("");

    outContent.innerHTML = coloredHTML;
    outContent.scrollTop = outContent.scrollHeight;
}



// ── Execution arrow ───────────────────────────────────────────────────────────
function setExecArrow(lineNo) {
    if (activeLineHandle !== null) {
        try {
            editor.removeLineClass(activeLineHandle, "wrap", "cm-exec-line");
            editor.setGutterMarker(activeLineHandle, "exec-gutter", null);
        } catch (_) { }
    }
    const cmL = lineNo - 1;
    const marker = document.createElement("div");
    marker.className = "exec-arrow-el";
    marker.textContent = "▶";
    editor.setGutterMarker(cmL, "exec-gutter", marker);
    activeLineHandle = editor.addLineClass(cmL, "wrap", "cm-exec-line");
    editor.scrollIntoView({ line: cmL, ch: 0 }, 60);
}

// ── Line strip ────────────────────────────────────────────────────────────────
function renderLineStrip(scope, lineText) {
    const isMod = scope === "<module>";
    scopePill.textContent = isMod ? "global" : `fn: ${scope}`;
    scopePill.className = `scope-pill ${isMod ? "sp-mod" : "sp-fn"}`;
    gsap.fromTo(lineCode, { opacity: 0, x: 8 }, {
        opacity: 1, x: 0, duration: .2, ease: "power2.out",
        onStart: () => { lineCode.textContent = lineText || ""; }
    });
}

// ── Frames panel ──────────────────────────────────────────────────────────────
function renderFrames(scope, lineNo, locals) {
    // Dim all frames, remove stale ones
    Object.keys(knownFrames).forEach(key => {
        if (key === scope) {
            knownFrames[key].el.classList.replace("dimmed", "active") || knownFrames[key].el.classList.add("active");
        } else {
            // If we're back to module and this is a function frame, remove it
            if (scope === "<module>" && key !== "<module>") {
                removeFrame(key);
            } else {
                knownFrames[key].el.classList.add("dimmed");
                knownFrames[key].el.classList.remove("active");
            }
        }
    });

    // Ensure frame exists
    if (!knownFrames[scope]) createFrame(scope);

    const frame = knownFrames[scope];
    if (!frame) return;

    // Update line number
    const lineEl = frame.el.querySelector(".frame-lineno");
    if (lineEl) lineEl.textContent = `L${lineNo}`;

    // Update variables
    updateFrameVars(scope, locals);
}

function createFrame(scopeKey) {
    const isMod = scopeKey === "<module>";
    const el = document.createElement("div");
    el.className = "c-frame active";
    el.dataset.scope = scopeKey;
    el.innerHTML = `
    <div class="frame-head">
      <span class="frame-name">${h(isMod ? "global" : scopeKey)}</span>
      <span class="frame-tag">${isMod ? "" : "frame"}</span>
      <span class="frame-lineno"></span>
    </div>
    <table class="var-table"><tbody class="var-tbody"></tbody></table>
  `;
    framesPanel.appendChild(el);
    knownFrames[scopeKey] = { el, vars: {} };
    el.style.opacity = "1";
    gsap.fromTo(el, { opacity: 0, y: 16 }, {
        opacity: 1, y: 0, duration: .4, ease: "power3.out",
        clearProps: "opacity,transform"
    });
}

function removeFrame(key) {
    const frame = knownFrames[key];
    if (!frame) return;
    gsap.to(frame.el, {
        opacity: 0, y: -10, duration: .3, ease: "power2.in",
        onComplete: () => { frame.el.remove(); }
    });
    delete knownFrames[key];
}

function updateFrameVars(scopeKey, locals) {
    const frame = knownFrames[scopeKey];
    if (!frame) return;
    const tbody = frame.el.querySelector(".var-tbody");
    const prev = frame.vars;
    const seen = new Set();

    locals.forEach(v => {
        seen.add(v.name);
        const existing = prev[v.name];
        const isNew = !existing;
        const didChange = existing && existing.lastVal !== v.value;

        if (isNew) {
            const tr = document.createElement("tr");
            tr.dataset.var = v.name;
            tr.innerHTML = `
        <td class="vt-name">${h(v.name)}</td>
        <td class="vt-type">${h(v.type)}</td>
        <td class="vt-val">${varValueHTML(v)}</td>
      `;
            tbody.appendChild(tr);
            const valTd = tr.querySelector(".vt-val");
            gsap.fromTo(tr, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: .3, ease: "power2.out" });
            // Flash green for new
            gsap.fromTo(valTd, { color: "#34d399" }, { color: "#f0f2ff", duration: .8, delay: .2, ease: "sine.inOut" });
            prev[v.name] = { lastVal: v.value, tr, valTd };
        } else if (didChange) {
            const { valTd } = existing;
            // Slide old out, new in
            gsap.timeline()
                .to(valTd, { y: -10, opacity: 0, duration: .15, ease: "power2.in" })
                .call(() => { valTd.innerHTML = varValueHTML(v); })
                .fromTo(valTd, { y: 10, opacity: 0, color: "#fbbf24" },
                    { y: 0, opacity: 1, color: "#f0f2ff", duration: .25, ease: "power2.out" });
            existing.lastVal = v.value;
        }
        // Update ref-id on the dot for arrow drawing
        if (!v.is_primitive) {
            const dot = body => body?.querySelector(`[data-ref="${h(v.name)}"]`);
            // ref-id stored as data attribute on the dot el
        }
    });

    // Remove vanished vars
    Object.keys(prev).forEach(name => {
        if (!seen.has(name)) {
            gsap.to(prev[name].tr, {
                opacity: 0, x: 6, duration: .2, ease: "power2.in",
                onComplete: () => prev[name].tr.remove()
            });
            delete prev[name];
        }
    });
}

function varValueHTML(v) {
    if (v.is_primitive) {
        return `<span class="val-prim">${h(v.value)}</span>`;
    }
    return `<span class="ref-ptr" data-ref-var="${h(v.name)}" data-ref-id="${h(v.ref_id)}">
    <span class="ref-dot" data-dot-id="${h(v.ref_id)}"></span>
    <span style="font-size:10px;color:var(--accent)">ref</span>
  </span>`;
}

// ── Heap panel ────────────────────────────────────────────────────────────────
function renderHeap(heap) {
    const seen = new Set();

    Object.entries(heap || {}).forEach(([refId, obj]) => {
        seen.add(refId);
        if (knownHeapEls[refId]) {
            updateHeapObj(refId, obj);
        } else {
            createHeapObj(refId, obj);
        }
    });

    // Remove stale heap objects
    Object.keys(knownHeapEls).forEach(refId => {
        if (!seen.has(refId)) {
            const elToRemove = knownHeapEls[refId];
            gsap.to(elToRemove, {
                opacity: 0, scale: .9, duration: .25,
                onComplete: () => elToRemove?.remove()
            });
            delete knownHeapEls[refId];
        }
    });
}

const typeClass = t => ["list", "tuple", "dict", "set", "Stack"].includes(t) ? t : "obj";

function heapBodyHTML(obj) {
    if (obj.type === "list" || obj.type === "tuple" || obj.type === "set") {
        return obj.items.map((v, i) => `
      <div class="val-box">
        <div class="val-idx">[${i}]</div>
        <div class="val-val">${h(v)}</div>
      </div>
    `).join("");
    }
    if (obj.type === "dict") {
        if (!obj.entries || obj.entries.length === 0) return `<div style="padding:4px;color:#666">(empty dict)</div>`;
        return `<table class="dict-table">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
          ${obj.entries.map(e => `<tr><td class="dict-key">${h(e[0])}</td><td class="dict-val">${h(e[1])}</td></tr>`).join("")}
          </tbody></table>`;
    }
    if (obj.type === "Stack") {
        // Reverse items so top of stack is visually at the top
        const items = [...obj.items].reverse();
        if (items.length === 0) return `<div class="val-box"><div class="val-val" style="color:#666">(empty)</div></div>`;
        return items.map((v, i) => `
      <div class="val-box" data-idx="${items.length - 1 - i}">
        <div class="val-val" style="padding:4px 0;">${h(v)}</div>
      </div>
    `).join("");
    }
    return `<div style="padding:4px;color:#aaa">${h(obj.repr || "?")}</div>`;
}

function createHeapObj(refId, obj) {
    const el = document.createElement("div");
    el.className = "heap-obj";
    // Apply bucket visual to Stacks and Lists
    if (obj.type === "Stack" || obj.type === "list") el.classList.add("is-stack");
    el.dataset.id = refId;
    const tc = typeClass(obj.type);
    el.innerHTML = `
    <div class="heap-obj-head ${tc}">${h(obj.type)}</div>
    <div class="heap-obj-body">${heapBodyHTML(obj)}</div>
  `;
    // Add colored blocks for Stack/Bucket
    if (el.classList.contains("is-stack")) {
        const boxes = el.querySelectorAll(".val-box");
        boxes.forEach((box, i) => {
            const hue = (i * 55) % 360;
            box.style.borderColor = `hsl(${hue}, 80%, 60%)`;
            box.style.color = `hsl(${hue}, 80%, 90%)`;
            box.style.boxShadow = `0 4px 12px hsla(${hue}, 80%, 50%, 0.4)`;
        });
    }
    // Set visible by default, animate entrance
    el.style.opacity = "1";
    heapPanel.appendChild(el);
    knownHeapEls[refId] = el;
    gsap.fromTo(el, { opacity: 0, y: 12 }, {
        opacity: 1, y: 0, duration: .4, ease: "power3.out",
        clearProps: "opacity,transform"
    });
}

function updateHeapObj(refId, obj, prevObj) {
    const el = knownHeapEls[refId];
    if (!el) return;
    const bodyEl = el.querySelector(".heap-obj-body");
    if (!bodyEl) return;

    // For Stacks: handle push/pop animations before updating HTML
    if (obj.type === "Stack" && prevObj && prevObj.type === "Stack") {
        const newLen = obj.items.length;
        const oldLen = prevObj.items.length;

        if (newLen < oldLen) {
            // POP: Item jumped out. 
            // We temporarily add a ghost box that flies up and out, then disappears.
            const poppedItem = prevObj.items[oldLen - 1]; // top of old stack
            const ghost = document.createElement("div");
            ghost.className = "val-box";
            ghost.style.position = "absolute";
            ghost.style.top = "0"; // Top of the stack bucket
            ghost.style.left = "6px";
            ghost.style.width = "calc(100% - 12px)";
            ghost.style.zIndex = "50";
            ghost.innerHTML = `<div class="val-val" style="padding:4px 0;">${h(poppedItem)}</div>`;
            bodyEl.appendChild(ghost);

            // Enhanced POP Animation: Jump up and away in a wide arc
            gsap.to(ghost, {
                x: 120,
                y: -220,
                rotation: 90,
                scale: 0.8,
                opacity: 0,
                duration: 1.0,
                ease: "power1.in",
                onComplete: () => ghost.remove()
            });
        }
    }

    const newHTML = heapBodyHTML(obj);
    if (bodyEl.innerHTML !== newHTML) {
        bodyEl.innerHTML = newHTML;

        // Apply colors to the stack/bucket items
        if (el.classList.contains("is-stack")) {
            const boxes = bodyEl.querySelectorAll(".val-box");
            boxes.forEach((box, i) => {
                const hue = (i * 55) % 360;
                box.style.borderColor = `hsl(${hue}, 80%, 60%)`;
                box.style.color = `hsl(${hue}, 80%, 90%)`;
                box.style.boxShadow = `0 4px 12px hsla(${hue}, 80%, 50%, 0.4)`;
            });
        }

        if (el.classList.contains("is-stack") && prevObj && (prevObj.type === "Stack" || prevObj.type === "list")) {
            const newLen = obj.items ? obj.items.length : 0;
            const oldLen = prevObj.items ? prevObj.items.length : 0;
            if (newLen > oldLen) {
                // Enhanced PUSH Animation: Parabolic jump in from top-left
                const newBox = bodyEl.querySelector(`[data-idx="${newLen - 1}"]`);
                if (newBox) {
                    gsap.fromTo(newBox,
                        { x: -150, y: -250, rotation: -45, scale: 0.5, opacity: 0 },
                        { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, duration: 1.2, ease: "bounce.out" }
                    );
                }
            }
        } else if (obj.type !== "Stack" && obj.type !== "list") {
            gsap.fromTo(bodyEl, { backgroundColor: "rgba(255,255,255,0.2)" }, { backgroundColor: "transparent", duration: 0.4 });
        }
    }
}

// ── SVG Arrows (frames → heap) ────────────────────────────────────────────────
function drawArrows() {
    // Basic defs are set in HTML/JS on load. We only want to remove path elements.
    const paths = Array.from(arrowSvg.querySelectorAll("path"));
    paths.forEach(p => p.remove());

    const vizBody = D("viz-body");
    if (!vizBody) return;
    const vr = vizBody.getBoundingClientRect();

    // Every dot that marks a reference variable
    document.querySelectorAll(".ref-dot[data-dot-id]").forEach(dot => {
        const refId = dot.dataset.dotId;
        const target = knownHeapEls[refId];
        if (!target) return;

        // Make sure both are visible in the DOM
        const dr = dot.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        if (!dr.width || !tr.width) return; // not rendered yet

        const x1 = dr.right - vr.left;
        const y1 = (dr.top + dr.height / 2) - vr.top;
        const x2 = tr.left - vr.left;
        const y2 = (tr.top + tr.height / 2) - vr.top;

        // Skip if out of range (panels scrolled)
        if (x2 <= x1) return;

        const cx1 = x1 + (x2 - x1) * 0.45;
        const cy1 = y1;
        const cx2 = x1 + (x2 - x1) * 0.55;
        const cy2 = y2;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`);
        path.setAttribute("stroke", "#6c8af7");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("fill", "none");
        path.setAttribute("opacity", "0.75");
        path.setAttribute("marker-end", "url(#ah)");
        arrowSvg.appendChild(path);
    });
}

// ── Virtual File System ───────────────────────────────────────────────────────
let knownFiles = {}; // filename -> element

function renderVFS(vfsState, prevVfsState = {}) {
    if (!vfsContainer) return;

    const fileCount = Object.keys(vfsState).length;
    const vfsResizer = document.querySelector(".vfs-resizer");
    if (fileCount > 0) {
        vfsPanel.style.display = "flex";
        if (vfsResizer) vfsResizer.style.display = "block";
    } else {
        vfsPanel.style.display = "none";
        if (vfsResizer) vfsResizer.style.display = "none";
    }

    const seen = new Set();

    for (const [filename, f] of Object.entries(vfsState)) {
        seen.add(filename);
        let el = knownFiles[filename];
        let isNewFile = false;

        if (!el) {
            isNewFile = true;
            el = document.createElement("div");
            el.className = "vfs-file";
            el.dataset.name = filename;
            vfsContainer.appendChild(el);
            knownFiles[filename] = el;
            gsap.from(el, { opacity: 0, scale: 0.95, duration: 0.25 });
        }

        const isBinary = (f.content || "").startsWith("<Binary:");
        const changed = prevVfsState[filename] && prevVfsState[filename].content !== f.content;

        let headerHtml = `
          <div class="vfs-header">
            <span>📄</span>
            <span>${h(filename)}</span>
            <span style="opacity: 0.7; font-size: 10px; margin-left: auto;">${h(f.mode)}${f.closed ? " (closed)" : ""}</span>
          </div>`;

        let contentObj = f.content || "";
        let bodyHtml = "";

        if (isBinary) {
            bodyHtml = `<div class="vfs-body"><div class="vfs-line" style="color:var(--c-num)">${h(contentObj)}</div></div>`;
        } else {
            // For text, just render lines
            let lines = contentObj.split("\n");
            // Add cursor indicator visually if file is not closed
            bodyHtml = `<div class="vfs-body">` + lines.map(l => `<div class="vfs-line">${h(l)}</div>`).join("") + `</div>`;
        }

        el.innerHTML = headerHtml + bodyHtml;
    }

    // Remove stale files
    Object.keys(knownFiles).forEach(name => {
        if (!seen.has(name)) {
            const elToRemove = knownFiles[name];
            gsap.to(elToRemove, { opacity: 0, duration: 0.2, onComplete: () => elToRemove?.remove() });
            delete knownFiles[name];
        }
    });
}

// ── Playback ──────────────────────────────────────────────────────────────────
function startPlay() {
    if (playTimer) return;
    if (cur >= steps.length - 1) goTo(0);
    btnPlay.textContent = "⏸"; btnPlay.classList.add("playing");
    const delay = () => Math.max(150, 1500 - spdSlider.value * 14);
    const tick = () => {
        if (cur >= steps.length - 1) { stopPlay(); return; }
        goTo(cur + 1);
        playTimer = setTimeout(tick, delay());
    };
    playTimer = setTimeout(tick, delay());
}

function stopPlay() {
    if (playTimer) clearTimeout(playTimer);
    playTimer = null; btnPlay.textContent = "▶"; btnPlay.classList.remove("playing");
}

function updateUI() {
    const t = steps.length, i = cur;
    stepCtr.textContent = t ? `${i + 1} / ${t}` : "";
    progFill.style.width = t ? `${(i + 1) / t * 100}%` : "0%";
    btnPrev.disabled = i <= 0;
    btnFirst.disabled = i <= 0;
    btnNext.disabled = i >= t - 1;
}

function setEnabled(on) {
    [btnFirst, btnPrev, btnPlay, btnNext].forEach(b => b.disabled = !on);
    if (!on) { stopPlay(); stepCtr.textContent = ""; progFill.style.width = "0%"; }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
function onKey(e) {
    if (e.target.closest(".CodeMirror")) return;
    if (e.key === "ArrowRight" && !btnNext.disabled) { e.preventDefault(); stopPlay(); goTo(cur + 1); }
    if (e.key === "ArrowLeft" && !btnPrev.disabled) { e.preventDefault(); stopPlay(); goTo(cur - 1); }
    if (e.key === " " && steps.length) { e.preventDefault(); playTimer ? stopPlay() : startPlay(); }
}

// ── Clear ─────────────────────────────────────────────────────────────────────
function clearAll() {
    steps = []; cur = -1;
    Object.values(knownFrames).forEach(f => f.el.remove());
    Object.keys(knownFrames).forEach(k => delete knownFrames[k]);
    Object.values(knownHeapEls).forEach(el => el.remove());
    Object.keys(knownHeapEls).forEach(k => delete knownHeapEls[k]);
    Object.values(knownFiles).forEach(el => el.remove());
    Object.keys(knownFiles).forEach(k => delete knownFiles[k]);
    const defs = arrowSvg.querySelector("defs");
    arrowSvg.innerHTML = ""; if (defs) arrowSvg.appendChild(defs);
    if (activeLineHandle !== null) {
        try { editor.removeLineClass(activeLineHandle, "wrap", "cm-exec-line"); editor.setGutterMarker(activeLineHandle, "exec-gutter", null); } catch (_) { }
        activeLineHandle = null;
    }
    lineCode.textContent = ""; scopePill.textContent = "";
    outContent.innerHTML = ""; errContent.textContent = "";
    idleEl.style.display = "flex"; idleEl.querySelector("p").textContent = "Run your code to start.";
    // Hide Frames + Heap panels until next run
    const pFrames = D("panel-frames"), pHeap = D("panel-heap");
    if (pFrames) pFrames.style.display = "none";
    if (pHeap) pHeap.style.display = "none";
    const vr = document.querySelector(".viz-resizer");
    if (vr) vr.style.display = "none";
    if (vfsPanel) vfsPanel.style.display = "none";
    const vfsResizer = document.querySelector(".vfs-resizer");
    if (vfsResizer) vfsResizer.style.display = "none";
    setEnabled(false);
}

// ── Resizer ───────────────────────────────────────────────────────────────────
function initResizer() {
    const resizers = document.querySelectorAll(".resizer-v, .resizer-h");

    resizers.forEach(resizer => {
        let isDragging = false;
        const isVertical = resizer.classList.contains("resizer-v");
        const leftId = resizer.dataset.left;
        const rightId = resizer.dataset.right;
        const topId = resizer.dataset.top;
        const bottomId = resizer.dataset.bottom;

        resizer.addEventListener("mousedown", (e) => {
            isDragging = true;
            resizer.classList.add("resizing");
            document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;

            if (isVertical) {
                const leftPanel = D(leftId);
                const rightPanel = D(rightId);
                if (!leftPanel || !rightPanel) return;

                const container = leftPanel.parentElement;
                const containerRect = container.getBoundingClientRect();
                const totalWidth = containerRect.width;

                const leftWidth = e.clientX - containerRect.left;
                const leftPercent = (leftWidth / totalWidth) * 100;

                if (leftPercent > 10 && leftPercent < 90) {
                    leftPanel.style.flex = `0 0 ${leftPercent}%`;
                    rightPanel.style.flex = `1 1 auto`;
                }
            } else {
                const topPanel = D(topId);
                const bottomPanel = D(bottomId);
                if (!topPanel || !bottomPanel) return;

                const container = topPanel.parentElement;
                const containerRect = container.getBoundingClientRect();
                const totalHeight = containerRect.height;

                const topHeight = e.clientY - containerRect.top;
                const topPercent = (topHeight / totalHeight) * 100;

                if (topPercent > 10 && topPercent < 90) {
                    topPanel.style.flex = `0 0 ${topPercent}%`;
                    bottomPanel.style.flex = `1 1 auto`;
                }
            }
            if (typeof drawArrows === "function") drawArrows();
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                resizer.classList.remove("resizing");
                document.body.style.cursor = "default";
            }
        });
    });

    initPanels();
}

function initPanels() {
    // 1. Panel-header collapse buttons (the — button inside each panel)
    document.querySelectorAll(".panel-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
            const panel = btn.closest(".panel");
            if (!panel) return;
            const content = panel.querySelector(".panel-content");
            if (!content) return;
            const isCollapsed = content.style.display === "none";
            content.style.display = isCollapsed ? "" : "none";
            btn.textContent = isCollapsed ? "—" : "□";
            panel.style.flexBasis = isCollapsed ? "" : "32px";
            panel.style.flexGrow = isCollapsed ? "" : "0";
            panel.style.flexShrink = isCollapsed ? "" : "0";
            if (typeof drawArrows === "function") drawArrows();
        });
    });

    // 2. Header visibility toggles (the buttons in the header bar)
    document.querySelectorAll(".ptoggle").forEach(btn => {
        const targetId = btn.dataset.target;
        btn.addEventListener("click", () => {
            const panel = D(targetId);
            if (!panel) return;
            const isHidden = panel.style.display === "none" || panel.style.display === "";
            // For panels that start hidden (frames/heap), check computed style
            const computedDisplay = window.getComputedStyle(panel).display;
            const shouldShow = computedDisplay === "none";
            panel.style.display = shouldShow ? "flex" : "none";
            btn.classList.toggle("active", shouldShow);
            if (typeof drawArrows === "function") drawArrows();
        });
    });

    // 2. Drag to move (Swap within parent)
    let dragSrcEl = null;

    document.querySelectorAll(".panel-header").forEach(header => {
        header.addEventListener("dragstart", (e) => {
            dragSrcEl = header.closest(".panel");
            dragSrcEl.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", dragSrcEl.id);
        });

        header.addEventListener("dragend", () => {
            document.querySelectorAll(".panel").forEach(p => p.classList.remove("dragging", "drop-target"));
        });
    });

    document.querySelectorAll(".panel").forEach(panel => {
        panel.addEventListener("dragover", (e) => {
            if (e.preventDefault) e.preventDefault();
            if (dragSrcEl && dragSrcEl !== panel && dragSrcEl.parentElement === panel.parentElement) {
                panel.classList.add("drop-target");
            }
            return false;
        });

        panel.addEventListener("dragleave", () => {
            panel.classList.remove("drop-target");
        });

        panel.addEventListener("drop", (e) => {
            if (e.stopPropagation) e.stopPropagation();

            if (dragSrcEl && dragSrcEl !== panel && dragSrcEl.parentElement === panel.parentElement) {
                const parent = panel.parentElement;
                const children = Array.from(parent.children);
                const srcIdx = children.indexOf(dragSrcEl);
                const targetIdx = children.indexOf(panel);

                if (srcIdx < targetIdx) {
                    parent.insertBefore(dragSrcEl, panel.nextSibling);
                } else {
                    parent.insertBefore(dragSrcEl, panel);
                }

                // Re-insert resizers if they got messed up
                fixResizers(parent);
            }
            return false;
        });
    });
}

function fixResizers(parent) {
    // Basic logic to ensure resizers are between panels
    const items = Array.from(parent.children);
    const panels = items.filter(i => i.classList.contains("panel"));
    const resizers = items.filter(i => i.classList.contains("resizer-v") || i.classList.contains("resizer-h"));

    // Simple approach: re-append in order: p1, r1, p2, r2...
    panels.forEach((p, idx) => {
        parent.appendChild(p);
        if (idx < panels.length - 1 && resizers[idx]) {
            parent.appendChild(resizers[idx]);
            // Update resizer data attributes if needed
            const isV = resizers[idx].classList.contains("resizer-v");
            if (isV) {
                resizers[idx].dataset.left = `#${p.id}`;
                resizers[idx].dataset.right = `#${panels[idx + 1].id}`;
            } else {
                resizers[idx].dataset.top = `#${p.id}`;
                resizers[idx].dataset.bottom = `#${panels[idx + 1].id}`;
            }
        }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function h(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function setRunBusy(on) { btnRun.disabled = on; btnRun.textContent = on ? "⏳ Running…" : "▶  Run"; }

// ── Wire buttons ──────────────────────────────────────────────────────────────
btnRun.addEventListener("click", handleRun);
btnClear.addEventListener("click", () => { stopPlay(); clearAll(); editor.setValue(defaultCode()); editor.focus(); });
btnFirst.addEventListener("click", () => { stopPlay(); goTo(0); });
btnPrev.addEventListener("click", () => { stopPlay(); goTo(cur - 1); });
btnPlay.addEventListener("click", () => { playTimer ? stopPlay() : startPlay(); });
btnNext.addEventListener("click", () => { stopPlay(); goTo(cur + 1); });

// Redraw arrows on window resize
window.addEventListener("resize", drawArrows);
