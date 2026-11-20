#include <windows.h>

#define STUB_COUNT 64
#define REAL_EXTENSION L".m16"
#define RELOCATION_HIGH 1
#define RELOCATION_LOW 2
#define RELOCATION_HIGHLOW 3
#define RELOCATION_HIGHADJ 4
#define RELOCATION_JUMP 5
#define RELOCATION_JUMP16 9
#define CACHE_SYNC_DISCARD 0x001
#define CACHE_SYNC_INSTRUCTIONS 0x002

typedef BOOL (WINAPI *DllEntry)(HINSTANCE instance, DWORD reason, void *reserved);

void WINAPI CacheSync(int flags);

void *mips16_targets[STUB_COUNT];

static BYTE *image;
static DllEntry image_entry;

#define STUB(number) \
    __asm__(".text\n" \
            ".globl stub" #number "\n" \
            ".ent stub" #number "\n" \
            "stub" #number ":\n" \
            ".set noreorder\n" \
            "lui $25, %hi(mips16_targets + " #number " * 4)\n" \
            "lw $25, %lo(mips16_targets + " #number " * 4)($25)\n" \
            "jr $25\n" \
            "nop\n" \
            ".set reorder\n" \
            ".end stub" #number "\n");

#define STUBS8(base) STUB(base##0) STUB(base##1) STUB(base##2) STUB(base##3) STUB(base##4) STUB(base##5) STUB(base##6) STUB(base##7)

STUB(0) STUB(1) STUB(2) STUB(3) STUB(4) STUB(5) STUB(6) STUB(7)
STUB(8) STUB(9)
STUBS8(1) STUB(18) STUB(19)
STUBS8(2) STUB(28) STUB(29)
STUBS8(3) STUB(38) STUB(39)
STUBS8(4) STUB(48) STUB(49)
STUBS8(5) STUB(58) STUB(59)
STUB(60) STUB(61) STUB(62) STUB(63)

static DWORD read32(const BYTE *at) {
    return at[0] | (at[1] << 8) | (at[2] << 16) | ((DWORD)at[3] << 24);
}

static WORD read16(const BYTE *at) {
    return (WORD)(at[0] | (at[1] << 8));
}

static void write32(BYTE *at, DWORD value) {
    at[0] = (BYTE)value;
    at[1] = (BYTE)(value >> 8);
    at[2] = (BYTE)(value >> 16);
    at[3] = (BYTE)(value >> 24);
}

static void write16(BYTE *at, WORD value) {
    at[0] = (BYTE)value;
    at[1] = (BYTE)(value >> 8);
}

static void widen(const char *text, WCHAR *wide, int size) {
    int index;
    for (index = 0; index < size - 1 && text[index]; index++) wide[index] = (BYTE)text[index];
    wide[index] = 0;
}

static void relocate_jump16(BYTE *at, LONG delta) {
    WORD first = read16(at);
    DWORD field = ((DWORD)(first & 0x1f) << 21) | ((DWORD)((first >> 5) & 0x1f) << 16) | read16(at + 2);
    WORD high;
    field = (field + (delta >> 2)) & 0x03ffffff;
    high = (WORD)(field >> 16);
    write16(at, (WORD)((first & 0xfc00) | ((high >> 5) & 0x1f) | ((high & 0x1f) << 5)));
    write16(at + 2, (WORD)field);
}

static BOOL relocate(BYTE *base, const IMAGE_NT_HEADERS *headers, LONG delta) {
    const IMAGE_DATA_DIRECTORY *directory = &headers->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];
    BYTE *block = base + directory->VirtualAddress;
    BYTE *end = block + directory->Size;
    if (!delta || !directory->VirtualAddress) return TRUE;
    while (block + 8 <= end) {
        DWORD page = read32(block);
        DWORD size = read32(block + 4);
        DWORD count;
        DWORD index;
        if (size < 8) break;
        count = (size - 8) / 2;
        for (index = 0; index < count; index++) {
            WORD entry = read16(block + 8 + index * 2);
            BYTE *at = base + page + (entry & 0xfff);
            LONG value;
            switch (entry >> 12) {
            case 0:
                break;
            case RELOCATION_HIGH:
                write16(at, (WORD)(read16(at) + (delta >> 16)));
                break;
            case RELOCATION_LOW:
                write16(at, (WORD)(read16(at) + delta));
                break;
            case RELOCATION_HIGHLOW:
                write32(at, read32(at) + delta);
                break;
            case RELOCATION_HIGHADJ:
                if (++index >= count) return FALSE;
                value = ((LONG)read16(at) << 16) + (SHORT)read16(block + 8 + index * 2) + delta;
                write16(at, (WORD)((value + 0x8000) >> 16));
                break;
            case RELOCATION_JUMP:
                value = read32(at);
                write32(at, (value & 0xfc000000) | ((value + (delta >> 2)) & 0x03ffffff));
                break;
            case RELOCATION_JUMP16:
                relocate_jump16(at, delta);
                break;
            default:
                return FALSE;
            }
        }
        block += size;
    }
    return TRUE;
}

