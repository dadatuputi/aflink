"""Capture the browser-tutorial screenshots (src/tutorial.pug) on Windows.

Page automation (Playwright) cannot see browser UI -- the address bar, its
context menu, the suggestion dropdown -- so this script drives the real
browser windows with OS-level input (pywinauto / UI Automation) and grabs the
screen with Pillow. Chrome's settings page is ordinary web UI, so that one is
taken with Playwright.

Meant for a GitHub-hosted windows runner (.github/workflows/tutorial-screenshots.yml),
which has an interactive desktop and Chrome, Edge and Firefox installed.

    python capture.py [--site https://aflink.us] [--out ../../src/includes/img]
                      [--debug debug/] [--only chrome,edge,firefox]
"""

import argparse
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from PIL import ImageDraw, ImageGrab
from playwright.sync_api import sync_playwright
from pywinauto import Desktop, keyboard, mouse

import demo as demo_gif

HIGHLIGHT = (0, 180, 230)     # the cyan box used in the original screenshots
WINDOW = (0, 0, 900, 640)     # x, y, w, h of every browser window: small, so
                              # each screenshot is the whole window with little padding
QUERY = "owa"                 # typed after engaging the search engine

args = None
theme = "light"               # the theme being captured; dark shots get a -dark suffix


def out(name):
    """Where screenshot `name` goes for the current theme."""
    return args.out / (f"{name}.png" if theme == "light" else f"{name}-{theme}.png")


def set_os_theme(dark):
    """Switch Windows between light and dark mode. Chrome, Edge and Firefox
    take their UI theme and the page's prefers-color-scheme from this, so a
    browser started afterwards shows the whole tutorial in that theme."""
    import ctypes
    import winreg
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                           r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
    for value in ("AppsUseLightTheme", "SystemUsesLightTheme"):
        winreg.SetValueEx(key, value, 0, winreg.REG_DWORD, 0 if dark else 1)
    winreg.CloseKey(key)
    HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x1A, 0x2
    ctypes.windll.user32.SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0,
                                             "ImmersiveColorSet", SMTO_ABORTIFHUNG, 5000, None)
    time.sleep(2)


def log(*a):
    print(*a, flush=True)


def debug_shot(name):
    if args.debug:
        ImageGrab.grab(all_screens=True).save(args.debug / f"{theme}-{name}.png")


def dump_tree(win, name):
    """Write the UIA tree of a window so failures can be diagnosed from CI."""
    if not args.debug:
        return
    lines = []
    for el in win.descendants():
        try:
            info = el.element_info
            lines.append(f"{info.control_type:<14} {info.name!r:<60} {info.automation_id!r} {el.rectangle()}")
        except Exception as e:  # elements vanish while we walk
            lines.append(f"<{e}>")
    (args.debug / f"{theme}-{name}.uia.txt").write_text("\n".join(lines), encoding="utf-8")


def wait_for(fn, timeout=10, what="element"):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            r = fn()
            if r:
                return r
        except Exception as e:
            last = e
        time.sleep(0.3)
    raise TimeoutError(f"timed out waiting for {what}" + (f" ({last})" if last else ""))


def browser_window(title_re):
    def find():
        for w in Desktop(backend="uia").windows():
            if re.search(title_re, w.window_text() or ""):
                return w
    return wait_for(find, 20, f"window /{title_re}/")


def place(win):
    import win32con
    import win32gui
    x, y, w, h = WINDOW
    win32gui.ShowWindow(win.handle, win32con.SW_RESTORE)
    win32gui.MoveWindow(win.handle, x, y, w, h, True)
    win.set_focus()
    time.sleep(0.5)


def address_bar(win):
    """Firefox's is a ComboBox 'urlbar-input'; Chrome/Edge an Edit named
    'Address and search bar'."""
    top = win.rectangle().top

    def find():
        for el in win.descendants():
            info = el.element_info
            if info.control_type not in ("Edit", "ComboBox"):
                continue
            if info.automation_id == "urlbar-input" or re.search(r"address", info.name or "", re.I):
                r = el.rectangle()
                if r.top - top < 150 and r.width() > 200:
                    return el
    return wait_for(find, 10, "address bar")


def menu_item(win, pattern):
    """Find a context-menu item, whether the menu is its own top-level window
    (Chrome, Edge) or a popup inside the browser window (Firefox)."""
    rx = re.compile(pattern, re.I)

    def find():
        roots = [win] + [w for w in Desktop(backend="uia").windows()
                         if w.element_info.control_type in ("Menu", "Pane", "Window")]
        for root in roots:
            for it in root.descendants(control_type="MenuItem"):
                if rx.search(it.window_text() or ""):
                    return it
    return wait_for(find, 8, f"menu item /{pattern}/")


