#include <windows.h>

#define EVENT_SET_CODE 3
#define WORK_AREA_QUERY 48
#define SOUND_ALIAS 0x00010000
#define SOUND_FILENAME 0x00020000
#define SOUND_RESOURCE 0x00040004
#define SOUND_MEMORY 0x0004
#define WINDOW_MESSAGE_FIRST 0xC000
#define WINDOW_MESSAGE_COUNT 64
#define WINDOW_MESSAGE_NAME 64

BOOL WINAPI EventModify(HANDLE event, DWORD function);
BOOL WINAPI sndPlaySoundW(LPCWSTR sound, UINT flags);
HRSRC WINAPI FindResource(HMODULE module, LPCWSTR name, LPCWSTR type);
int _wcsicmp(const WCHAR *first, const WCHAR *second);
int wcscmp(const WCHAR *first, const WCHAR *second);

static WCHAR window_messages[WINDOW_MESSAGE_COUNT][WINDOW_MESSAGE_NAME];
static UINT window_message_count;

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
    return TRUE;
}

BOOL compat_SetDlgItemTextW(HWND dialog, int identifier, LPCWSTR text) {
    return SetWindowTextW(GetDlgItem(dialog, identifier), text);
}

UINT compat_GetDlgItemTextW(HWND dialog, int identifier, LPWSTR text, int length) {
    return (UINT)GetWindowTextW(GetDlgItem(dialog, identifier), text, length);
}

LRESULT compat_SendDlgItemMessageW(HWND dialog, int identifier, UINT message, WPARAM wparam, LPARAM lparam) {
    return SendMessageW(GetDlgItem(dialog, identifier), message, wparam, lparam);
}

HCURSOR compat_LoadCursorW(HINSTANCE instance, LPCWSTR name) {
    return 0;
}

int compat_lstrcmpW(LPCWSTR first, LPCWSTR second) {
    return wcscmp(first, second);
}

int compat_lstrcmpiW(LPCWSTR first, LPCWSTR second) {
    return _wcsicmp(first, second);
}

BOOL compat_SystemParametersInfoW(UINT action, UINT parameter, void *value, UINT ini) {
    if (action == WORK_AREA_QUERY && value) {
        RECT *area = (RECT *)value;
        area->left = 0;
        area->top = 0;
        area->right = GetSystemMetrics(SM_CXSCREEN);
        area->bottom = GetSystemMetrics(SM_CYSCREEN) - 26;
        return TRUE;
    }
    return FALSE;
}

HPEN compat_CreatePen(int style, int width, COLORREF color) {
    LOGPEN pen;
    pen.lopnStyle = (UINT)style;
    pen.lopnWidth.x = width;
    pen.lopnWidth.y = width;
    pen.lopnColor = color;
    return CreatePenIndirect(&pen);
}

BOOL compat_FlushInstructionCache(HANDLE process, const void *address, DWORD size) {
    return TRUE;
}

LPWSTR compat_CharNextW(LPCWSTR text) {
    return (LPWSTR)(*text ? text + 1 : text);
}

static WCHAR upper(WCHAR character) {
    if ((character >= 'a' && character <= 'z') || (character >= 0xE0 && character <= 0xFE && character != 0xF7)) return (WCHAR)(character - 32);
    return character;
}

LPWSTR compat_CharUpperW(LPWSTR text) {
    if (((DWORD)text >> 16) == 0) return (LPWSTR)(DWORD)upper((WCHAR)(DWORD)text);
    for (WCHAR *scan = text; *scan; scan++) *scan = upper(*scan);
    return text;
}

HANDLE compat_CreateMutexW(void *attributes, BOOL owned, LPCWSTR name) {
    return CreateEventW(0, FALSE, owned ? FALSE : TRUE, name);
}

BOOL compat_ReleaseMutex(HANDLE mutex) {
    return EventModify(mutex, EVENT_SET_CODE);
}

int compat_SetROP2(HDC dc, int mode) {
    return R2_COPYPEN;
}

BOOL compat_PlaySoundW(LPCWSTR sound, HMODULE module, DWORD flags) {
    UINT basic = (UINT)(flags & 0x1F);
    if (!sound) return sndPlaySoundW(0, basic);
    if ((flags & SOUND_RESOURCE) == SOUND_RESOURCE) {
        HRSRC resource = FindResource(module, sound, L"WAVE");
        HGLOBAL loaded = resource ? LoadResource(module, resource) : 0;
        if (!loaded) return FALSE;
        return sndPlaySoundW((LPCWSTR)loaded, (basic & ~SOUND_MEMORY) | SOUND_MEMORY);
    }
    return sndPlaySoundW(sound, basic);
}

DWORD compat_GetTempPathW(DWORD length, LPWSTR buffer) {
    static const WCHAR temp[] = L"\\Temp\\";
    DWORD needed = sizeof temp / sizeof temp[0];
    if (!buffer || length < needed) return needed;
    for (DWORD index = 0; index < needed; index++) buffer[index] = temp[index];
    CreateDirectoryW(L"\\Temp", 0);
    return needed - 1;
}

UINT compat_RegisterWindowMessageW(LPCWSTR name) {
    for (UINT index = 0; index < window_message_count; index++)
        if (!_wcsicmp(window_messages[index], name)) return WINDOW_MESSAGE_FIRST + index;
    if (window_message_count == WINDOW_MESSAGE_COUNT) return 0;
    WCHAR *slot = window_messages[window_message_count];
    int position = 0;
    while (name[position] && position < WINDOW_MESSAGE_NAME - 1) {
        slot[position] = name[position];
        position++;
    }
    slot[position] = 0;
    return WINDOW_MESSAGE_FIRST + window_message_count++;
}

BOOL compat_QueryPerformanceCounter(LARGE_INTEGER *counter) {
    counter->QuadPart = GetTickCount();
    return TRUE;
}

BOOL compat_QueryPerformanceFrequency(LARGE_INTEGER *frequency) {
    frequency->QuadPart = 1000;
    return TRUE;
}

static const WCHAR *module_path;

void compat_CePorterSetModulePath(const WCHAR *path) {
    module_path = path;
}

DWORD compat_GetModuleFileNameW(HMODULE module, LPWSTR buffer, DWORD length) {
    if (!buffer || !length) return 0;
    buffer[0] = 0;
    if (!module_path) return 0;
    DWORD count = 0;
    while (module_path[count] && count < length - 1) {
        buffer[count] = module_path[count];
        count++;
    }
    buffer[count] = 0;
    return count;
}

BOOL compat_UnmapViewOfFile(const void *address) {
    return LocalFree((HLOCAL)address) == 0;
}
