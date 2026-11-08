export function saveBytes(data, name) {
    saveBlob(new Blob([data], { type: "application/octet-stream" }), name);
}

export function saveBlob(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const DESKTOP_WIDTH = "(min-width: 561px)";
const KEEP_VISIBLE = 40;
let topLayer = 30;

export function raiseWindow(element) {
    element.style.zIndex = String(++topLayer);
}

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
        if (element.style.position === "fixed" || !element.matches("main")) raiseWindow(element);
    });
}

function setupDragging() {
    const wide = window.matchMedia(DESKTOP_WIDTH);
    const windows = [...document.querySelectorAll("main, dialog")];
    for (const element of windows) {
        const handle = element.querySelector(":scope > header");
        if (handle) makeDraggable(element, handle, wide);
    }
    wide.addEventListener("change", () => {
        if (!wide.matches) windows.forEach(resetWindow);
    });
}

const TOOLS = [
    { page: "index.html", label: "CEM Porter", key: "C", icon: "app-hack-studio" },
    { page: "cabs.html", label: "CAB Maker", key: "B", icon: "filetype-archive" },
    { page: "sync.html", label: "CEMSync", key: "S", icon: "network" },
    { page: "explorer.html", label: "ROM Explorer", key: "O", icon: "hard-disk" },
    { page: "package.html", label: "Package Explorer", key: "a", icon: "app-file-manager" },
    { page: "state.html", label: "State Explorer", key: "S", icon: "app-system-monitor" },
    { page: "fonts.html", label: "Font Converter", key: "F", icon: "app-font-editor" },
    { page: "hex.html", label: "Hex Annotator", key: "H", icon: "app-hex-editor" },
    { page: "icons.html", label: "Icon Lab", key: "I", icon: "app-pixel-paint" },
];

const SPONSOR_LINKS = [
    { href: "https://github.com/sponsors/gadgetoid", label: "Sponsor on GitHub", key: "G" },
    { href: "https://www.patreon.com/gadgetoid", label: "Patreon", key: "P" },
    { href: "https://ko-fi.com/gadgetoid", label: "Ko-fi", key: "K" },
];

const README_ICON = "app-help";

function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
}

function icon(name, size) {
    const image = element("img", { src: new URL(`../../vendor/serenity-icons/${size}x${size}/${name}.png`, import.meta.url).href, width: size, height: size });
    image.alt = "";
    return image;
}

function mnemonic(label, key) {
    const index = label.indexOf(key);
    return [label.slice(0, index), element("u", {}, key), label.slice(index + 1)];
}

function currentTool() {
    const page = location.pathname.split("/").pop() || "index.html";
    return TOOLS.find((tool) => tool.page === page);
}

function buildShell(current) {
    const iconSlot = (name) => (name ? icon(name, 16) : element("span"));
    const menuLink = ({ href, label, key, icon: name, external }) => {
        const attributes = { role: "menuitem", href };
        if (external) Object.assign(attributes, { target: "_blank", rel: "noopener" });
        return element("li", {}, element("a", attributes, iconSlot(name), element("span", {}, ...mnemonic(label, key))));
    };
    const desktop = element("nav", { id: "desktop", "aria-label": "Tools" }, element("ul", {}, ...TOOLS.map((tool) => {
        const attributes = { href: tool.page };
        if (tool === current) attributes["aria-current"] = "page";
        return element("li", {}, element("a", attributes, icon(tool.icon, 32), element("span", {}, tool.label)));
    })));
    const startMenu = element("div", { id: "start-menu", role: "menu", "aria-label": "Start", hidden: "" },
        element("span", { "aria-hidden": "true" }, "CE Magic Tools"),
        element("ul", {},
            element("li", {}, element("button", { type: "button", role: "menuitem", id: "menu-readme" }, iconSlot(README_ICON), element("span", {}, ...mnemonic("Readme", "R")))),
            ...TOOLS.filter((tool) => tool !== current).map((tool) => menuLink({ href: tool.page, ...tool })),
            element("li", { role: "separator" }),
            ...SPONSOR_LINKS.map((link) => menuLink({ ...link, external: true }))));
    const title = current?.label ?? document.title;
    const taskbar = element("footer", {},
        element("button", { type: "button", id: "start", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "start-menu" }, "Start"),
        element("button", { type: "button", tabindex: "-1" }, ...(current ? [icon(current.icon, 16)] : []), title),
        element("button", { type: "button", id: "notes-task", hidden: "" }, icon(README_ICON, 16), "Readme"),
        element("time", { id: "clock" }));
    document.body.append(desktop, startMenu, taskbar);
}

export function setupDesktop({ readmeKey }) {
    buildShell(currentTool());
    setupDragging();
    const elements = Object.fromEntries(["clock", "notes", "notes-task", "notes-close", "about-button", "start", "start-menu", "menu-readme"].map((id) => [id, document.getElementById(id)]));
    const tick = () => {
        elements.clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    };
    const showNotes = (open) => {
        if (open) {
            elements.notes.show();
            raiseWindow(elements.notes);
        } else {
            elements.notes.close();
        }
        elements["notes-task"].hidden = !open;
        elements["about-button"].setAttribute("aria-expanded", String(open));
        if (open) elements["notes-close"].focus();
    };
    const toggleNotes = () => showNotes(!elements.notes.open);
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
        if (event.key === "Escape" && elements.notes.open) showNotes(false);
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
