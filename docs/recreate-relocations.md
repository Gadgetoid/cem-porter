# Recreating relocation tables (dumped/stripped ARM modules)

Dumped ROM/XIP modules usually have their base-relocation table stripped and the
`IMAGE_FILE_RELOCS_STRIPPED` flag set, so `realign()` refuses to move their sections
("relocations stripped: sections can't be moved"). This recovers the table so such a
module can be rebased, realigned, ported, or extracted from a ROM as a standalone DLL.

Distilled from "how to recreate missing relocations in dumped dlls for CE3/CE4 based
systems" (reloctut, 2007; itsme / isotherm). ARM first; MIPS/SH3 noted below.

## Method (ARM, no disassembly)

ARM cannot embed a full 32-bit address in an instruction, so every absolute address a
module uses is stored as a word in a **literal pool**. That makes relocations recoverable
by scanning, not disassembly:

1. Flatten the module to its mapped image using the (correct) section RVAs.
2. **Candidates**: every 4-byte-aligned word whose value is in `[imageBase, imageBase+SizeOfImage)`.
3. **Filter**: for a candidate inside a code section, keep it only if some
   `LDR Rd,[pc,#imm]` actually loads that address (a real literal). Candidates in pure-data
   sections (`.data`, `.pdata`) are always kept. This drops the few stray instructions that
   coincidentally look like an in-image address.
4. Emit a `HIGHLOW` (type 3) relocation at each surviving site.

`LDR` literal encoding used by the filter: `cond=1110, 0101 U001 1111 Rd imm12`
(Rn = pc, load, immediate); target = `(ldr + 8) ± imm`.

## Validation

Against the reloctut example `dumped_kbdrABB.dll` (ARM, stripped) vs its hand-made
`relocateddll.dll`: the scan alone finds **all 144** real relocations plus 2 false
positives; the `LDR` filter removes exactly those 2, giving a **byte-exact 144/144 match**.
`src/recreate.js` reproduces this (`recreateRelocations(image)` returns the 144 entries,
all `HIGHLOW`), and they feed the existing `encodeRelocations()` unchanged.

## Integration (implemented)

- `recreateRelocations(image)` -> relocation entries; `attachRelocations(pe)` runs it on a
  rebuilt PE, encodes a `.reloc` section, appends it, sets the fixup directory, and clears
  `IMAGE_FILE_RELOCS_STRIPPED`. Validated end-to-end on the ARM32 example: 144 relocations,
  flag cleared, `.reloc` appended - a complete relocatable PE.
- **ROM Explorer wiring:** `openRom()` already parses real ROMs (including the Sharp SDU) and
  `region.rebuild(module)` already emits a standalone PE with correct RVAs and intact imports.
  Add an "Export relocatable DLL/EXE" action to the module save path that pipes
  `rebuild(module)` through `attachRelocations()`. The core is done; only the UI handler
  (explorer.js module save) remains.

## Original notes

- `recreateRelocations(image)` -> `[{ kind: REL_HIGHLOW, site, parameter: null }]`, ready for
  `encodeRelocations()` and the `realign()` / `tryRealign()` path. Hook it where `realign`
  currently throws on stripped relocations: recreate first, then realign.
- Clear `IMAGE_FILE_RELOCS_STRIPPED` and write the new `.reloc` section + directory entry.
- Expose in **ROM Explorer** so a module extracted from a ROM can be saved as a relocatable
  DLL.

## Remaining work

- **Header recovery for corrupt dumps.** The example's section VAs were garbage
  (`0x2001000`...); the real RVAs/imageBase/SizeOfImage must be fixed first (reloctut's
  "corrupt PE header" section). For modules extracted via ROM Explorer the layout is already
  known, so recreation runs directly.
- **Two-dump diff (even more reliable).** With two dumps of the same module at different load
  bases, the words that differ by exactly the base delta ARE the relocations - no LDR
  heuristic, no false positives. Prefer this when two dumps exist.
- **MIPS/SH3.** Addresses aren't all literal-pool words: MIPS uses `lui`/`addiu` (HIGH/LOW)
  pairs - `realign.js` already pairs those (`pairLows`), so MIPS recreation can reuse it;
  SH3 uses literal pools like ARM but with its own load encodings.

## CE 6.0 ARM (Thumb-2) status

Tested against the PW-SH2 SDU via `openRom()`: ce-porter parses it directly (one region, ~157
ARM modules - `coredll.dll`, `fpcrt.dll`, ...). Rebuilt modules are valid PEs **with imports
intact** but an **empty reloc directory** (CE6 ROM modules carry no relocations), so recreate is
needed to make them relocatable. Two differences from the ARM32 case:
- Machine is `0x1c2` (Thumb-2), not ARM32 `0x1c0`. The candidate scan and data-section
  (`.data`/`.pdata`) handling are CPU-independent, but the `.text` literal filter needs a
  **Thumb-2 LDR-literal detector** (T1 `01001 Rt imm8`, T2 `F8DF/F85F Rt imm12`, target =
  `Align(PC,4) + offset`), tracking the mixed 16/32-bit instruction stream.
- The reloc-stripped flag is clear (dir is just empty), so detection keys on an empty fixup
  directory rather than the flag.

So: ARM32 end-to-end is done and validated; CE 6.0 ARM needs the Thumb-2 literal detector added
to `recreate.js` (bounded) to reach full `.text` precision - everything else (parse, rebuild,
attach) already works on real SDU modules.

## Per-CPU status (validated)

| CPU | How addresses form | Method | Result |
|---|---|---|---|
| ARM32 (0x1c0) | literal pools, `LDR Rd,[pc]` | scan + LDR filter | 144/144 exact (reloctut example) |
| SH3/SH4 (0x1a2/0x1a6) | literal pools, `mov.l @(disp,PC),Rn` | scan + mov.l filter | all 1131 found, 4 false positives on unzip.dll |
| MIPS (0x166) | `lui`+`addiu`/`ori` HIGH16/LOW16 pairs (data pointers still single words) | HIGHLOW scan for data + lui/low pairing (reuse `pairLows`) | not yet implemented |
| Any | — | **two-dump diff** (`relocationsByDiff`) | 1131/1131 exact, zero false positives |

`recreateRelocations(image)` dispatches on `image.machine` for ARM32 and SH3/SH4. The single-dump
scan recovers every real relocation but, for SH3 (and potentially ARM), a few data words that
coincidentally land in-range and are loaded as literals can't be told from real address constants -
irreducible without a second dump. `relocationsByDiff(bytesA, bytesB, delta)` is the
architecture-independent, false-positive-free path when two dumps at different bases are available
(also catches MIPS lui/addiu immediate changes for free).

## Still to incorporate

- **MIPS lui/addiu pairing** in `recreateRelocations` (reuse `realign.js` `pairLows`).
- **CE 6.0 ARM / Thumb-2 (0x1c2)** literal detector (T1/T2 `LDR`), for the SDU-class ROMs.
- **ROM Explorer UI**: "Export relocatable DLL/EXE" action = `attachRelocations(rebuild(module))`.
- **False-positive refinement** for single-dump SH3/ARM (target-validity heuristics), or prefer
  `relocationsByDiff` where two dumps exist.
