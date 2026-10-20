#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
toolchain=${VELO_TOOLCHAIN:?set VELO_TOOLCHAIN to a velo-toolchain checkout}
sh3_llvm=${VELO_SH3_LLVM:?set VELO_SH3_LLVM to an LLVM install with the SuperH backend}
cmake -S "$here" -B "$here/build/mips" -DCMAKE_TOOLCHAIN_FILE="$toolchain/cmake/velo-ce.cmake" -DVELO_CE_VERSION=1 > /dev/null
cmake --build "$here/build/mips" > /dev/null
cp "$here/build/mips/ceinstall.exe" "$here/build/mips/CE1COMPAT.DLL" "$root/data/mips/"
cmake -S "$here" -B "$here/build/sh3" -DCMAKE_TOOLCHAIN_FILE="$toolchain/cmake/velo-ce.cmake" -DVELO_CE_VERSION=1 -DVELO_ARCH=sh3 -DVELO_LLVM_ROOT="$sh3_llvm" > /dev/null
cmake --build "$here/build/sh3" > /dev/null
cp "$here/build/sh3/ceinstall.exe" "$here/build/sh3/CE1COMPAT.DLL" "$root/data/sh3/"
sed "s/=.*//" "$here/ce1compat-exports.txt" > "$root/data/ce1compat-exports.txt"
echo "wrote data/{mips,sh3}/ceinstall.exe and CE1COMPAT.DLL"
