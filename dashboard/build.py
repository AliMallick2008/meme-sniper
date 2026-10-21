"""Build the dashboard: one self-contained HTML page (inline CSS, JS and data), plus the hosted version for GitHub Pages
or Netlify (index.html, web-app manifest and icons, also zipped). The Meme Sniper engine and bot core are read from
../server/, the same files the 24/7 server runs, so the page and the server can never drift apart.
Usage: python3 dashboard/build.py   (output in dashboard/dist/)"""
import json, os, re, zipfile

D = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(D), "server")
OUT = os.path.join(D, "dist")
rd = lambda *p: open(os.path.join(*p), encoding="utf-8").read()

page = rd(D, "page.html")
css = rd(D, "style.css")
engine = rd(D, "engine.js") + "\n" + rd(D, "meme.js")
ui = rd(D, "ui.js")
research = json.dumps(json.load(open(os.path.join(D, "research.json"))), separators=(",", ":"))
lwc = rd(D, "vendor", "lightweight-charts.standalone.production.js")
sniper = (rd(SERVER, "sniper.js") + "\n" + rd(SERVER, "sniper_core.js") + "\n" + rd(D, "sniper_ui.js") +
          "\nSNIPER_UI.start();\nif (!document.getElementById('p-sniper').hidden) SNIPER_UI.onShow();\n")

out = (page.replace("/*__CSS__*/", css).replace("/*__LWC__*/", lwc).replace("/*__ENGINE__*/", engine)
       .replace("/*__RESEARCH__*/", research).replace("/*__UI__*/", ui).replace("/*__SNIPER__*/", sniper))
assert "</script" not in engine and "</script" not in ui and "</script" not in sniper and "</script" not in lwc
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "btc-paper-lab.html"), "w", encoding="utf-8").write(out)

# hosted build (phone link): same page plus a home-screen icon and web-app manifest
from make_icons import write as write_icons
SITE = os.path.join(OUT, "site")
os.makedirs(SITE, exist_ok=True)
head_extra = ('<link rel="manifest" href="manifest.webmanifest">\n'
              '<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">\n'
              '<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
              '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">\n'
              '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#131B26">\n'
              '<meta name="mobile-web-app-capable" content="yes">\n'
              '<meta name="apple-mobile-web-app-capable" content="yes">\n'
              '<meta name="apple-mobile-web-app-title" content="BTC Lab">\n')
site = out.replace("<title>BTC Paper Lab</title>\n", "<title>BTC Paper Lab</title>\n" + head_extra, 1)
assert site != out
open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(site)
manifest = {"name": "BTC Paper Lab", "short_name": "BTC Lab", "start_url": "./", "scope": "./", "display": "standalone",
            "background_color": "#0B1119", "theme_color": "#131B26",
            "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                      {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                      {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}
json.dump(manifest, open(os.path.join(SITE, "manifest.webmanifest"), "w"), indent=2)
write_icons(SITE)
open(os.path.join(SITE, ".nojekyll"), "w").close()
SITE_FILES = ["index.html", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]
with zipfile.ZipFile(os.path.join(OUT, "btc-paper-lab-site.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    for f in SITE_FILES:
        z.write(os.path.join(SITE, f), f)   # files at the ZIP root so Netlify serves index.html at the site root

# scripts for syntax checks: node --check dashboard/dist/_s*.js
scripts = re.findall(r"<script>(.*?)</script>", out, flags=re.S)
for i, sc in enumerate(scripts):
    open(os.path.join(OUT, f"_s{i}.js"), "w", encoding="utf-8").write(sc)
print("built", len(out), "bytes;", len(scripts), "scripts")
