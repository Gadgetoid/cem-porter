#include <windows.h>

#define OP_MKDIR 1
#define OP_FILE 2
#define OP_SHORTCUT 3
#define OP_REGSZ 4
#define OP_REGMULTI 5
#define OP_RUN 6
#define OP_REGDWORD 8
#define OP_REGKEY 9
#define OP_REGBINARY 11
#define OP_SETUPDLL 12
#define SETUP_CANCEL 1
#define MAX_SETUP_DLLS 8
#define FILE_SHARED 1
#define FILE_MODULE_PATH 2
#define PATH_MARKER_LENGTH 8
#define PATH_LENGTH 260
#define MARKER_VALUE L"CEPorter"

typedef struct {
    DWORD kind;
    DWORD values[4];
} operation;

typedef struct {
    DWORD magic;
    DWORD version;
    DWORD title;
    DWORD operation_count;
    DWORD operations;
} payload_header;

volatile DWORD payload_location[4] = {0x4b504543, 0x4f4c4543, 0, 0};

static const BYTE *payload;
static const payload_header *header;
static const WCHAR *title;
static WCHAR marker_key[PATH_LENGTH];
static unsigned failures;
static WCHAR first_failure[PATH_LENGTH];

static int text_length(const WCHAR *text) {
    int length = 0;
    while (text[length]) length++;
    return length;
}

static WCHAR *append(WCHAR *destination, const WCHAR *source) {
    WCHAR *end = destination;
    while (*end) end++;
    while (*source && end - destination < PATH_LENGTH - 1) *end++ = *source++;
    *end = 0;
    return destination;
}

#define CARD_TOKEN L"%CARD%"
#define CARD_TOKEN_LENGTH 6
#define EXPANDED_BUFFERS 4

static WCHAR card_folder[PATH_LENGTH];
static WCHAR expanded[EXPANDED_BUFFERS][PATH_LENGTH];
static unsigned next_expanded;

static int starts_with_card(const WCHAR *text) {
    for (int index = 0; index < CARD_TOKEN_LENGTH; index++)
        if (text[index] != CARD_TOKEN[index]) return 0;
    return 1;
}

static const WCHAR *text_at(DWORD offset) {
    const WCHAR *text = (const WCHAR *)(payload + offset);
    if (!starts_with_card(text)) return text;
    WCHAR *buffer = expanded[next_expanded++ % EXPANDED_BUFFERS];
    buffer[0] = 0;
    append(append(buffer, card_folder), text + CARD_TOKEN_LENGTH);
    return buffer;
}

static int is_folder(const WCHAR *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != 0xFFFFFFFF && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static int find_card(void) {
    static const WCHAR *names[] = {L"\\Storage Card", L"\\PC Card"};
    for (int index = 0; index < 2; index++) {
        if (is_folder(names[index])) {
            card_folder[0] = 0;
            append(card_folder, names[index]);
            return 1;
        }
    }
    WIN32_FIND_DATAW found;
    HANDLE search = FindFirstFileW(L"\\*", &found);
    if (search == INVALID_HANDLE_VALUE) return 0;
    int ok = 0;
    do {
        if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && (found.dwFileAttributes & FILE_ATTRIBUTE_TEMPORARY)) {
            card_folder[0] = 0;
            append(append(card_folder, L"\\"), found.cFileName);
            ok = 1;
        }
    } while (!ok && FindNextFileW(search, &found));
    FindClose(search);
    return ok;
}

static int uses_card(void) {
    for (DWORD index = 0; index < header->operation_count; index++) {
        const operation *op = (const operation *)(payload + header->operations) + index;
        if ((op->kind == OP_MKDIR || op->kind == OP_FILE) && starts_with_card((const WCHAR *)(payload + op->values[0]))) return 1;
    }
    return 0;
}

static const operation *operation_at(DWORD index) {
    return (const operation *)(payload + header->operations) + index;
}

static void note_failure(const WCHAR *what, const WCHAR *path) {
    if (!failures++) {
        first_failure[0] = 0;
        append(append(append(first_failure, what), L" "), path);
    }
}

