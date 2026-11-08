import { segments } from "./outline.js";

const QUAD_STEPS = 8;
const CUBIC_STEPS = 12;
const THIN = 1e-4;

export function contoursToCommands(contours, scale, originX, baseline) {
    const place = (point) => ({ x: originX + point.x * scale, y: baseline - point.y * scale });
    const commands = [];
    for (const contour of contours) {
        const parts = segments(contour);
        const start = place(parts[0].start);
        commands.push({ type: "M", x: start.x, y: start.y });
        for (const part of parts) {
            const end = place(part.end);
            if (part.control) {
                const control = place(part.control);
                commands.push({ type: "Q", x1: control.x, y1: control.y, x: end.x, y: end.y });
            } else {
                commands.push({ type: "L", x: end.x, y: end.y });
            }
        }
        commands.push({ type: "Z" });
    }
    return commands;
}

function flatten(commands) {
    const edges = [];
    let start = null;
    let last = null;
    const lineTo = (point) => {
        if (![last.x, last.y, point.x, point.y].every(Number.isFinite)) {
            last = point;
            return;
        }
        if (last.x !== point.x || last.y !== point.y) edges.push({ x0: last.x, y0: last.y, x1: point.x, y1: point.y });
        last = point;
    };
    for (const command of commands) {
        if (command.type === "M") {
            if (last && start) lineTo(start);
            start = last = { x: command.x, y: command.y };
        } else if (command.type === "L") {
            lineTo({ x: command.x, y: command.y });
        } else if (command.type === "Q") {
            const from = last;
            for (let step = 1; step <= QUAD_STEPS; step++) {
                const t = step / QUAD_STEPS;
                const inverse = 1 - t;
                lineTo({
                    x: inverse * inverse * from.x + 2 * inverse * t * command.x1 + t * t * command.x,
                    y: inverse * inverse * from.y + 2 * inverse * t * command.y1 + t * t * command.y,
                });
            }
        } else if (command.type === "C") {
            const from = last;
            for (let step = 1; step <= CUBIC_STEPS; step++) {
                const t = step / CUBIC_STEPS;
                const inverse = 1 - t;
                lineTo({
                    x: inverse ** 3 * from.x + 3 * inverse * inverse * t * command.x1 + 3 * inverse * t * t * command.x2 + t ** 3 * command.x,
                    y: inverse ** 3 * from.y + 3 * inverse * inverse * t * command.y1 + 3 * inverse * t * t * command.y2 + t ** 3 * command.y,
                });
            }
        } else if (command.type === "Z") {
            if (start) lineTo(start);
        }
    }
    if (last && start) lineTo(start);
    return edges;
}

function spans(edges, position, across) {
    const crossings = [];
    for (const edge of edges) {
        const from = across ? edge.x0 : edge.y0;
        const to = across ? edge.x1 : edge.y1;
        if (from === to) continue;
        const low = Math.min(from, to);
        const high = Math.max(from, to);
        if (position < low || position >= high) continue;
        const t = (position - from) / (to - from);
        const at = across ? edge.y0 + t * (edge.y1 - edge.y0) : edge.x0 + t * (edge.x1 - edge.x0);
        crossings.push({ at, winding: to > from ? 1 : -1 });
    }
    crossings.sort((first, second) => first.at - second.at);
    const result = [];
    let winding = 0;
    let opened = 0;
    for (const crossing of crossings) {
        const before = winding;
        winding += crossing.winding;
        if (before === 0 && winding !== 0) opened = crossing.at;
        else if (before !== 0 && winding === 0) result.push([opened, crossing.at]);
    }
    return result;
}

export function rasterize(commands, width, height) {
    const bitmap = new Uint8Array(width * height);
    const edges = flatten(commands);
    const set = (x, y) => {
        if (x >= 0 && x < width && y >= 0 && y < height) bitmap[y * width + x] = 1;
    };
    for (let row = 0; row < height; row++) {
        for (const [from, to] of spans(edges, row + 0.5, false)) {
            const first = Math.ceil(from - 0.5);
            const last = Math.ceil(to - 0.5) - 1;
            if (first <= last) for (let x = Math.max(0, first); x <= Math.min(width - 1, last); x++) set(x, row);
            else if (to - from > THIN) set(Math.floor((from + to) / 2), row);
        }
    }
    for (let column = 0; column < width; column++) {
        for (const [from, to] of spans(edges, column + 0.5, true)) {
            if (Math.ceil(from - 0.5) > Math.ceil(to - 0.5) - 1 && to - from > THIN) set(column, Math.floor((from + to) / 2));
        }
    }
    return bitmap;
}
