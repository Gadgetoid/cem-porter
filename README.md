# CEM Porter

*Keep on keeping on!*

Use it at https://gadgetoid.github.io/cem-porter/

A single-page tool for porting Windows CE 2.11 and 2.0 programs and installers back to CE 2.0 and 1.0 for MIPS and SH3 handhelds. Open a desktop installer, CE CAB, zip, LZH, CD image or program, pick a build and a target device, and save a CAB for CE 2.0, a self-installing program for CE 1.0 (and 2.0), or the ported files as a zip.

Served from GitHub Pages; no build step. Open `index.html` through any static server (`python3 -m http.server`) to run it locally.

## What it does

### Unpacks

- InstallShield 3 (`.z`), PKWARE DCL, SZDD (`.ex_`)
- CASIO `.cpk` (`CASIO.$&%-Z`), the per-512-byte-block format the BE-300 and BE-500 store installed programs in: stored blocks, run-length blocks, and dictionary blocks of 1 to 8 bits
- CASIO `.cbea` installer packages, named by the platform they target (`Casio Jx740 CE3.00`); members stored as `.cpk` are expanded on the way out
- zip, LZH (`-lh0-`, `-lh5-` to `-lh7-`)
- MS CAB: stored, MSZIP and LZX (not Quantum)
- InstallShield 5 and 6 cabinets (`data1.cab`, with `data1.hdr` and further volumes when present)
- Installer VISE for Windows (`setup.exe`): the files it installs, not its own runtime
- InstallShield `setup.exe` file streams (InstallShield X era), decoded where obfuscated, and the older `setup.exe` that lists its disk files by name, path, version and size
- NSIS installers, solid or compressed per file, with Deflate, LZMA or bzip2
- RAR 1.5 to 3.x (not RAR5), including solid archives, PPMd and the standard filters (not Itanium), and RAR self-extractors. Each file is checked against its CRC. Decoding uses bitjs's unrar (MIT), adapted, with a PPMd port from libarchive's public domain Ppmd7
- Windows Installer `.msi` and `.mst` streams, including Windows CE CABs InstallShield stores as binary streams
- 7z: LZMA, LZMA2, PPMd, BZip2, Deflate and Copy, with BCJ, BCJ2, ARM and Delta filters (not encrypted archives)
- CD images: ISO 9660 with Joliet names (`.iso`), and raw 2352-byte sector images (`.bin`, `.mdf`) in Mode 1 or Mode 2 Form 1. Opened discs stay on disk: programs, archives and files up to 1 MB are read and unpacked, anything else only when a build installs it, or it's viewed or saved
- Installers with any of these embedded, recursively

### Finds builds

- CE CABs (any folder with a `.000` setup file, `MSCE` or `CE4+`)
- H/PC Explorer `.load` scripts; scripts in sibling folders are merged into one build
- `.load.full`, `.load.lite` and similar scripts are offered as separate builds
- Files a script copies are found under per-CPU or per-variant names (`LE.exe.MIPS`, `ParaKey.dll.SH3.Full`) anywhere in the package; a `remoteExec` path sets the install folder
- Loose programs, grouped by CPU and folder
- Packages with a CAB per program are also offered merged, one build per CPU, CE version and variant ("(Color)", "(B&W)"), with any shared-files CAB included
- Each build's files can be picked or left out before porting
- A build that came as a CE CAB, including ones inside desktop installers, can be saved as shipped (Save original CAB), for any CPU and CE version

### CE 2.11 to 2.0

- System calls imported by ordinal are renumbered from H/PC Pro, Palm-size PC and HPC2000 numbering to H/PC 2.0's
- MIPS Palm-size PC 1.0 (Philips Nino) keeps the CE 2.01 numbering later versions share, checked against the Nino 300's COREDLL; only functions it names or numbers differently are changed
- MIPS Palm-size PC 1.2 (Compaq Aero 1500 series) is checked against the Aero 1520 ROM's exports. Its COREDLL matches H/PC Pro 2.11; WINSOCK and OLE32 are numbered differently from the Nino's. NDIS and CEDDK imports are checked too
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

