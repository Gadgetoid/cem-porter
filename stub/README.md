# Stubs

CE 1.0 programs bundled by CEM Porter, built for MIPS and SH3 with velo-toolchain.

- `ceinstall.c`: the self-installer. The page appends the payload (files, registry steps, setup DLLs) as a `.cepk` section.
- `ce1compat.c`: `CE1COMPAT.DLL`, CE 2.0 functions for CE 1.0. Exports are listed in `ce1compat-exports.txt`.

## Building

```sh
VELO_TOOLCHAIN=/path/to/velo-toolchain VELO_SH3_LLVM=/path/to/llvm stub/build.sh
```

Writes `ceinstall.exe` and `CE1COMPAT.DLL` to `data/mips/` and `data/sh3/`, and the export list to `data/ce1compat-exports.txt`.

- `VELO_TOOLCHAIN`: velo-toolchain checkout
- `VELO_SH3_LLVM`: LLVM install with the SuperH backend
