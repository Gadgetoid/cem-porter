export function saveBytes(data, name) {
    const blob = new Blob([data], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function setupDesktop({ readmeKey }) {
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
