"""Where the tests find things: the built page, fixtures, a scratch folder for outputs, and Chromium."""
import os, glob

TESTS = os.path.dirname(os.path.abspath(__file__))
DASH = os.path.dirname(TESTS)
REPO = os.path.dirname(DASH)
PAGE = os.path.join(DASH, "dist", "btc-paper-lab.html")
FIXTURES = os.path.join(TESTS, "fixtures")
OUT = os.environ.get("TEST_OUT", os.path.join(DASH, ".out"))
os.makedirs(OUT, exist_ok=True)
# Playwright's own Chromium when installed; else a preinstalled one (cloud sandboxes keep it under /opt/pw-browsers)
CHROMIUM = os.environ.get("CHROMIUM") or next(iter(sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))), None)


def launch(pw):
    return pw.chromium.launch(executable_path=CHROMIUM) if CHROMIUM else pw.chromium.launch()


def out(name):
    return os.path.join(OUT, name)
