cmake_minimum_required(VERSION 3.20)
project(ceinstall C)
include(VeloCE)

velo_add_executable(ceinstall ceinstall.c)
velo_add_library(ce1compat ce1compat.c OUTPUT CE1COMPAT.DLL EXPORTS_FILE ce1compat-exports.txt)
