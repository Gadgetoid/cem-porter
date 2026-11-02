import cubicToQuad from "../vendor/cubic2quad.js";

const QUAD_SAMPLES = [0.25, 0.5, 0.75];
const CURVE_STEPS = 16;
const SMOOTH_JOINT = 0.05;

export function contoursFromPoints(points) {
    const contours = [];
    let current = [];
    for (const point of points) {
        current.push({ x: point.x, y: point.y, on: point.onCurve });
        if (point.lastPointOfContour) {
            contours.push(current);
            current = [];
        }
    }
    if (current.length) contours.push(current);
    return contours;
}

export function contoursFromCommands(commands, tolerance) {
    const contours = [];
    let current = null;
    let start = null;
    let last = null;
    const close = () => {
        if (current && current.length > 1) {
            const first = current[0];
            const end = current[current.length - 1];
            if (end.on && end.x === first.x && end.y === first.y) current.pop();
        }
        if (current && current.length) contours.push(current);
        current = null;
    };
    for (const command of commands) {
        if (command.type === "M") {
            close();
            current = [{ x: command.x, y: command.y, on: true }];
            start = last = { x: command.x, y: command.y };
        } else if (command.type === "L") {
            current.push({ x: command.x, y: command.y, on: true });
            last = command;
        } else if (command.type === "Q") {
            current.push({ x: command.x1, y: command.y1, on: false }, { x: command.x, y: command.y, on: true });
            last = command;
        } else if (command.type === "C") {
            const quads = cubicToQuad(last.x, last.y, command.x1, command.y1, command.x2, command.y2, command.x, command.y, tolerance);
            for (let index = 2; index < quads.length; index += 2) current.push({ x: quads[index], y: quads[index + 1], on: index % 4 === 0 });
            last = command;
        } else if (command.type === "Z") {
            close();
            last = start;
        }
    }
    close();
    return contours;
}

export function reverseContours(contours) {
    return contours.map((contour) => [contour[0], ...contour.slice(1).reverse()]);
}

export function scaleContours(contours, factor) {
    return contours.map((contour) => contour.map((point) => ({ x: point.x * factor, y: point.y * factor, on: point.on })));
}

export function countPoints(contours) {
    return contours.reduce((total, contour) => total + contour.length, 0);
}

function midpoint(first, second) {
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, on: true };
}

function quadAt(start, control, end, t) {
    const inverse = 1 - t;
    return {
        x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
        y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
    };
}

export function segments(contour) {
    let points = contour;
    if (!points.some((point) => point.on)) points = [midpoint(points[points.length - 1], points[0]), ...points];
    const firstOn = points.findIndex((point) => point.on);
    points = [...points.slice(firstOn), ...points.slice(0, firstOn)];
    const count = points.length;
    const result = [];
    let start = points[0];
    let index = 1;
    while (index <= count) {
        const next = points[index % count];
        if (next.on) {
            result.push({ start, control: null, end: next });
            start = next;
            index += 1;
            continue;
        }
        const after = points[(index + 1) % count];
        const end = after.on ? after : midpoint(next, after);
        result.push({ start, control: next, end });
        start = end;
        index += after.on ? 2 : 1;
    }
    return result;
}