static int write_file(const WCHAR *path, const BYTE *data, DWORD length) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) return 0;
    DWORD written = 0;
    BOOL ok = WriteFile(file, data, length, &written, 0);
    CloseHandle(file);
    return ok && written == length;
}

static const BYTE path_marker[PATH_MARKER_LENGTH] = {'C', 'E', 'P', 'A', 'T', 'H', '0', '1'};

static DWORD find_path_marker(const BYTE *data, DWORD length) {
    for (DWORD offset = 0; offset + PATH_MARKER_LENGTH + PATH_LENGTH * sizeof(WCHAR) <= length; offset += 4) {
        DWORD index = 0;
        while (index < PATH_MARKER_LENGTH && data[offset + index] == path_marker[index]) index++;
        if (index == PATH_MARKER_LENGTH) return offset + PATH_MARKER_LENGTH;
    }
    return 0;
}

static int write_program(const WCHAR *path, const BYTE *data, DWORD length) {
    DWORD buffer_offset = find_path_marker(data, length);
    if (!buffer_offset) return write_file(path, data, length);
    WCHAR own_path[PATH_LENGTH];
    for (int index = 0; index < PATH_LENGTH; index++) own_path[index] = 0;
    for (int index = 0; path[index] && index < PATH_LENGTH - 1; index++) own_path[index] = path[index];
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) return 0;
    DWORD written = 0;
    DWORD total = 0;
    BOOL ok = WriteFile(file, data, buffer_offset, &written, 0);
    total += written;
    ok = ok && WriteFile(file, own_path, sizeof own_path, &written, 0);
    total += written;
    ok = ok && WriteFile(file, data + buffer_offset + sizeof own_path, length - buffer_offset - sizeof own_path, &written, 0);
    total += written;
    CloseHandle(file);
    return ok && total == length;
}

static int exists(const WCHAR *path) {
    return GetFileAttributesW(path) != 0xFFFFFFFF;
}

static int write_shortcut(const WCHAR *link, const WCHAR *target) {
    char contents[PATH_LENGTH + 16];
    int quoted = 0;
    for (int index = 0; target[index]; index++)
        if (target[index] == ' ') quoted = 1;
    if (target[0] == '"') quoted = 0;
    int length = text_length(target) + (quoted ? 2 : 0);
    int position = 0;
    if (length >= 100) contents[position++] = (char)('0' + length / 100);
    if (length >= 10) contents[position++] = (char)('0' + length / 10 % 10);
    contents[position++] = (char)('0' + length % 10);
    contents[position++] = '#';
    if (quoted) contents[position++] = '"';
    for (int index = 0; target[index] && position < PATH_LENGTH + 12; index++) contents[position++] = (char)target[index];
    if (quoted) contents[position++] = '"';
    return write_file(link, (const BYTE *)contents, (DWORD)position);
}

static HKEY open_key(DWORD root, const WCHAR *key_name) {
    HKEY key = 0;
    DWORD disposition = 0;
    if (RegCreateKeyExW((HKEY)root, key_name, 0, 0, 0, 0, 0, &key, &disposition) != ERROR_SUCCESS) return 0;
    return key;
}

static void set_value(const operation *op) {
    HKEY key = open_key(op->values[0], text_at(op->values[1]));
    if (!key) {
        note_failure(L"Could not open", text_at(op->values[1]));
        return;
    }
    const WCHAR *name = text_at(op->values[2]);
    if (op->kind == OP_REGDWORD) {
        DWORD number = op->values[3];
        RegSetValueExW(key, name, 0, REG_DWORD, (const BYTE *)&number, sizeof number);
    } else if (op->kind == OP_REGBINARY) {
        const BYTE *blob = payload + op->values[3];
        DWORD length = *(const DWORD *)blob;
        RegSetValueExW(key, name, 0, REG_BINARY, blob + 4, length);
    } else if (op->kind == OP_REGMULTI) {
        const WCHAR *value = text_at(op->values[3]);
        DWORD length = 0;
        while (value[length] || value[length + 1]) length++;
        RegSetValueExW(key, name, 0, REG_MULTI_SZ, (const BYTE *)value, (length + 2) * sizeof(WCHAR));
    } else {
        const WCHAR *value = text_at(op->values[3]);
        RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)value, (DWORD)(text_length(value) + 1) * sizeof(WCHAR));
    }
    RegCloseKey(key);
}

