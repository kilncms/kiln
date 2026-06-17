#!/bin/zsh
# Generate Kiln product-site art via gpt-image-2 (Codex OAuth, zero API cost).
# One shared lo-fi house style across all scenes; logo is a separate paper-craft prompt.
set -e
PY=~/.hermes/hermes-agent/venv/bin/python
SCRIPT=~/.aionui-config/skills/gpt-image-2-codex/scripts/generate_gpt_image2_codex.py
OUT="$(cd "$(dirname "$0")/../site/assets/img" && pwd)"

STYLE=" — Cozy lo-fi illustration, chillhop album-cover mood. Clean confident comic linework, flat muted colors, subtle paper-grain texture, soft late-afternoon light, calm warm human feeling. Restrained palette: dusty periwinkle-blue, muted sage green, warm bone and cream, soft charcoal ink, with a single warm terracotta-coral accent. No text, no letters, no numbers, no logos, no watermark anywhere."

gen () { # name aspect quality prompt
  local name="$1" aspect="$2" q="$3" prompt="$4"
  echo ">>> $name ($aspect/$q)"
  local res img
  res=$($PY $SCRIPT --prompt "$prompt" --aspect "$aspect" --quality "$q" 2>&1) || { echo "FAIL $name"; echo "$res" | tail -5; return 1; }
  img=$(echo "$res" | python3 -c "import sys,json;print(json.load(sys.stdin).get('image',''))" 2>/dev/null)
  if [ -z "$img" ]; then echo "FAIL $name (no image)"; echo "$res" | tail -8; return 1; fi
  cp "$img" "$OUT/$name.png"
  echo "OK  $OUT/$name.png  $(sips -g pixelWidth -g pixelHeight "$OUT/$name.png" 2>/dev/null | awk '/pixel/{printf $2" "}')"
}

# Hero: the satisfied maker who just finished building.
gen hero square high "A young creative person sitting cross-legged on a worn cozy couch with an open laptop, calm and content, soft headphones resting around their neck, a warm mug of coffee with a thin wisp of steam on a low wooden side table, leafy potted plants, a small framed landscape on a dusty periwinkle-blue wall, gentle afternoon light through a window. Relaxed, satisfied mood of someone who just finished building something. Generous negative space around the figure.$STYLE"

# Problem: the orphaned site you can't edit.
gen orphaned square medium "A laptop open on a small wooden desk in a quiet dim room at night, its screen showing a simple tidy webpage, the chair empty and pushed back, a cold half-full coffee mug and a sticky note beside it, one potted plant, cool blue moonlight. Still, slightly lonely mood of a finished project nobody can touch.$STYLE"

# Roles / handoff: hand them the keys.
gen handoff square medium "Two friendly people at a small wooden table in warm afternoon light, one calmly handing a single small brass key across an open laptop to the other, both relaxed and smiling slightly, coffee mugs and a leafy plant nearby. Warm, trusting, collaborative mood.$STYLE"

# Craft anchor: the kiln / ceramics, permanence and warmth.
gen craft square medium "A cozy corner of a home ceramics studio: a wooden shelf lined with handmade mugs and bowls in warm muted tones, a small pottery kiln glowing softly warm beside it, a potted trailing plant, late-afternoon light and gentle shadows. Calm, crafted, made-to-last feeling.$STYLE"

# Logo: faithful coral origami-paper K (white bg -> CSS multiply onto the cream page).
echo ">>> logo (square/high)"
LRES=$($PY $SCRIPT --aspect square --quality high --prompt "A single logo mark: the capital letter K folded from one sheet of warm coral-salmon paper, clean origami style, crisp visible folds creases and soft realistic shadows, tactile and handmade. Perfectly centered on a plain pure white seamless background, soft product-photography lighting, gentle contact shadow. Only the letter K, no other letters, words, numbers or marks." 2>&1) || true
LIMG=$(echo "$LRES" | python3 -c "import sys,json;print(json.load(sys.stdin).get('image',''))" 2>/dev/null)
if [ -n "$LIMG" ]; then cp "$LIMG" "$OUT/logo-k.png"; echo "OK  $OUT/logo-k.png"; else echo "FAIL logo"; echo "$LRES" | tail -8; fi

echo "=== DONE. Assets in $OUT ==="
ls -la "$OUT"