function distanceToLine(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function distanceToQuad(point, start, control, end) {
    let best = Infinity;
    let previous = start;
    for (let step = 1; step <= CURVE_STEPS; step++) {
        const current = quadAt(start, control, end, step / CURVE_STEPS);
        best = Math.min(best, distanceToLine(point, previous, current));
        previous = current;
    }
    return best;
}

function intersect(firstStart, firstThrough, secondStart, secondThrough) {
    const firstX = firstThrough.x - firstStart.x;
    const firstY = firstThrough.y - firstStart.y;
    const secondX = secondThrough.x - secondStart.x;
    const secondY = secondThrough.y - secondStart.y;
    const denominator = firstX * secondY - firstY * secondX;
    if (Math.abs(denominator) < 1e-9) return null;
    const along = ((secondStart.x - firstStart.x) * secondY - (secondStart.y - firstStart.y) * secondX) / denominator;
    const alongSecond = ((secondStart.x - firstStart.x) * firstY - (secondStart.y - firstStart.y) * firstX) / denominator;
    if (along <= 0 || alongSecond <= 0) return null;
    return { x: firstStart.x + along * firstX, y: firstStart.y + along * firstY, on: false };
}

function smoothJoint(first, second) {
    const inX = first.end.x - first.control.x;
    const inY = first.end.y - first.control.y;
    const outX = second.control.x - second.start.x;
    const outY = second.control.y - second.start.y;
    const lengths = Math.hypot(inX, inY) * Math.hypot(outX, outY);
    if (!lengths) return false;
    return inX * outX + inY * outY > 0 && Math.abs(inX * outY - inY * outX) / lengths < SMOOTH_JOINT;
}

function merged(first, second, tolerance) {
    const samples = [...first.samples, first.end, ...second.samples];
    if (!first.control && !second.control) {
        if (samples.every((point) => distanceToLine(point, first.start, second.end) <= tolerance)) return { start: first.start, control: null, end: second.end, samples };
        return null;
    }
    if (!first.control || !second.control || !smoothJoint(first, second)) return null;
    const control = intersect(first.start, first.control, second.end, second.control);
    if (!control) return null;
    if (!samples.every((point) => distanceToQuad(point, first.start, control, second.end) <= tolerance)) return null;
    const original = [first.start, ...samples, second.end];
    const strays = QUAD_SAMPLES.map((t) => quadAt(first.start, control, second.end, t)).filter((point) => {
        let best = Infinity;
        for (let index = 1; index < original.length; index++) best = Math.min(best, distanceToLine(point, original[index - 1], original[index]));
        return best > 2 * tolerance;
    });
    return strays.length ? null : { start: first.start, control, end: second.end, samples };
}

function simplifyContour(contour, tolerance) {
    let parts = segments(contour).map((segment) => {
        if (!segment.control) return { ...segment, samples: [] };
        const samples = QUAD_SAMPLES.map((t) => quadAt(segment.start, segment.control, segment.end, t));
        if (distanceToLine(segment.control, segment.start, segment.end) / 2 <= tolerance) return { start: segment.start, control: null, end: segment.end, samples };
        return { ...segment, samples };
    });
    let changed = true;
    while (changed && parts.length > 3) {
        changed = false;
        for (let index = 0; index < parts.length && parts.length > 3; index++) {
            const nextIndex = (index + 1) % parts.length;
            const joined = merged(parts[index], parts[nextIndex], tolerance);
            if (!joined) continue;
            if (nextIndex === 0) parts = [...parts.slice(1, index), joined];
            else parts.splice(index, 2, joined);
            changed = true;
        }
    }
    return parts.flatMap((part) => (part.control ? [{ ...part.start, on: true }, { ...part.control, on: false }] : [{ ...part.start, on: true }]));
}

export function simplifyContours(contours, tolerance) {
    if (!(tolerance > 0)) return contours;
    return contours.map((contour) => simplifyContour(contour, tolerance));
}

function samePlace(first, second) {
    return first.x === second.x && first.y === second.y;
}

function removeRepeats(points) {
    const result = [];
    for (const point of points) {
        const previous = result[result.length - 1];
        if (previous && samePlace(previous, point)) {
            if (!previous.on && point.on) result[result.length - 1] = point;
            continue;
        }
        result.push(point);
    }
    while (result.length > 1 && samePlace(result[0], result[result.length - 1])) {
        const last = result.pop();
        if (last.on && !result[0].on) result[0] = last;
    }
    return result;
}

function redundant(previous, point, next) {
    if (!point.on) return false;
    if (!previous.on && !next.on) return previous.x + next.x === 2 * point.x && previous.y + next.y === 2 * point.y;
    if (previous.on && next.on) {
        const cross = (point.x - previous.x) * (next.y - previous.y) - (point.y - previous.y) * (next.x - previous.x);
        const dot = (point.x - previous.x) * (next.x - point.x) + (point.y - previous.y) * (next.y - point.y);
        return cross === 0 && dot >= 0;
    }
    return false;
}

export function roundContours(contours) {
    const result = [];
    for (const contour of contours) {
        let points = removeRepeats(contour.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y), on: point.on })));
        let index = 0;
        while (points.length > 3 && index < points.length) {
            const previous = points[(index + points.length - 1) % points.length];
            const next = points[(index + 1) % points.length];
            if (redundant(previous, points[index], next)) points.splice(index, 1);
            else index += 1;
        }
        if (points.length >= 3) result.push(points);
    }
    return result;
}

export function contourBounds(contours) {
    const points = contours.flat();
    if (!points.length) return null;
    return {
        xMin: Math.min(...points.map((point) => point.x)),
        yMin: Math.min(...points.map((point) => point.y)),
        xMax: Math.max(...points.map((point) => point.x)),
        yMax: Math.max(...points.map((point) => point.y)),
    };
}
