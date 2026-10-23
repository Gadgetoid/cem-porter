export function saveBytes(data, name) {
    const blob = new Blob([data], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const DESKTOP_WIDTH = "(min-width: 561px)";
const KEEP_VISIBLE = 40;
let topLayer = 30;

function resetWindow(element) {
    for (const property of ["position", "left", "top", "width", "margin", "transform", "zIndex"]) element.style[property] = "";
}

function makeDraggable(element, handle, wide) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
        if (!wide.matches || event.pointerType === "touch" || event.button !== 0 || event.target.closest("button")) return;
        const rect = element.getBoundingClientRect();
        Object.assign(element.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: "0", transform: "none", zIndex: String(++topLayer) });
        drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const left = Math.min(Math.max(event.clientX - drag.x, KEEP_VISIBLE - element.offsetWidth), window.innerWidth - KEEP_VISIBLE);
        const top = Math.min(Math.max(event.clientY - drag.y, 0), window.innerHeight - KEEP_VISIBLE);
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    });
    const end = () => {
        drag = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    element.addEventListener("pointerdown", () => {
        if (element.style.position === "fixed") element.style.zIndex = String(++topLayer);
    });
}

function setupDragging() {
    const wide = window.matchMedia(DESKTOP_WIDTH);
    const windows = [...document.querySelectorAll(".window, .notes, .dialog")];
    for (const element of windows) {
        const handle = element.querySelector(":scope > .title-bar");
        if (handle) makeDraggable(element, handle, wide);
    }
    wide.addEventListener("change", () => {
        if (!wide.matches) windows.forEach(resetWindow);
    });
}

export function setupDesktop({ readmeKey }) {
    setupDragging();
    const elements = Object.fromEntries(["clock", "notes", "notes-task", "notes-close", "about-button", "start", "start-menu", "menu-readme"].map((id) => [id, document.getElementById(id)]));
    const tick = () => {
        elements.clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    };
    const showNotes = (open) => {
        elements.notes.hidden = !open;
        elements["notes-task"].hidden = !open;
        elements["about-button"].setAttribute("aria-expanded", String(open));
        if (open) elements["notes-close"].focus();
    };
    const toggleNotes = () => showNotes(elements.notes.hidden);
    elements["about-button"].addEventListener("click", toggleNotes);
    const menuItems = () => [...elements["start-menu"].querySelectorAll("[role=menuitem]")];
    const showMenu = (open) => {
        elements["start-menu"].hidden = !open;
        elements.start.setAttribute("aria-expanded", String(open));
        if (open) menuItems()[0].focus();
    };
    elements.start.addEventListener("click", (event) => {
        event.stopPropagation();
        showMenu(elements["start-menu"].hidden);
    });
    elements["menu-readme"].addEventListener("click", () => {
        showMenu(false);
        showNotes(true);
    });
    menuItems().forEach((item) => item.addEventListener("click", () => showMenu(false)));
    elements["start-menu"].addEventListener("keydown", (event) => {
        const items = menuItems();
        const index = items.indexOf(document.activeElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
        } else if (event.key === "Escape") {
            showMenu(false);
            elements.start.focus();
        }
    });
    document.addEventListener("click", (event) => {
        if (!elements["start-menu"].hidden && !elements["start-menu"].contains(event.target)) showMenu(false);
    });
    elements["notes-task"].addEventListener("click", toggleNotes);
    elements["notes-close"].addEventListener("click", () => showNotes(false));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.notes.hidden) showNotes(false);
    });
    try {
        if (!localStorage.getItem(readmeKey)) {
            showNotes(true);
            localStorage.setItem(readmeKey, "seen");
        }
    } catch (error) {
        showNotes(false);
    }
    tick();
    setInterval(tick, 15000);
}