static void run_program(const WCHAR *program, const WCHAR *arguments) {
    PROCESS_INFORMATION process;
    if (CreateProcessW(program, (LPWSTR)arguments, 0, 0, FALSE, 0, 0, 0, 0, &process)) {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
}

typedef int (*install_init_function)(HWND, BOOL, BOOL, LPCWSTR);
typedef int (*install_exit_function)(HWND, LPCWSTR, WORD, WORD, WORD, WORD, WORD);
typedef int (*uninstall_init_function)(HWND, LPCWSTR);
typedef int (*uninstall_exit_function)(HWND);

static HMODULE setup_libraries[MAX_SETUP_DLLS];
static const operation *setup_operations[MAX_SETUP_DLLS];
static int setup_count;

static DWORD read32(const BYTE *data, DWORD offset) {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | ((DWORD)data[offset + 3] << 24);
}

static DWORD file_offset(const BYTE *image, DWORD rva) {
    DWORD header = read32(image, 0x3c);
    DWORD sections = header + 24 + (image[header + 20] | (image[header + 21] << 8));
    DWORD count = image[header + 6] | (image[header + 7] << 8);
    for (DWORD index = 0; index < count; index++) {
        DWORD entry = sections + 40 * index;
        DWORD virtual_size = read32(image, entry + 8);
        DWORD virtual_address = read32(image, entry + 12);
        DWORD raw_size = read32(image, entry + 16);
        DWORD extent = virtual_size > raw_size ? virtual_size : raw_size;
        if (rva >= virtual_address && rva < virtual_address + extent) return read32(image, entry + 20) + rva - virtual_address;
    }
    return 0;
}

static void ascii_to_wide(WCHAR *output, const BYTE *text, int capacity) {
    int index = 0;
    while (text[index] && index < capacity - 1) {
        output[index] = text[index];
        index++;
    }
    output[index] = 0;
}

static BYTE *loaded_base(HMODULE library, const BYTE *image) {
    DWORD optional = read32(image, 0x3c) + 24;
    DWORD export_offset = file_offset(image, read32(image, optional + 96));
    if (!export_offset) return 0;
    DWORD names = file_offset(image, read32(image, export_offset + 32));
    DWORD ordinals = file_offset(image, read32(image, export_offset + 36));
    DWORD functions = file_offset(image, read32(image, export_offset + 28));
    if (!read32(image, export_offset + 24) || !names || !ordinals || !functions) return 0;
    WCHAR name[64];
    ascii_to_wide(name, image + file_offset(image, read32(image, names)), 64);
    DWORD ordinal = image[ordinals] | (image[ordinals + 1] << 8);
    FARPROC address = GetProcAddressW(library, name);
    if (!address) return 0;
    return (BYTE *)address - read32(image, functions + 4 * ordinal);
}

static void bind_imports(HMODULE library, const BYTE *image) {
    BYTE *base = loaded_base(library, image);
    if (!base) return;
    DWORD optional = read32(image, 0x3c) + 24;
    DWORD descriptor = file_offset(image, read32(image, optional + 104));
    if (!descriptor) return;
    for (; read32(image, descriptor + 12); descriptor += 20) {
        WCHAR dll_name[64];
        ascii_to_wide(dll_name, image + file_offset(image, read32(image, descriptor + 12)), 64);
        HMODULE dll = LoadLibraryW(dll_name);
        if (!dll) continue;
        DWORD lookup = read32(image, descriptor) ? read32(image, descriptor) : read32(image, descriptor + 16);
        DWORD slots = read32(image, descriptor + 16);
        DWORD lookup_offset = file_offset(image, lookup);
        for (DWORD index = 0; lookup_offset && read32(image, lookup_offset + 4 * index); index++) {
            DWORD entry = read32(image, lookup_offset + 4 * index);
            FARPROC address;
            if (entry & 0x80000000) {
                address = GetProcAddressW(dll, (LPCWSTR)(entry & 0xFFFF));
            } else {
                WCHAR function_name[96];
                ascii_to_wide(function_name, image + file_offset(image, entry) + 2, 96);
                address = GetProcAddressW(dll, function_name);
            }
            if (address) *(FARPROC *)(base + slots + 4 * index) = address;
        }
    }
}

static void load_setup_dlls(int write) {
    setup_count = 0;
    for (DWORD index = 0; index < header->operation_count && setup_count < MAX_SETUP_DLLS; index++) {
        const operation *op = operation_at(index);
        if (op->kind != OP_SETUPDLL) continue;
        if (write && !write_file(text_at(op->values[0]), payload + op->values[1], op->values[2])) {
            note_failure(L"Could not write", text_at(op->values[0]));
            continue;
        }
        HMODULE library = LoadLibraryW(text_at(op->values[0]));
        if (!library) {
            note_failure(L"Could not load", text_at(op->values[0]));
            continue;
        }
        bind_imports(library, payload + op->values[1]);
        setup_libraries[setup_count] = library;
        setup_operations[setup_count] = op;
        setup_count++;
    }
}

static void free_setup_dlls(int remove_files) {
    for (int index = 0; index < setup_count; index++) {
        FreeLibrary(setup_libraries[index]);
        if (remove_files) DeleteFileW(text_at(setup_operations[index]->values[0]));
    }
    setup_count = 0;
}

static void remove_installed(void);

static int install(int previously_installed) {
    const operation *run = 0;
    load_setup_dlls(1);
    for (int index = 0; index < setup_count; index++) {
        install_init_function init = (install_init_function)GetProcAddressW(setup_libraries[index], L"Install_Init");
        if (init && init(0, TRUE, previously_installed, text_at(setup_operations[index]->values[3])) == SETUP_CANCEL) {
            free_setup_dlls(1);
            return 0;
        }
    }
    for (DWORD index = 0; index < header->operation_count; index++) {
        const operation *op = operation_at(index);
        switch (op->kind) {
        case OP_MKDIR:
            if (!exists(text_at(op->values[0])) && !CreateDirectoryW(text_at(op->values[0]), 0)) note_failure(L"Could not create", text_at(op->values[0]));
            break;
        case OP_FILE:
            if ((op->values[3] & FILE_SHARED) && exists(text_at(op->values[0]))) break;
            if ((op->values[3] & FILE_MODULE_PATH) ? !write_program(text_at(op->values[0]), payload + op->values[1], op->values[2]) : !write_file(text_at(op->values[0]), payload + op->values[1], op->values[2])) note_failure(L"Could not write", text_at(op->values[0]));
            break;
        case OP_SHORTCUT:
            if (!write_shortcut(text_at(op->values[0]), text_at(op->values[1]))) note_failure(L"Could not write", text_at(op->values[0]));
            break;
        case OP_REGKEY: {
            HKEY key = open_key(op->values[0], text_at(op->values[1]));
            if (key) RegCloseKey(key);
            break;
        }
        case OP_REGSZ:
        case OP_REGMULTI:
        case OP_REGDWORD:
        case OP_REGBINARY:
            set_value(op);
            break;
        case OP_RUN:
            run = op;
            break;
        }
    }
    HKEY key = open_key((DWORD)HKEY_LOCAL_MACHINE, marker_key);
    if (key) {
        DWORD one = 1;
        RegSetValueExW(key, MARKER_VALUE, 0, REG_DWORD, (const BYTE *)&one, sizeof one);
        RegCloseKey(key);
    }
    int undo = 0;
    for (int index = 0; index < setup_count; index++) {
        install_exit_function finish = (install_exit_function)GetProcAddressW(setup_libraries[index], L"Install_Exit");
        if (finish && finish(0, text_at(setup_operations[index]->values[3]), 0, 0, 0, 0, 0) == SETUP_CANCEL) undo = 1;
    }
    free_setup_dlls(0);
    if (undo) {
        remove_installed();
        return 0;
    }
    if (run && !failures) run_program(text_at(run->values[0]), text_at(run->values[1]));
    return 1;
}

static int begin_removal(void) {
    load_setup_dlls(0);
    for (int index = 0; index < setup_count; index++) {
        uninstall_init_function init = (uninstall_init_function)GetProcAddressW(setup_libraries[index], L"Uninstall_Init");
        if (init && init(0, text_at(setup_operations[index]->values[3])) == SETUP_CANCEL) {
            free_setup_dlls(0);
            return 0;
        }
    }
    return 1;
}

static void finish_removal(void) {
    for (int index = 0; index < setup_count; index++) {
        uninstall_exit_function finish = (uninstall_exit_function)GetProcAddressW(setup_libraries[index], L"Uninstall_Exit");
        if (finish) finish(0);
    }
    free_setup_dlls(1);
}

static void remove_installed(void) {
    for (DWORD count = header->operation_count; count > 0; count--) {
        const operation *op = operation_at(count - 1);
        switch (op->kind) {
        case OP_FILE:
            if (!(op->values[3] & FILE_SHARED)) DeleteFileW(text_at(op->values[0]));
            break;
        case OP_SHORTCUT:
            DeleteFileW(text_at(op->values[0]));
            break;
        case OP_MKDIR:
            RemoveDirectoryW(text_at(op->values[0]));
            break;
        case OP_REGSZ:
        case OP_REGMULTI:
        case OP_REGDWORD:
        case OP_REGBINARY: {
            HKEY key = 0;
            if (RegOpenKeyExW((HKEY)op->values[0], text_at(op->values[1]), 0, 0, &key) == ERROR_SUCCESS) {
                RegDeleteValueW(key, text_at(op->values[2]));
                RegCloseKey(key);
            }
            break;
        }
        }
    }
    HKEY key = 0;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, marker_key, 0, 0, &key) == ERROR_SUCCESS) {
        RegDeleteValueW(key, MARKER_VALUE);
        RegCloseKey(key);
    }
    RegDeleteKeyW(HKEY_LOCAL_MACHINE, marker_key);
}

