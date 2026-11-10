#include <windows.h>

#define WORK_AREA_QUERY 48
#define SIP_INFO_SET 224
#define SIP_INFO_GET 225
#define DIALOG_SIZE 0x0002
#define DIALOG_FULL_SCREEN 0x0004
#define DIALOG_FULL_SCREEN_NO_MENU 0x0010

typedef struct {
    DWORD mask;
    HWND dialog;
    DWORD flags;
} DialogInit;

typedef struct {
    DWORD size;
    DWORD flags;
    RECT visible_desktop;
    RECT sip_rect;
    DWORD data_size;
    void *data;
} SipInfo;

typedef struct {
    DWORD size;
    HWND parent;
    DWORD flags;
    UINT toolbar;
    HINSTANCE instance;
    int bitmap;
    int bitmap_images;
    HWND menu_bar;
} MenuBarInfo;

typedef HWND (*CommandBarCreate)(HINSTANCE instance, HWND parent, int identifier);
typedef BOOL (*CommandBarInsertMenubar)(HWND bar, HINSTANCE instance, WORD menu, WORD button);
typedef void (*InitControls)(void);

static CommandBarCreate command_bar_create;
static CommandBarInsertMenubar command_bar_insert_menubar;
static BOOL command_bar_loaded;

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
    return TRUE;
}

static void work_area(RECT *area) {
    if (SystemParametersInfoW(WORK_AREA_QUERY, 0, area, 0)) return;
    area->left = 0;
    area->top = 0;
    area->right = GetSystemMetrics(SM_CXSCREEN);
    area->bottom = GetSystemMetrics(SM_CYSCREEN);
}

static void load_command_bar(void) {
    HMODULE library;
    InitControls init;
    if (command_bar_loaded) return;
    command_bar_loaded = TRUE;
    library = LoadLibraryW(L"commctrl.dll");
    if (!library) return;
    init = (InitControls)GetProcAddressW(library, L"InitCommonControls");
    if (init) init();
    command_bar_create = (CommandBarCreate)GetProcAddressW(library, L"CommandBar_Create");
    command_bar_insert_menubar = (CommandBarInsertMenubar)GetProcAddressW(library, L"CommandBar_InsertMenubar");
}

static WORD menu_resource(HINSTANCE instance, UINT toolbar) {
    HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(toolbar), (LPCWSTR)RT_RCDATA);
    HGLOBAL loaded;
    const WORD *data;
    if (!resource) return (WORD)toolbar;
    loaded = LoadResource(instance, resource);
    data = loaded ? (const WORD *)LockResource(loaded) : 0;
    return data ? data[0] : (WORD)toolbar;
}

BOOL ayg_SHCreateMenuBar(MenuBarInfo *info) {
    HWND bar;
    WORD menu;
    if (!info) return FALSE;
    info->menu_bar = 0;
    load_command_bar();
    if (!command_bar_create) return TRUE;
    bar = command_bar_create(info->instance, info->parent, 1);
    if (!bar) return TRUE;
    menu = menu_resource(info->instance, info->toolbar);
    if (menu && command_bar_insert_menubar) command_bar_insert_menubar(bar, info->instance, menu, 0);
    info->menu_bar = bar;
    return TRUE;
}

BOOL ayg_SHInitDialog(DialogInit *info) {
    RECT area;
    if (!info || !info->dialog) return FALSE;
    if (info->flags & (DIALOG_SIZE | DIALOG_FULL_SCREEN | DIALOG_FULL_SCREEN_NO_MENU)) {
        work_area(&area);
        MoveWindow(info->dialog, area.left, area.top, area.right - area.left, area.bottom - area.top, TRUE);
    }
    return TRUE;
}

BOOL ayg_SHSipInfo(UINT action, UINT parameter, void *value, UINT ini) {
    if (action == SIP_INFO_GET && value) {
        SipInfo *sip = (SipInfo *)value;
        sip->flags = 0;
        work_area(&sip->visible_desktop);
        sip->sip_rect.left = sip->sip_rect.top = sip->sip_rect.right = sip->sip_rect.bottom = 0;
        sip->data_size = 0;
        return TRUE;
    }
    if (action == SIP_INFO_SET) return TRUE;
    return SystemParametersInfoW(action, parameter, value, ini);
}

BOOL ayg_succeed(void) {
    return TRUE;
}

DWORD ayg_unsupported(void) {
    return 0;
}
