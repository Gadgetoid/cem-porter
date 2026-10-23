# CEM Porter

*Keep on keeping on!*

Use it at https://gadgetoid.github.io/cem-porter/

A single-page tool for porting Windows CE 2.11 and 2.0 programs and installers back to CE 2.0 and 1.0 for MIPS and SH3 handhelds. Open a desktop installer, CE CAB, zip, LZH or program, pick a build and a target device, and save a CAB for CE 2.0, a self-installing program for CE 1.0 (and 2.0), or the ported files as a zip.

Served from GitHub Pages; no build step. Open `index.html` through any static server (`python3 -m http.server`) to run it locally.

## What it does

### Unpacks

- InstallShield 3 (`.z`), PKWARE DCL, SZDD (`.ex_`)
- zip, LZH (`-lh0-`, `-lh5-` to `-lh7-`)
- MS CAB: stored, MSZIP and LZX (not Quantum)
- InstallShield 5 and 6 cabinets (`data1.cab`, with `data1.hdr` and further volumes when present)
- Installers with any of these embedded, recursively

### Finds builds

- CE CABs (any folder with a `.000` setup file)
- H/PC Explorer `.load` scripts; scripts in sibling folders are merged into one build
- `.load.full`, `.load.lite` and similar scripts are offered as separate builds
- Files a script copies are found under per-CPU or per-variant names (`LE.exe.MIPS`, `ParaKey.dll.SH3.Full`) anywhere in the package; a `remoteExec` path sets the install folder
- Loose programs, grouped by CPU and folder
- Packages with a CAB per program are also offered merged, one build per CPU, CE version and variant ("(Color)", "(B&W)"), with any shared-files CAB included
- Each build's files can be picked or left out before porting

### CE 2.11 to 2.0

- System calls imported by ordinal are renumbered from H/PC Pro, Palm-size PC and HPC2000 numbering to H/PC 2.0's
- C runtime functions only later COREDLLs export come from `VELOCRT.DLL` (MIPS `__dp*`, `__ll_*`; SH3 `_divls`, `_addd`, `_*i64` and others)

### CE 2.0 or 1.01 to 1.0

- COREDLL ordinals become names
- `FindResourceW`, `CeOpenDatabase` and the `Ce*` database calls get their CE 1.0 names
- CE 1.01 functions come from `VELOSHIM.DLL`
- Common CE 2.0 functions (dialog item text, `lstrcmpW`, mutexes, `PlaySoundW`, `CreatePen` and others) come from `CE1COMPAT.DLL`
- C runtime from `VELOCRT.DLL`
- `GetModuleFileNameW` returns the install path: an added section holds it, and an entry stub passes it to `CE1COMPAT.DLL` at startup. The self-installer fills in the final path, including the card folder
- Marked as a CE 1.0 program; the relocations-stripped flag CE 1.0 rejects is cleared
- Bitmaps and icons over 2 bpp are reduced to 4 greys
- MIPS: inline CE 2.x kernel calls (`TerminateProcess` in `exit`, `GetLastError`, `SetLastError`, `RaiseException` and others) become imports by name, via a stub section. `data/ce2-mips-traps.json` maps trap addresses to COREDLL names
- SH3: inline kernel calls are patched in place
- DLLs CE 1.0 lacks are reported, or replaced by COREDLL where it has all their functions

### R4000 to R3910

- MIPS programs with 1 KB sections are moved to 4 KB pages for the Philips Velo's R3910

### Installers

- CE 2.0 CABs use `%CE1%` style folders, with the program folder as wceload's default
- CE 1.0 self-installers are `stub/ceinstall.c` with files and registry steps appended as a `.cepk` section. `/q` installs without asking; running again removes
- Setup DLLs go in the CAB for wceload, or are run by the self-installer (`Install_Init`, `Install_Exit`, `Uninstall_Init`, `Uninstall_Exit`), which binds their imports itself since CE 1.0's loader leaves Microsoft-linked DLLs unbound
- "Install to Storage Card/PC Card" puts everything outside `\Windows` on the card. DLLs stay in `\Windows`, the only place CE 1.0 and 2.0 load them from. The self-installer finds the card at run time; CABs use `\Storage Card`

Programs that need Microsoft runtimes (MFC 2.11, Visual Basic) need them installed separately.

## Licence

MIT, see `LICENSE`. `vendor/fflate.js` is fflate 0.8.2 (MIT, `vendor/fflate-LICENSE`).