def menu_rect(item):
    """Bounds of the menu an item belongs to, so the crop takes in all of it."""
    el = item
    for _ in range(4):
        el = el.parent()
        if el is None:
            return None
        if el.element_info.control_type == "Menu":
            r = el.rectangle()
            return rect_tuple(r) if r.width() > 0 else None
    return None


def center(r):
    return ((r.left + r.right) // 2, (r.top + r.bottom) // 2)


def frame(win):
    """The window's visible bounds. GetWindowRect (and UIA) include the
    invisible resize border Windows 10/11 draws around every window."""
    import ctypes
    from ctypes import wintypes
    r = wintypes.RECT()
    DWMWA_EXTENDED_FRAME_BOUNDS = 9
    ctypes.windll.dwmapi.DwmGetWindowAttribute(
        wintypes.HWND(win.handle), DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r))
    return (r.left, r.top, r.right, r.bottom)


def window_crop(win, *extra, margin=8):
    """The whole window, grown to take in anything (a menu) that spills out."""
    l, t, r, b = frame(win)
    for (el, et, er, eb) in extra:
        if el < l: l = el - margin
        if et < t: t = et - margin
        if er > r: r = er + margin
        if eb > b: b = eb + margin
    return (max(0, l), max(0, t), r, b)


def grab(path, crop, highlight=None, pad=4):
    """Screenshot the screen, box `highlight`, crop to `crop` (l, t, r, b)."""
    img = ImageGrab.grab(all_screens=True)
    if highlight is not None:
        l, t, r, b = highlight
        ImageDraw.Draw(img).rectangle((l - pad, t - pad, r + pad, b + pad), outline=HIGHLIGHT, width=4)
    img = img.crop(crop)
    img.save(path)
    log(f"  wrote {path} {img.size}")


def rect_tuple(r):
    return (r.left, r.top, r.right, r.bottom)


EXES = {
    "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "edge": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
}


class Session:
    """A browser the way a user would run it. Chrome and Edge are started
    directly and attached over CDP: launched by Playwright they carry its
    command-line flags and show an 'unsupported command-line flag' bar."""

    def __init__(self, p, name, profile):
        self.proc = None
        if name == "firefox":
            self.ctx = p.firefox.launch_persistent_context(
                profile, headless=False, no_viewport=True,
                # Playwright otherwise emulates a light page whatever the OS says
                color_scheme=theme,
                # and its Firefox keeps a light toolbar and menus; this is what
                # "System theme - auto" would pick
                firefox_user_prefs={
                    "ui.systemUsesDarkTheme": int(theme == "dark"),
                    "browser.theme.toolbar-theme": 0 if theme == "dark" else 1,
                    "browser.theme.content-theme": 0 if theme == "dark" else 1,
                })
            return
        self.proc = subprocess.Popen([
            EXES[name], f"--user-data-dir={profile}", "--remote-debugging-port=9222",
            "--no-first-run", "--no-default-browser-check", "about:blank"])
        browser = wait_for(lambda: p.chromium.connect_over_cdp("http://127.0.0.1:9222"), 30, "CDP")
        self.ctx = browser.contexts[0]

    def close(self):
        try:
            self.ctx.close()
        except Exception:
            pass
        if self.proc:
            self.proc.terminate()
            self.proc.wait(10)


def open_site(p, name, profile):
    ctx = Session(p, name, profile)
    page = ctx.ctx.pages[0] if ctx.ctx.pages else ctx.ctx.new_page()
    # Chrome and Edge give their frame the OS theme but not always the page
    # (seen on the runner), so set prefers-color-scheme explicitly
    page.emulate_media(color_scheme=theme)
    page.goto(args.site)
    page.wait_for_timeout(3000)   # let the browser fetch osdd.xml
    title = page.title()
    win = browser_window(re.escape(title))
    place(win)
    debug_shot(f"{name}-0-open")
    dump_tree(win, f"{name}-0-open")
    return ctx, page, win


def context_menu_shot(name, win, item_pattern, out):
    bar = address_bar(win)
    mouse.right_click(coords=center(bar.rectangle()))
    item = menu_item(win, item_pattern)
    debug_shot(f"{name}-menu")
    ir = rect_tuple(item.rectangle())
    grab(out, window_crop(win, menu_rect(item) or ir), highlight=ir)
    return item