static int installed(void) {
    HKEY key = 0;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, marker_key, 0, 0, &key) != ERROR_SUCCESS) return 0;
    DWORD type = 0;
    DWORD value = 0;
    DWORD size = sizeof value;
    LONG status = RegQueryValueExW(key, MARKER_VALUE, 0, &type, (BYTE *)&value, &size);
    RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

static int ask(const WCHAR *question) {
    WCHAR text[PATH_LENGTH];
    text[0] = 0;
    append(append(append(text, question), L" "), title);
    append(text, L"?");
    return MessageBoxW(0, text, title, MB_YESNO | MB_ICONQUESTION) == IDYES;
}

static void report(const WCHAR *done) {
    WCHAR text[PATH_LENGTH * 2];
    text[0] = 0;
    if (failures) {
        append(append(append(text, title), L": "), first_failure);
        MessageBoxW(0, text, title, MB_OK | MB_ICONERROR);
        return;
    }
    append(append(append(text, title), L" "), done);
    MessageBoxW(0, text, title, MB_OK | MB_ICONINFORMATION);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command_line, int show) {
    payload = (const BYTE *)payload_location[2];
    header = (const payload_header *)payload;
    if (!payload || header->magic != 0x4b504543) {
        MessageBoxW(0, L"This installer has no package attached.", L"Installer", MB_OK | MB_ICONERROR);
        return 1;
    }
    title = text_at(header->title);
    if (uses_card() && !find_card()) {
        MessageBoxW(0, L"Insert a storage card first: this program installs to it.", title, MB_OK | MB_ICONERROR);
        return 1;
    }
    marker_key[0] = 0;
    append(append(marker_key, L"Software\\CEPorter\\"), title);
    int quiet = command_line && command_line[0] == '/' && (command_line[1] == 'q' || command_line[1] == 'Q');
    if (installed() && !quiet) {
        if (ask(L"Remove")) {
            if (!begin_removal()) return 0;
            remove_installed();
            finish_removal();
            report(L"has been removed.");
            return 0;
        }
        if (!ask(L"Reinstall")) return 0;
    } else if (!quiet && !ask(L"Install")) {
        return 0;
    }
    int previously_installed = installed();
    if (!install(previously_installed)) {
        if (!quiet && failures) report(L"");
        return 1;
    }
    if (!quiet) report(L"has been installed.");
    return failures ? 1 : 0;
}
