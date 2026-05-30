"""Generate the extension icon: a coral rounded tile with a cream usage gauge
whose live end is a green dot (echoes the 🟢 on-track dot in the status bar).
Drawn at 4x and downsampled for crisp anti-aliasing. Run: python media/make_icon.py
"""
import math
from PIL import Image, ImageDraw

S = 512  # supersample, final is 128
OUT = 128

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# ── rounded-square gradient background (Claude-ish coral) ──
top = (227, 138, 104)   # #E38A68
bot = (197, 92, 60)     # #C55C3C
bg = Image.new("RGB", (S, S))
bgd = ImageDraw.Draw(bg)
for y in range(S):
    t = y / (S - 1)
    r = round(top[0] + (bot[0] - top[0]) * t)
    g = round(top[1] + (bot[1] - top[1]) * t)
    b = round(top[2] + (bot[2] - top[2]) * t)
    bgd.line([(0, y), (S, y)], fill=(r, g, b))

radius = int(S * 0.235)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
img.paste(bg, (0, 0), mask)

# ── usage gauge ──
cx = cy = S // 2
R = int(S * 0.305)        # centreline radius
ring = int(S * 0.108)     # ring thickness
bbox = [cx - R, cy - R, cx + R, cy + R]

cream = (255, 248, 241, 255)
cream_track = (255, 248, 241, 70)
green = (62, 197, 112, 255)

START = 135            # bottom-left
SWEEP = 270            # open-bottom gauge
FILL = 0.70            # how much of the gauge is "used"
end_fg = START + SWEEP * FILL

# faint full track + solid filled portion
draw.arc(bbox, START, START + SWEEP, fill=cream_track, width=ring)
draw.arc(bbox, START, end_fg, fill=cream, width=ring)


def at(angle, rad, color, outline=None, ow=0):
    a = math.radians(angle)
    x = cx + R * math.cos(a)
    y = cy + R * math.sin(a)
    box = [x - rad, y - rad, x + rad, y + rad]
    draw.ellipse(box, fill=color, outline=outline, width=ow)


# rounded start cap
at(START, ring / 2, cream)
# live end = green dot, slightly larger with a soft dark rim for contrast
at(end_fg, ring * 0.66, (40, 60, 50, 90))   # shadow rim
at(end_fg, ring * 0.60, green)

icon = img.resize((OUT, OUT), Image.LANCZOS)
icon.save("media/icon.png")
# also a 256 variant for the README/marketplace gallery if needed
img.resize((256, 256), Image.LANCZOS).save("media/icon-256.png")
print("wrote media/icon.png (128) + media/icon-256.png")
