from PIL import Image
import os
base="site/assets/img"
for name in ["hero","orphaned","handoff","craft"]:
    p=os.path.join(base,name+".png")
    im=Image.open(p).convert("RGB")
    w,h=im.size; m=1100
    if max(w,h)>m:
        s=m/max(w,h); im=im.resize((round(w*s),round(h*s)),Image.LANCZOS)
    out=os.path.join(base,name+".webp")
    im.save(out,"WEBP",quality=80,method=6)
    print(f"{name}.webp  {im.size}  {os.path.getsize(out)//1024}KB")
    os.remove(p)
lp=os.path.join(base,"logo-k.png")
im=Image.open(lp).convert("RGBA")
px=im.load(); W,H=im.size
for y in range(H):
    for x in range(W):
        r,g,b,a=px[x,y]; wn=min(r,g,b)
        if wn>=243: px[x,y]=(r,g,b,0)
        elif wn>=216: px[x,y]=(r,g,b,int(255*(243-wn)/27))
bbox=im.getchannel("A").getbbox()
if bbox:
    l,t,rr,bb=bbox; pad=14
    im=im.crop((max(0,l-pad),max(0,t-pad),min(W,rr+pad),min(H,bb+pad)))
s=360/max(im.size); im=im.resize((round(im.size[0]*s),round(im.size[1]*s)),Image.LANCZOS)
im.save(lp)
print(f"logo-k.png transparent {im.size} {os.path.getsize(lp)//1024}KB")
