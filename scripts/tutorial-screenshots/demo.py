"""Record the README demo GIF (.github/demo.gif): live search, then the theme
toggle. It only shows the page, so unlike the tutorial screenshots it needs
no browser UI and runs headless anywhere:

    python demo.py [--site https://aflink.us] [--out ../../.github/demo.gif]

capture.py runs it too, so the workflow refreshes it with the screenshots.
"""

import argparse
import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

# Recorded wide enough for the full navbar (it collapses below 992px) and
# scaled down to the GIF's size.
SIZE = {"width": 1000, "height": 700}
GIF_SIZE = (800, 560)
TYPE_MS = 100   # per keystroke
QUERY = "travel"


def record(p, site, out):
    browser = p.chromium.launch(channel="chrome" if sys.platform == "win32" else None)
    page = browser.new_page(viewport=SIZE, color_scheme="light")
    page.goto(site)
    page.wait_for_load_state("networkidle")
    frames = []

    def hold(ms):
        """One frame, shown for ms."""
        page.wait_for_timeout(80)   # let the filter and highlights settle
        shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB").resize(GIF_SIZE, Image.LANCZOS)
        frames.append((shot, ms))

    hold(900)                                 # the page as it loads
    page.click("#search-form")
    for i, ch in enumerate(QUERY, 1):         # the list filters as you type
        # real key presses: search.js filters on keyup/change, not on the
        # input event fill() would send
        page.keyboard.press(ch)
        hold(TYPE_MS if i < len(QUERY) else 1500)
    page.click("button[data-theme-choice=dark]")
    page.mouse.move(0, SIZE["height"] - 1)    # no hover state on the toggle
    hold(1800)
    page.click("button[data-theme-choice=light]")
    page.mouse.move(0, SIZE["height"] - 1)
    hold(900)
    browser.close()

    out.parent.mkdir(parents=True, exist_ok=True)
    first, *rest = [f.quantize(colors=256, method=Image.Quantize.MEDIANCUT) for f, _ in frames]
    first.save(out, save_all=True, append_images=rest, duration=[ms for _, ms in frames],
               loop=0, optimize=True)
    print(f"  wrote {out} ({len(frames)} frames, {out.stat().st_size // 1024} KB)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://aflink.us")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / ".github/demo.gif")
    args = ap.parse_args()
    with sync_playwright() as p:
        record(p, args.site, args.out)


if __name__ == "__main__":
    main()
