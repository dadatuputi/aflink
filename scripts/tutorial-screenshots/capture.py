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
import sys
import tempfile
import time
import traceback
from pathlib import Path

from PIL import ImageDraw, ImageGrab
from playwright.sync_api import sync_playwright
from pywinauto import Desktop, keyboard, mouse

HIGHLIGHT = (0, 180, 230)     # the cyan box used in the original screenshots
WINDOW = (0, 0, 1100, 760)    # x, y, w, h of every browser window
QUERY = "owa"                 # typed after engaging the search engine

args = None


def log(*a):
    print(*a, flush=True)


def debug_shot(name):
    if args.debug:
        ImageGrab.grab(all_screens=True).save(args.debug / f"{name}.png")


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
    (args.debug / f"{name}.uia.txt").write_text("\n".join(lines), encoding="utf-8")


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
    """The top-most Edit control near the top of the window."""
    top = win.rectangle().top

    def find():
        edits = [e for e in win.descendants(control_type="Edit")
                 if e.rectangle().top - top < 150 and e.rectangle().width() > 200]
        return sorted(edits, key=lambda e: e.rectangle().top)[0] if edits else None
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


def center(r):
    return ((r.left + r.right) // 2, (r.top + r.bottom) // 2)


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


def launch(p, name, profile):
    common = dict(headless=False, no_viewport=True)
    if name == "firefox":
        return p.firefox.launch_persistent_context(profile, **common)
    return p.chromium.launch_persistent_context(
        profile, channel={"chrome": "chrome", "edge": "msedge"}[name],
        # without this Chrome shows a "controlled by automated software" bar
        ignore_default_args=["--enable-automation"],
        args=["--no-first-run", "--no-default-browser-check"], **common)


def open_site(p, name, profile):
    ctx = launch(p, name, profile)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
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
    ir = item.rectangle()
    wr = win.rectangle()
    crop = (wr.left, wr.top, min(wr.right, ir.right + 110), min(wr.bottom, ir.bottom + 170))
    grab(out, crop, highlight=rect_tuple(ir))
    return item


def search_shot(name, win, out):
    """Type 'aflink', Tab into the engine, then a query; capture the dropdown."""
    bar = address_bar(win)
    br = bar.rectangle()
    mouse.click(coords=center(br))
    time.sleep(0.3)
    keyboard.send_keys("^a{BACKSPACE}")
    keyboard.send_keys("aflink", pause=0.08)
    time.sleep(1)
    debug_shot(f"{name}-typed")
    keyboard.send_keys("{TAB}")
    time.sleep(1)
    debug_shot(f"{name}-tabbed")
    keyboard.send_keys(QUERY, pause=0.08)
    time.sleep(2)
    debug_shot(f"{name}-query")
    dump_tree(win, f"{name}-query")
    wr = win.rectangle()
    crop = (wr.left, wr.top, min(wr.right, br.left + 640), min(wr.bottom, br.bottom + 290))
    grab(out, crop, highlight=rect_tuple(br))
    keyboard.send_keys("{ESC}{ESC}")


def chrome(p, profile):
    ctx, page, win = open_site(p, "chrome", profile)
    context_menu_shot("chrome", win, r"manage search engines", args.out / "chrome-1.png")
    keyboard.send_keys("{ESC}")

    # The settings page is web UI: Playwright can screenshot and click it.
    settings = ctx.new_page()
    settings.goto("chrome://settings/searchEngines")
    settings.wait_for_timeout(1500)
    host = re.sub(r"^https?://", "", args.site).rstrip("/")
    row = settings.locator("settings-search-engine-entry", has_text=host).first
    row.scroll_into_view_if_needed()
    settings.wait_for_timeout(500)
    tmp = args.out / "chrome-2.png"
    settings.screenshot(path=str(tmp))
    box = row.bounding_box()
    from PIL import Image
    img = Image.open(tmp)
    l, t = int(box["x"]), int(box["y"])
    r, b = int(box["x"] + box["width"]), int(box["y"] + box["height"])
    ImageDraw.Draw(img).rectangle((l - 6, t - 4, r + 6, b + 4), outline=HIGHLIGHT, width=4)
    img.crop((0, max(0, t - 330), img.width, min(img.height, b + 40))).save(tmp)
    log(f"  wrote {tmp}")
    row.get_by_role("button", name=re.compile("activate", re.I)).click()
    settings.wait_for_timeout(1000)
    debug_shot("chrome-activated")
    settings.close()

    page.bring_to_front()
    win.set_focus()
    search_shot("chrome", win, args.out / "chrome-3.png")
    ctx.close()


def edge(p, profile):
    ctx, page, win = open_site(p, "edge", profile)
    search_shot("edge", win, args.out / "edge-1.png")
    ctx.close()


def firefox(p, profile):
    ctx, page, win = open_site(p, "firefox", profile)
    item = context_menu_shot("firefox", win, r"add .*aflink", args.out / "firefox-1.png")
    item.click_input()   # actually add the engine for step 2
    time.sleep(1)
    debug_shot("firefox-added")
    search_shot("firefox", win, args.out / "firefox-2.png")
    ctx.close()


def main():
    global args
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://aflink.us")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "src/includes/img")
    ap.add_argument("--debug", type=Path)
    ap.add_argument("--only", default="chrome,edge,firefox")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.debug:
        args.debug.mkdir(parents=True, exist_ok=True)

    log("screen", ImageGrab.grab(all_screens=True).size)
    failed = []
    with sync_playwright() as p:
        for name in args.only.split(","):
            log(f"== {name}")
            try:
                with tempfile.TemporaryDirectory() as profile:
                    globals()[name](p, profile)
            except Exception:
                traceback.print_exc()
                debug_shot(f"{name}-FAILED")
                failed.append(name)
    if failed:
        log("FAILED:", ", ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