static BOOL resolve_imports(BYTE *base, const IMAGE_NT_HEADERS *headers) {
    const IMAGE_DATA_DIRECTORY *directory = &headers->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    IMAGE_IMPORT_DESCRIPTOR *descriptor;
    WCHAR name[MAX_PATH];
    if (!directory->VirtualAddress) return TRUE;
    for (descriptor = (IMAGE_IMPORT_DESCRIPTOR *)(base + directory->VirtualAddress); descriptor->Name; descriptor++) {
        HMODULE module;
        BYTE *lookup;
        BYTE *address;
        widen((const char *)(base + descriptor->Name), name, MAX_PATH);
        module = LoadLibraryW(name);
        if (!module) return FALSE;
        lookup = base + (descriptor->OriginalFirstThunk ? descriptor->OriginalFirstThunk : descriptor->FirstThunk);
        address = base + descriptor->FirstThunk;
        for (; read32(lookup); lookup += 4, address += 4) {
            DWORD thunk = read32(lookup);
            FARPROC function;
            if (thunk & IMAGE_ORDINAL_FLAG) {
                function = GetProcAddressW(module, (LPCWSTR)(thunk & 0xffff));
            } else {
                widen((const char *)(base + thunk + 2), name, MAX_PATH);
                function = GetProcAddressW(module, name);
            }
            if (!function) return FALSE;
            write32(address, (DWORD)function);
        }
    }
    return TRUE;
}

static void fill_targets(BYTE *base, const IMAGE_NT_HEADERS *headers) {
    const IMAGE_DATA_DIRECTORY *directory = &headers->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    const IMAGE_EXPORT_DIRECTORY *exports;
    const BYTE *functions;
    DWORD index;
    if (!directory->VirtualAddress) return;
    exports = (const IMAGE_EXPORT_DIRECTORY *)(base + directory->VirtualAddress);
    functions = base + exports->AddressOfFunctions;
    for (index = 0; index < exports->NumberOfFunctions && index < STUB_COUNT; index++) {
        DWORD rva = read32(functions + index * 4);
        mips16_targets[index] = rva ? base + rva : 0;
    }
}

static BYTE *read_file(const WCHAR *path, DWORD *size) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
    BYTE *data;
    DWORD read = 0;
    if (file == INVALID_HANDLE_VALUE) return 0;
    *size = GetFileSize(file, 0);
    data = (BYTE *)LocalAlloc(LMEM_FIXED, *size);
    if (data && (!ReadFile(file, data, *size, &read, 0) || read != *size)) {
        LocalFree(data);
        data = 0;
    }
    CloseHandle(file);
    return data;
}

static BOOL load_real(HINSTANCE instance) {
    WCHAR path[MAX_PATH];
    int length = GetModuleFileNameW(instance, path, MAX_PATH);
    int dot;
    BYTE *file;
    DWORD file_size;
    const IMAGE_NT_HEADERS *headers;
    const IMAGE_SECTION_HEADER *section;
    int index;
    for (dot = length - 1; dot >= 0 && path[dot] != L'.' && path[dot] != L'\\'; dot--);
    if (dot < 0 || path[dot] != L'.' || dot + 5 > MAX_PATH) return FALSE;
    lstrcpyW(path + dot, REAL_EXTENSION);
    file = read_file(path, &file_size);
    if (!file) return FALSE;
    headers = (const IMAGE_NT_HEADERS *)(file + read32(file + 0x3c));
    image = (BYTE *)VirtualAlloc(0, headers->OptionalHeader.SizeOfImage, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    if (!image) {
        LocalFree(file);
        return FALSE;
    }
    memcpy(image, file, headers->OptionalHeader.SizeOfHeaders);
    section = IMAGE_FIRST_SECTION(headers);
    for (index = 0; index < headers->FileHeader.NumberOfSections; index++, section++) {
        DWORD size = section->SizeOfRawData < section->Misc.VirtualSize || !section->Misc.VirtualSize ? section->SizeOfRawData : section->Misc.VirtualSize;
        if (section->PointerToRawData && size) memcpy(image + section->VirtualAddress, file + section->PointerToRawData, size);
    }
    LocalFree(file);
    headers = (const IMAGE_NT_HEADERS *)(image + read32(image + 0x3c));
    if (!relocate(image, headers, (LONG)((DWORD)image - headers->OptionalHeader.ImageBase)) || !resolve_imports(image, headers)) {
        VirtualFree(image, 0, MEM_RELEASE);
        image = 0;
        return FALSE;
    }
    fill_targets(image, headers);
    CacheSync(CACHE_SYNC_DISCARD | CACHE_SYNC_INSTRUCTIONS);
    if (headers->OptionalHeader.AddressOfEntryPoint) {
        image_entry = (DllEntry)(image + headers->OptionalHeader.AddressOfEntryPoint);
        if (!image_entry((HINSTANCE)image, DLL_PROCESS_ATTACH, 0)) return FALSE;
    }
    return TRUE;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
    if (reason == DLL_PROCESS_ATTACH) return load_real(instance);
    if (image_entry) image_entry((HINSTANCE)image, reason, reserved);
    if (reason == DLL_PROCESS_DETACH && image) {
        VirtualFree(image, 0, MEM_RELEASE);
        image = 0;
    }
    return TRUE;
}