## ROM Explorer

https://gadgetoid.github.io/cem-porter/explorer.html (`explorer.html`) browses a Windows CE ROM image like the device's own Explorer and saves its contents as a zip.

- Reads CE BIN (B000FF) images, including ones whose load addresses differ from the OS's, and flat ROM or flash dumps (.nb0), finding the ROM header wherever the image sits, including dumps shifted by a few bytes and images that wrap round the end of a mirrored flash dump; zip and 7z archives are unpacked first, and every ROM in them is listed
- Raw NAND dumps that start with a four-entry partition table (Casio BE-300 and BE-500 `All_nand_*.bin`): each partition is read in turn, and one holding a whole-image LZSS stream (4 KB window, 3 to 18 byte matches) is expanded first, so the boot loader and the OS are both listed
- CE 1.0 and 1.01 (inline TOC names, LZW) and CE 2.0 to 6.0 (LZ with 1 KB or 4 KB blocks, LZX or XPRESS with 4 KB blocks); the compression is detected per ROM from the files' recorded sizes. CE 7 should read the same way but no CE 7 image has been tried
- Regions chained together (CE 4.2's kernel and XIP regions share a ROM extensions block) are shown as one ROM
- Modules are rebuilt as PE files; data directories pointing at sections romimage stripped are cleared
- Folders and shortcut copies come from the ROM's `initobj.dat`; shortcuts show their target's icon
- Icons and version information are read from each module's resources; an Icons tab shows every icon image a program or DLL holds
- Each file's Properties shows its SHA-256
- Previews: bitmaps (including 2 bpp `.2bp` files), text, HTML rendered with its images from the same ROM or package (no scripts, links within the page only), sounds, TrueType fonts and collections, bitmap fonts (`.fnt`, and `.fon` files including CE 1.01's paged ones), buzzer tunes (`.buz`) with playback, and registry files (REGEDIT4 scripts, CE 1.x RGDB hives and binary registry backups such as the BE-300's `Safe.reg`) as a key tree
- Properties show the ROM's CE version, CPU (from the ROM header, or from the kernel's code when it's not set), address ranges, build dates and copy entries, and for each module its sections, imports (named from the exporting DLL in the same ROM), exports and version
- Files holding several ROM images (boot loader and OS, for example) list each one
- Check app checks a program, DLL, CAB or installer against the open ROM: CPU family, CE version, and each imported DLL and function. Ordinal imports are named from the app's own SDK numbering, so functions the ROM numbers differently are reported as renumbered rather than missing; functions CEM Porter supplies (VELOCRT, CE1COMPAT, VELOSHIM, CE 1.0 renames) are marked as such. DLLs in the app's own package count as present
- A bar under the toolbar shows the ROM's CE version, CPU, module and file counts, sizes and kernel date
- Windows can be dragged by their title bars on desktop-sized screens
- Files with no readable ROM are described: blank, mostly blank, another format, compressed throughout, or naming CE files without a ROM table

## State Explorer

https://gadgetoid.github.io/cem-porter/state.html (`state.html`) lists the files and registry in a velo-emu or sh3emu saved state without running it, and saves them as a zip.

- Reads states and snapshots from velo-emu (`VELO1 STATE v2`) and sh3emu (`SH3ODO01`), gzip-compressed or not
- Finds the CE 1.0 to 2.12 object store in the saved DRAM (and the Velo's DRAM card) and rebuilds its folders and files, decompressing CE 1.0 LZW and CE 2.0 LZ chunks (1 KB or 4 KB blocks, detected per chunk)
- Registry from the object store on CE 2.x, or from `\Windows\Pegreg.reg` or `CEreg.reg` on CE 1.x; browsed in its own window and saved as a REGEDIT4 `.reg`
- Files get the same Properties and previews as in ROM Explorer
- State details show the emulator, save time, ROM hash, object store sections, object counts by type and the state's records
- Files in ROM aren't in a state, and databases are counted but not read

## CAB Maker

https://gadgetoid.github.io/cem-porter/cabs.html (`cabs.html`) gets the CAB you copy to the device out of a desktop installer, for any CPU and Windows CE version. Nothing is ported.

- Opens anything CEM Porter unpacks, including CD images and installers inside installers
- CE CABs are saved exactly as shipped, Authenticode signature included
- Programs that come as an H/PC Explorer `.load` script or loose files get a CAB built for their own CPU: MIPS, SH3, SH4 or StrongARM
- Built MIPS, SH3 and ARM programs also get a self-installing Setup .exe, which CE 1.0 needs
- Save one file or all of them as a zip

## Package Explorer

https://gadgetoid.github.io/cem-porter/package.html (`package.html`) shows everything inside an installer or archive and saves files exactly as stored.

- Opens anything CEM Porter unpacks, including installers inside installers; open `data1.cab` with `data1.hdr` and further volumes together
- Each container is a folder; Properties names its format, the container it came from and its SHA-256, and Save container saves it as stored
- CE CABs: files are named as they install, with the stored name (`FOO~1.001`) and install path in Properties. The CAB's folder and its `.000` setup file show the program, its files, the registry entries wceload writes and its shortcuts
- Files get the same Properties and previews as in ROM Explorer, with Open in Hex and Open in Icon Lab
- Saves a file, a folder as a zip, or everything as a zip: either every package unpacked, or the open folder with the packages in it kept whole

## Icon Lab

https://gadgetoid.github.io/cem-porter/icons.html (`icons.html`) replaces, adds or removes the icons in a Windows CE program.

- Opens an .exe, .dll or .cpl, or a CAB, zip or installer holding one; ROM Explorer's Open in Icon Lab sends a ROM module straight here
- New icons come from a .png, .gif, .jpg or .bmp, an .ico (including PNG-compressed images), or an icon in another program
- Builds 32x32 and 16x16 images in 4 greys (CE 1.0), 16 colours (Windows palette) or 256 colours (palette made from the picture), with an optional dither; pixels under half opaque become transparent. The source's own images are kept where they match a size and depth
- Previews each image on white, the CE desktop and grey
- Rebuilds the resource section with the new icons: in place when it fits or is the last section, otherwise as a new section at the end of the file (making room in the headers for it if needed)
- Saves the program, or the new icon as an .ico

## Font Converter

https://gadgetoid.github.io/cem-porter/fonts.html (`fonts.html`) converts a desktop font into a TrueType or bitmap font for Windows CE 1.0 and 2.0.

- Opens .ttf, .otf and .woff files, and zips of them such as Google Fonts downloads; variable fonts are set to a named instance or any axis values
- TrueType output keeps only the chosen characters and the tables CE's rasterizer uses (OS/2 version 1, Mac and Windows cmaps, post format 3, no hinting or OpenType layout), converts PostScript curves to TrueType ones, and can merge outline segments and use fewer units per em to make the file smaller
- Character sets: Windows code pages 1250 to 1253, WGL4 and a few Unicode blocks, plus any extra characters typed in
- Bitmap output is a version 2 .fnt per point size, laid out like the fonts in CE ROMs, drawn with the font's TrueType hinting and hinted widths (`hdmx`) where it has them, for code page 1250, 1251, 1252 or 1253
- Previews the result at real size
- Saves the font files, a CE 2.0 CAB, or a self-installing .exe for MIPS or SH3; both install to `\Windows\Fonts`, which CE 1.0 and 2.0 load fonts from at boot. Soft reset after installing

## Licence

MIT, see `LICENSE`. `vendor/fflate.js` is fflate 0.8.2 (MIT, `vendor/fflate-LICENSE`). `vendor/opentype.js` is opentype.js 2.0.0 (MIT, `vendor/opentype-LICENSE`). `vendor/cubic2quad.js` is cubic2quad 1.2.1 (MIT, `vendor/cubic2quad-LICENSE`), with its CommonJS exports changed to ES module exports. `vendor/serenity-icons` are icons from SerenityOS (BSD 2-Clause, `vendor/serenity-icons-LICENSE`).