def search_shot(name, win, out, keyword="aflink"):
    """Type the keyword, Tab into the engine, then a query; capture the dropdown."""
    bar = address_bar(win)
    br = bar.rectangle()
    mouse.click(coords=center(br))
    time.sleep(0.3)
    keyboard.send_keys("^a{BACKSPACE}")
    keyboard.send_keys(keyword, pause=0.08)
    time.sleep(1)
    debug_shot(f"{name}-typed")
    keyboard.send_keys("{TAB}")
    time.sleep(1)
    debug_shot(f"{name}-tabbed")
    keyboard.send_keys(QUERY, pause=0.08)
    time.sleep(2)
    debug_shot(f"{name}-query")
    dump_tree(win, f"{name}-query")
    grab(out, window_crop(win), highlight=rect_tuple(br))
    keyboard.send_keys("{ESC}{ESC}")


def chrome(p, profile):
    ctx, page, win = open_site(p, "chrome", profile)
    context_menu_shot("chrome", win, r"manage search engines", out("chrome-1"))
    keyboard.send_keys("{ESC}")

    # The settings page is web UI: Playwright can screenshot and click it.
    settings = ctx.ctx.new_page()
    settings.emulate_media(color_scheme=theme)
    settings.goto("chrome://settings/searchEngines")
    settings.wait_for_timeout(1500)
    host = re.sub(r"^https?://", "", args.site).rstrip("/")
    row = settings.locator("settings-search-engine-entry", has_text=host).first
    row.scroll_into_view_if_needed()
    settings.wait_for_timeout(500)
    # Shot from the screen like the others, so it shows the whole window. The
    # row is in the page, so the page draws its highlight itself.
    box = row.bounding_box()
    settings.evaluate("""([b, c]) => {
        const d = document.createElement('div');
        d.id = 'tutorial-highlight';
        Object.assign(d.style, {position: 'fixed', zIndex: 99999, pointerEvents: 'none',
            left: (b.x - 6) + 'px', top: (b.y - 4) + 'px',
            width: (b.width + 12) + 'px', height: (b.height + 8) + 'px',
            border: `4px solid rgb(${c})`, boxSizing: 'border-box'});
        document.body.appendChild(d);
    }""", [box, ",".join(map(str, HIGHLIGHT))])
    settings.wait_for_timeout(300)
    grab(out("chrome-2"), window_crop(win))
    settings.evaluate("document.getElementById('tutorial-highlight').remove()")
    row.get_by_role("button", name=re.compile("activate", re.I)).click()
    settings.wait_for_timeout(1000)
    debug_shot("chrome-activated")
    settings.close()

    page.bring_to_front()
    win.set_focus()
    search_shot("chrome", win, out("chrome-3"))
    ctx.close()


def edge(p, profile):
    ctx, page, win = open_site(p, "edge", profile)
    # Edge's keyword for a discovered engine is the host: 'aflink' + Tab
    # just autocompletes, 'aflink.us' + Tab engages it
    search_shot("edge", win, out("edge-1"), keyword="aflink.us")
    ctx.close()


def firefox(p, profile):
    ctx, page, win = open_site(p, "firefox", profile)
    item = context_menu_shot("firefox", win, r"add .*aflink", out("firefox-1"))
    item.click_input()   # actually add the engine for step 2
    time.sleep(1)
    debug_shot("firefox-added")
    search_shot("firefox", win, out("firefox-2"))
    ctx.close()


def demo(p, profile):
    """The README GIF shows the page in both themes itself, so it is recorded
    once, in the light pass."""
    if theme == "light":
        demo_gif.record(p, args.site, args.demo_out)


def main():
    global args, theme
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://aflink.us")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "src/includes/img")
    ap.add_argument("--debug", type=Path)
    ap.add_argument("--only", default="chrome,edge,firefox,demo")
    ap.add_argument("--demo-out", type=Path, default=Path(__file__).resolve().parents[2] / ".github/demo.gif")
    ap.add_argument("--themes", default="light,dark")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.debug:
        args.debug.mkdir(parents=True, exist_ok=True)

    log("screen", ImageGrab.grab(all_screens=True).size)
    failed = []
    with sync_playwright() as p:
        for theme in args.themes.split(","):
            set_os_theme(theme == "dark")
            for name in args.only.split(","):
                log(f"== {name} ({theme})")
                try:
                    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:
                        globals()[name](p, profile)
                except Exception:
                    traceback.print_exc()
                    debug_shot(f"{name}-FAILED")
                    failed.append(f"{name} ({theme})")
    if failed:
        log("FAILED:", ", ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
