"""Home-screen icons for the hosted site: a price line with a buy and a sell marker, drawn inside the maskable safe zone."""
from PIL import Image, ImageDraw

SS = 2048  # draw large, then downscale for smooth edges
BG, GRID, INK, AVG, BUY, SELL = "#131B26", "#233041", "#E6ECF4", "#82A4FF", "#45C486", "#FF7D6E"


def P(x, y):
    return (x * SS, y * SS)


def tri(d, cx, cy, s, up, fill):
    h = s * 0.87
    pts = [P(cx, cy - h / 2), P(cx - s / 2, cy + h / 2), P(cx + s / 2, cy + h / 2)] if up else \
          [P(cx, cy + h / 2), P(cx - s / 2, cy - h / 2), P(cx + s / 2, cy - h / 2)]
    d.polygon(pts, fill=fill)


def draw():
    im = Image.new("RGB", (SS, SS), BG)
    d = ImageDraw.Draw(im)
    for y in (0.36, 0.50, 0.64):
        d.line([P(0.18, y), P(0.82, y)], fill=GRID, width=int(SS * 0.008))
    # dashed average line
    x = 0.20
    while x < 0.80:
        d.line([P(x, 0.585), P(min(x + 0.035, 0.80), 0.585)], fill=AVG, width=int(SS * 0.014))
        x += 0.06
    pts = [P(0.20, 0.68), P(0.33, 0.55), P(0.43, 0.61), P(0.56, 0.41), P(0.66, 0.48), P(0.80, 0.30)]
    w = int(SS * 0.045)
    d.line(pts, fill=INK, width=w, joint="curve")
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=INK)
    tri(d, 0.43, 0.735, 0.10, True, BUY)    # buy marker under the dip
    tri(d, 0.56, 0.285, 0.10, False, SELL)  # sell marker over the high
    return im


def write(out_dir):
    im = draw()
    for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
        im.resize((size, size), Image.LANCZOS).save(f"{out_dir}/{name}", optimize=True)


if __name__ == "__main__":
    import os
    os.makedirs("/home/claude/app/dist/site", exist_ok=True)
    write("/home/claude/app/dist/site")
    print("icons written")
