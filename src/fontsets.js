export const WGL4_RANGES = [
    [0x0020, 0x007e], [0x00a0, 0x017f], [0x0192, 0x0192], [0x01fa, 0x01ff], [0x02c6, 0x02c7], [0x02c9, 0x02c9], [0x02d8, 0x02dd],
    [0x037e, 0x037e], [0x0384, 0x038a], [0x038c, 0x038c], [0x038e, 0x03a1], [0x03a3, 0x03ce], [0x0401, 0x040c], [0x040e, 0x044f],
    [0x0451, 0x045c], [0x045e, 0x045f], [0x0490, 0x0491], [0x1e80, 0x1e85], [0x1ef2, 0x1ef3], [0x2013, 0x2015], [0x2017, 0x201e],
    [0x2020, 0x2022], [0x2026, 0x2026], [0x2030, 0x2030], [0x2032, 0x2033], [0x2039, 0x203a], [0x203c, 0x203c], [0x203e, 0x203e],
    [0x2044, 0x2044], [0x207f, 0x207f], [0x20a3, 0x20a4], [0x20a7, 0x20a7], [0x20ac, 0x20ac], [0x2105, 0x2105], [0x2113, 0x2113],
    [0x2116, 0x2116], [0x2122, 0x2122], [0x2126, 0x2126], [0x212e, 0x212e], [0x215b, 0x215e], [0x2190, 0x2195], [0x21a8, 0x21a8],
    [0x2202, 0x2202], [0x2206, 0x2206], [0x220f, 0x220f], [0x2211, 0x2212], [0x2215, 0x2215], [0x2219, 0x221a], [0x221e, 0x221f],
    [0x2229, 0x2229], [0x222b, 0x222b], [0x2248, 0x2248], [0x2260, 0x2261], [0x2264, 0x2265], [0x2302, 0x2302], [0x2310, 0x2310],
    [0x2320, 0x2321], [0x2500, 0x2500], [0x2502, 0x2502], [0x250c, 0x250c], [0x2510, 0x2510], [0x2514, 0x2514], [0x2518, 0x2518],
    [0x251c, 0x251c], [0x2524, 0x2524], [0x252c, 0x252c], [0x2534, 0x2534], [0x253c, 0x253c], [0x2550, 0x256c], [0x2580, 0x2580],
    [0x2584, 0x2584], [0x2588, 0x2588], [0x258c, 0x258c], [0x2590, 0x2593], [0x25a0, 0x25a1], [0x25aa, 0x25ac], [0x25b2, 0x25b2],
    [0x25ba, 0x25ba], [0x25bc, 0x25bc], [0x25c4, 0x25c4], [0x25ca, 0x25cb], [0x25cf, 0x25cf], [0x25d8, 0x25d9], [0x25e6, 0x25e6],
    [0x263a, 0x263c], [0x2640, 0x2640], [0x2642, 0x2642], [0x2660, 0x2660], [0x2663, 0x2663], [0x2665, 0x2666], [0x266a, 0x266b],
    [0xfb01, 0xfb02],
];

export const CODEPAGES = {
    1252: { label: "Western (cp1252)", encoding: "windows-1252", charset: 0, bit: 0 },
    1250: { label: "Central European (cp1250)", encoding: "windows-1250", charset: 238, bit: 1 },
    1251: { label: "Cyrillic (cp1251)", encoding: "windows-1251", charset: 204, bit: 2 },
    1253: { label: "Greek (cp1253)", encoding: "windows-1253", charset: 161, bit: 3 },
};

export function codepageMap(codepage) {
    const decoder = new TextDecoder(CODEPAGES[codepage].encoding);
    const map = new Map();
    for (let byte = 0x20; byte <= 0xff; byte++) {
        const codepoint = decoder.decode(Uint8Array.of(byte)).codePointAt(0);
        if (codepoint >= 0x20 && !(codepoint >= 0x7f && codepoint < 0xa0) && codepoint !== 0xfffd) map.set(byte, codepoint);
    }
    return map;
}

function fromRanges(ranges) {
    return ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));
}

export const CHARACTER_SETS = [
    { key: "cp1252", label: "Western (cp1252)", codepoints: () => [...codepageMap(1252).values()] },
    { key: "cp1250", label: "Central European (cp1250)", codepoints: () => [...codepageMap(1250).values()] },
    { key: "cp1251", label: "Cyrillic (cp1251)", codepoints: () => [...codepageMap(1251).values()] },
    { key: "cp1253", label: "Greek (cp1253)", codepoints: () => [...codepageMap(1253).values()] },
    { key: "wgl4", label: "WGL4 (Pan-European)", codepoints: () => fromRanges(WGL4_RANGES) },
    { key: "latin-extended-a", label: "Latin Extended-A", codepoints: () => fromRanges([[0x0100, 0x017f]]) },
    { key: "punctuation", label: "General punctuation", codepoints: () => fromRanges([[0x2010, 0x205e]]) },
    { key: "arrows", label: "Arrows", codepoints: () => fromRanges([[0x2190, 0x21ff]]) },
    { key: "box", label: "Box drawing and blocks", codepoints: () => fromRanges([[0x2500, 0x259f]]) },
    { key: "shapes", label: "Geometric shapes", codepoints: () => fromRanges([[0x25a0, 0x25ff]]) },
];

export function chosenCodepoints(keys, extra) {
    const chosen = new Set();
    for (const set of CHARACTER_SETS) {
        if (keys.includes(set.key)) set.codepoints().forEach((codepoint) => chosen.add(codepoint));
    }
    for (const character of extra) {
        const codepoint = character.codePointAt(0);
        if (codepoint >= 0x20) chosen.add(codepoint);
    }
    return [...chosen].sort((first, second) => first - second);
}
