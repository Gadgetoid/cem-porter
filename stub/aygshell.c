#include <windows.h>
#include <velo/extras.h>

#define WORK_AREA_QUERY 48
#define SIP_INFO_SET 224
#define SIP_INFO_GET 225
#define DIALOG_SIZE 0x0002
#define DIALOG_FULL_SCREEN 0x0004
#define DIALOG_FULL_SCREEN_NO_MENU 0x0010
#define TORNADO_BITMAP 116
#define TORNADO_SIZE 16
#define TORNADO_WIDTH 22
#define FLOATING_TORNADO_HEIGHT 24
#define FULL_SCREEN_HIDE_TASKBAR 0x0002
#define FULL_SCREEN_HIDE_START_ICON 0x0020
#define TORNADO_TRANSPARENT RGB(255, 153, 0)
#define MAX_MENU_BAR_OWNERS 8
#define MENU_BAR_ENTRY_WORDS 7
#define NO_IMAGE 0xfffe
#define TOOLBAR_STYLE_DROPDOWN 0x0008
#define TOOLBAR_ADD_BUTTONS (WM_USER + 20)
#define BUTTON_IMAGE_SIZE 16
#define BUTTON_GAP 2
#define TOOLBAR_STYLE_SEPARATOR 0x0001

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
typedef int (*CommandBarAddBitmap)(HWND bar, HINSTANCE instance, int bitmap, int images, int width, int height);

typedef struct {
    int image;
    int command;
    BYTE state;
    BYTE style;
    BYTE reserved[2];
    DWORD data;
    int text;
} ToolbarButton;
typedef void (*InitControls)(void);
typedef BOOL (*MainMenuExec)(HWND window);

typedef struct {
    const WCHAR *name;
    const WCHAR *base;
    WNDPROC base_procedure;
} TooltipClass;

typedef struct {
    HWND window;
    WNDPROC procedure;
    int top;
} MenuBarOwner;

static CommandBarCreate command_bar_create;
static CommandBarInsertMenubar command_bar_insert_menubar;
static CommandBarAddBitmap command_bar_add_bitmap;
static BOOL command_bar_loaded;
static HINSTANCE shim_instance;
static BOOL tooltip_classes_registered;
static HBITMAP tornado_bitmap;
static MainMenuExec main_menu_exec;
static BOOL tornado_loaded;
static BOOL tornado_pressed;
static HWND floating_tornado;
static MenuBarOwner menu_bar_owners[MAX_MENU_BAR_OWNERS];
static UINT fit_message;

static LRESULT CALLBACK tooltip_button_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
static LRESULT CALLBACK tooltip_static_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
static LRESULT CALLBACK capitalising_edit_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam);

static TooltipClass tooltip_classes[] = {
    {L"TTBUTTON", L"BUTTON", 0},
    {L"TTSTATIC", L"STATIC", 0},
    {L"CAPEDIT", L"EDIT", 0},
};

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
    if (reason == DLL_PROCESS_ATTACH) shim_instance = instance;
    return TRUE;
}

static int tooltip_split(const WCHAR *text) {
    int index;
    if (!text) return -1;
    for (index = 0; text[index]; index++) {
        if (text[index] == L'~' && text[index + 1] == L'~') return index;
    }
    return -1;
}

static LRESULT tooltip_procedure(TooltipClass *tooltip, HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    WCHAR trimmed[128];
    const WCHAR *text;
    int split;
    LRESULT result;
    if (message == WM_SETTEXT) {
        text = (const WCHAR *)lparam;
        split = tooltip_split(text);
        if (split >= 0) {
            if (split >= (int)(sizeof(trimmed) / sizeof(trimmed[0]))) split = sizeof(trimmed) / sizeof(trimmed[0]) - 1;
            memcpy(trimmed, text, split * sizeof(WCHAR));
            trimmed[split] = 0;
            return CallWindowProcW(tooltip->base_procedure, window, message, wparam, (LPARAM)trimmed);
        }
    }
    result = CallWindowProcW(tooltip->base_procedure, window, message, wparam, lparam);
    if (message == WM_CREATE && result != -1) {
        text = ((CREATESTRUCTW *)lparam)->lpszName;
        if (tooltip_split(text) >= 0) SetWindowTextW(window, text);
    }
    return result;
}

