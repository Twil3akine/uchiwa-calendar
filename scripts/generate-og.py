"""Regenerate public/og.png: python scripts/generate-og.py /path/to/Japanese-font.otf

Requires Pillow. Artwork uses the application's existing palette and calendar mark.
Font used for the checked-in PNG: Noto Sans CJK JP (SIL Open Font License).
https://github.com/notofonts/noto-cjk
"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 2
font_path = sys.argv[1]
image = Image.new("RGB", (1200*S, 630*S), "#F7F4EF")
draw = ImageDraw.Draw(image)

def rect(box, fill, radius=0, outline=None, width=1):
    draw.rounded_rectangle(tuple(int(v*S) for v in box), radius=radius*S, fill=fill, outline=outline, width=width*S)

def text(x, y, value, size, color="#292B26", bold=False):
    draw.text((x*S,y*S), value, font=ImageFont.truetype(font_path, size*S), fill=color, stroke_width=S if bold else 0, stroke_fill=color)

rect((24,24,1176,606), "#F7F4EF", 28, "#E6E0D6")
rect((78,76,138,136), "#BB664A", 18)
rect((91,94,125,121), None, 5, "#FFFDF8", 2)
draw.line([(92*S,102*S),(124*S,102*S)],fill="#FFFDF8",width=2*S)
for x in (99,117): draw.line([(x*S,88*S),(x*S,98*S)],fill="#FFFDF8",width=3*S)
for x in (99,108,117): draw.ellipse(((x-2)*S,109*S,(x+2)*S,113*S),fill="#FFFDF8")
text(157,88,"うちわカレンダー",23)
text(78,220,"うちわカレンダー",64,bold=True)
text(82,325,"みんなの予定を、ひとつに。",30,"#6A6259")
text(83,393,"URLで集まる、終日の共有カレンダー。",20,"#8C8277")
rect((82,475,310,519),"#EEDDD2",22)
text(106,483,"アカウント登録なし",18,"#9C523D")

# An illustrative calendar; no member names, real dates or group data.
shadow = Image.new("RGBA", image.size)
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle((772*S,114*S,1122*S,526*S),radius=26*S,fill=(100,75,50,24))
image = Image.alpha_composite(image.convert("RGBA"),shadow.filter(ImageFilter.GaussianBlur(18*S)))
draw = ImageDraw.Draw(image)
rect((758,101,1110,513),"#FFFDF9",24,"#E6E0D6")
text(788,130,"みんなのカレンダー",22,bold=True)
for i, day in enumerate("日月火水木金土"):
    text(786+i*43,195,day,15,"#BB664A" if i==0 else "#8E9388")
for row in range(4):
    for col in range(7):
        text(788+col*43,236+row*55,str(row*7+col+1),15,"#9D9A90")
rect((780,274,1069,293),"#E8B99F",5)
rect((823,329,1069,348),"#CDDACB",5)
rect((780,384,937,403),"#CEDCEC",5)
rect((995,384,1069,403),"#E8B99F",5)
text(788,452,"それぞれの色で、予定を共有。",16,"#8C8277")
output=Path(__file__).resolve().parent.parent/"public/og.png"
image.convert("RGB").resize((1200,630),Image.Resampling.LANCZOS).save(output,optimize=True)
print(output)