static LRESULT CALLBACK tooltip_button_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    return tooltip_procedure(&tooltip_classes[0], window, message, wparam, lparam);
}

static LRESULT CALLBACK tooltip_static_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    return tooltip_procedure(&tooltip_classes[1], window, message, wparam, lparam);
}

static LRESULT CALLBACK capitalising_edit_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    WCHAR before[2];
    DWORD start = 0;
    if (message == WM_CHAR && wparam >= L'a' && wparam <= L'z') {
        SendMessageW(window, EM_GETSEL, (WPARAM)&start, 0);
        before[0] = L' ';
        if (start > 0) {
            WCHAR text[256];
            int length = GetWindowTextW(window, text, 256);
            if ((int)start <= length) before[0] = text[start - 1];
        }
        if (before[0] == L' ') wparam = wparam - L'a' + L'A';
    }
    return CallWindowProcW(tooltip_classes[2].base_procedure, window, message, wparam, lparam);
}

static void register_tooltip_classes(void) {
    WNDPROC procedures[] = {tooltip_button_procedure, tooltip_static_procedure, capitalising_edit_procedure};
    WNDCLASSW window_class;
    int index;
    if (tooltip_classes_registered) return;
    tooltip_classes_registered = TRUE;
    for (index = 0; index < (int)(sizeof(tooltip_classes) / sizeof(tooltip_classes[0])); index++) {
        if (!GetClassInfoW(0, tooltip_classes[index].base, &window_class)) continue;
        tooltip_classes[index].base_procedure = window_class.lpfnWndProc;
        window_class.lpfnWndProc = procedures[index];
        window_class.hInstance = shim_instance;
        window_class.lpszClassName = tooltip_classes[index].name;
        RegisterClassW(&window_class);
    }
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
    command_bar_add_bitmap = (CommandBarAddBitmap)GetProcAddressW(library, L"CommandBar_AddBitmap");
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

static void add_menu_bar_buttons(HWND bar, const MenuBarInfo *info) {
    HRSRC resource = FindResourceW(info->instance, MAKEINTRESOURCEW(info->toolbar), (LPCWSTR)RT_RCDATA);
    HGLOBAL loaded;
    const WORD *data;
    const WORD *entry;
    ToolbarButton button;
    int first_image = 0;
    int index;
    if (!resource) return;
    loaded = LoadResource(info->instance, resource);
    data = loaded ? (const WORD *)LockResource(loaded) : 0;
    if (!data) return;
    if (info->bitmap && info->bitmap_images && command_bar_add_bitmap) {
        first_image = command_bar_add_bitmap(bar, info->instance, info->bitmap, info->bitmap_images, BUTTON_IMAGE_SIZE, BUTTON_IMAGE_SIZE);
    }
    for (index = 0; index < data[1]; index++) {
        entry = data + 2 + index * MENU_BAR_ENTRY_WORDS;
        if ((entry[3] & TOOLBAR_STYLE_DROPDOWN) || entry[0] == NO_IMAGE) continue;
        memset(&button, 0, sizeof(button));
        button.image = BUTTON_GAP;
        button.style = TOOLBAR_STYLE_SEPARATOR;
        SendMessageW(bar, TOOLBAR_ADD_BUTTONS, 1, (LPARAM)&button);
        memset(&button, 0, sizeof(button));
        button.image = first_image + entry[0];
        button.command = entry[1];
        button.state = (BYTE)entry[2];
        button.style = (BYTE)entry[3];
        SendMessageW(bar, TOOLBAR_ADD_BUTTONS, 1, (LPARAM)&button);
    }
}

static HWND top_level_window(HWND window) {
    HWND owner;
    while (window && (GetWindowLongW(window, GWL_STYLE) & WS_CHILD)) window = GetParent(window);
    owner = window ? GetWindow(window, GW_OWNER) : 0;
    return owner ? owner : window;
}

static LRESULT CALLBACK menu_bar_host_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    HWND owner;
    switch (message) {
    case WM_COMMAND:
    case WM_NOTIFY:
    case WM_INITMENUPOPUP:
        owner = GetWindow(window, GW_OWNER);
        if (owner) return SendMessageW(owner, message, wparam, lparam);
        break;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static MenuBarOwner *find_menu_bar_owner(HWND window) {
    int index;
    for (index = 0; index < MAX_MENU_BAR_OWNERS; index++) {
        if (menu_bar_owners[index].window == window) return &menu_bar_owners[index];
    }
    return 0;
}

static LRESULT CALLBACK menu_bar_owner_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    MenuBarOwner *owner = find_menu_bar_owner(window);
    WNDPROC procedure = owner ? owner->procedure : 0;
    RECT area, bounds;
    LRESULT result;
    if (message == fit_message && fit_message && owner) {
        work_area(&area);
        GetWindowRect(window, &bounds);
        if (bounds.top != owner->top || bounds.bottom != area.bottom) MoveWindow(window, bounds.left, owner->top, bounds.right - bounds.left, area.bottom - owner->top, TRUE);
        return 0;
    }
    if (!procedure) return DefWindowProcW(window, message, wparam, lparam);
    result = CallWindowProcW(procedure, window, message, wparam, lparam);
    if (message == WM_DESTROY) owner->window = 0;
    return result;
}

static void make_room_below_bar(HWND window, const RECT *area, int bar_height) {
    MenuBarOwner *owner;
    RECT bounds;
    if (!window || !GetWindowRect(window, &bounds)) return;
    MoveWindow(window, bounds.left, area->top + bar_height, bounds.right - bounds.left, area->bottom - area->top, FALSE);
    if (!fit_message) fit_message = RegisterWindowMessageW(L"AygshellShimFitBelowMenuBar");
    if (!fit_message) return;
    owner = find_menu_bar_owner(window);
    if (!owner) {
        owner = find_menu_bar_owner(0);
        if (!owner) return;
        owner->procedure = (WNDPROC)GetWindowLongW(window, GWL_WNDPROC);
        owner->window = window;
        SetWindowLongW(window, GWL_WNDPROC, (LONG)menu_bar_owner_procedure);
    }
    owner->top = area->top + bar_height;
    PostMessageW(window, fit_message, 0, 0);
}

static BOOL register_menu_bar_host(void) {
    static BOOL registered;
    WNDCLASSW window_class;
    if (registered) return TRUE;
    memset(&window_class, 0, sizeof(window_class));
    window_class.lpfnWndProc = menu_bar_host_procedure;
    window_class.hInstance = shim_instance;
    window_class.hbrBackground = GetSysColorBrush(COLOR_BTNFACE);
    window_class.lpszClassName = L"MenuBarHost";
    registered = RegisterClassW(&window_class) != 0;
    return registered;
}

static void paint_tornado(HWND window) {
    PAINTSTRUCT paint;
    RECT area, button;
    HDC context = BeginPaint(window, &paint);
    int offset = tornado_pressed ? 1 : 0;
    GetClientRect(window, &area);
    FillRect(context, &area, GetSysColorBrush(COLOR_BTNFACE));
    button = area;
    InflateRect(&button, -1, -1);
    DrawFrameControl(context, &button, DFC_BUTTON, DFCS_BUTTONPUSH | (tornado_pressed ? DFCS_PUSHED : 0));
    TransparentImage(context, (area.right - TORNADO_SIZE) / 2 + offset, (area.bottom - TORNADO_SIZE) / 2 + offset, TORNADO_SIZE, TORNADO_SIZE, tornado_bitmap, 0, 0, TORNADO_SIZE, TORNADO_SIZE, TORNADO_TRANSPARENT);
    EndPaint(window, &paint);
}

static LRESULT CALLBACK tornado_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    RECT area;
    POINT point;
    HWND owner;
    switch (message) {
    case WM_PAINT:
        paint_tornado(window);
        return 0;
    case WM_LBUTTONDOWN:
        SetCapture(window);
        tornado_pressed = TRUE;
        InvalidateRect(window, 0, FALSE);
        return 0;
    case WM_LBUTTONUP:
        if (!tornado_pressed) return 0;
        ReleaseCapture();
        tornado_pressed = FALSE;
        InvalidateRect(window, 0, FALSE);
        GetClientRect(window, &area);
        point.x = (short)LOWORD(lparam);
        point.y = (short)HIWORD(lparam);
        if (PtInRect(&area, point)) {
            owner = top_level_window(window);
            SetWindowPos(owner, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            main_menu_exec(owner);
        }
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static BOOL tornado_ready(void) {
    static BOOL registered;
    WNDCLASSW window_class;
    HMODULE library;
    if (!tornado_loaded) {
        tornado_loaded = TRUE;
        library = LoadLibraryW(L"CSO.dll");
        if (library) tornado_bitmap = LoadBitmapW(library, MAKEINTRESOURCEW(TORNADO_BITMAP));
        library = LoadLibraryW(L"coshellapi.dll");
        if (library) main_menu_exec = (MainMenuExec)GetProcAddressW(library, L"CoshMainMenuExec");
    }
    if (!tornado_bitmap || !main_menu_exec) return FALSE;
    if (!registered) {
        memset(&window_class, 0, sizeof(window_class));
        window_class.lpfnWndProc = tornado_procedure;
        window_class.hInstance = shim_instance;
        window_class.lpszClassName = L"Tornado";
        registered = RegisterClassW(&window_class) != 0;
    }
    return registered;
}

static void add_tornado(HWND bar) {
    RECT area;
    if (!bar || !tornado_ready()) return;
    GetClientRect(bar, &area);
    CreateWindowExW(0, L"Tornado", L"", WS_CHILD | WS_VISIBLE, area.right - TORNADO_WIDTH, 0, TORNADO_WIDTH, area.bottom, bar, 0, shim_instance, 0);
}

static void add_floating_tornado(HWND owner) {
    if (!owner || floating_tornado || !tornado_ready()) return;
    floating_tornado = CreateWindowExW(0, L"Tornado", L"", WS_POPUP | WS_VISIBLE, GetSystemMetrics(SM_CXSCREEN) - TORNADO_WIDTH, 0, TORNADO_WIDTH, FLOATING_TORNADO_HEIGHT, owner, 0, shim_instance, 0);
}

HWND ayg_CommandBar_Create(HINSTANCE instance, HWND parent, int identifier) {
    HWND bar;
    load_command_bar();
    if (!command_bar_create) return 0;
    bar = command_bar_create(instance, parent, identifier);
    add_tornado(bar);
    return bar;
}

BOOL ayg_SHFullScreen(HWND window, DWORD state) {
    if (state & (FULL_SCREEN_HIDE_TASKBAR | FULL_SCREEN_HIDE_START_ICON)) add_floating_tornado(top_level_window(window));
    return TRUE;
}

BOOL ayg_SHCreateMenuBar(MenuBarInfo *info) {
    HWND host, bar;
    RECT area, bar_area;
    WORD menu;
    int height;
    if (!info) return FALSE;
    info->menu_bar = 0;
    load_command_bar();
    if (!command_bar_create || !register_menu_bar_host()) return TRUE;
    work_area(&area);
    host = CreateWindowExW(0, L"MenuBarHost", L"", WS_POPUP, area.left, area.top, area.right - area.left, 1, info->parent, 0, shim_instance, 0);
    if (!host) return TRUE;
    bar = command_bar_create(info->instance, host, 1);
    if (!bar) {
        DestroyWindow(host);
        return TRUE;
    }
    menu = menu_resource(info->instance, info->toolbar);
    if (menu && command_bar_insert_menubar) command_bar_insert_menubar(bar, info->instance, menu, 0);
    add_menu_bar_buttons(bar, info);
    GetWindowRect(bar, &bar_area);
    height = bar_area.bottom - bar_area.top;
    MoveWindow(host, area.left, area.top, area.right - area.left, height, FALSE);
    add_tornado(bar);
    ShowWindow(host, SW_SHOWNOACTIVATE);
    make_room_below_bar(info->parent, &area, height);
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

BOOL ayg_SHInitExtraControls(void) {
    register_tooltip_classes();
    return TRUE;
}

void ayg_SHFillRectClr(HDC context, const RECT *rect, COLORREF colour) {
    COLORREF previous = SetBkColor(context, colour);
    ExtTextOutW(context, 0, 0, ETO_OPAQUE, rect, 0, 0, 0);
    SetBkColor(context, previous);
}

BOOL ayg_succeed(void) {
    return TRUE;
}

DWORD ayg_unsupported(void) {
    return 0;
}
