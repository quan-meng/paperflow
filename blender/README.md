# Parametric "cage" shoe — Vivobarefoot Primus Trail Knit FG

`shoe_cage.py` builds a 3D model of the grey Vivobarefoot Primus Trail Knit FG
barefoot trail shoe shown in the reference photo, then renders it as a studio
side-profile product shot.

## What "cage parametric representation" means here

Every part of the shoe is generated as a **coarse, low-poly control cage** —
a quad mesh built procedurally from a handful of parametric profile curves —
and then turned into its final smooth surface by a **Catmull-Clark
Subdivision-Surface modifier**. The cage + subsurf pair *is* the parametric
representation: edit a control point in the profile tables and the whole
smooth shoe re-derives. Nothing is sculpted by hand.

The shape is driven by a few 1-D parametric profiles over the normalised shoe
length `xn ∈ [0,1]` (heel → toe):

| profile | role |
|---|---|
| `HALFW`  | footprint half-width (anatomical wide toe box) |
| `DOMEH`  | upper dome height above the sole |
| `sole_bot` / `sole_thick` | sole bottom line (toe-spring, heel rocker) + thickness |
| `throat_valley` | smooth scoop of the topline through the lace throat |
| `end_taper` | rounds the heel/toe caps of the closed loft |

## Components (each a cage + subsurf)

- **Upper** – a closed-tube loft of cross-section rings; rounded heel/toe caps;
  the ankle/lace opening is carved by a smooth Boolean cutter (clean dark
  recess, no staircase). Toe bumper and heel counter are flush rubber regions
  painted by per-face material assignment.
- **Sole** – closed-ring loft with a crowned top and walls.
- **Lugs** – an array of bevelled tread blocks sunk into the sole.
- **Side decal** – a thin TPU swoosh hugging the flank, carrying the
  `VIVOBAREFOOT / PRIMUS TRAIL / HEX GROUND` wordmark and the double-hexagon
  logo (Blender text + skinned hex wire).
- **Speed-laces** – bevelled-curve bungee zig-zag gathered into a cord-lock
  toggle with two loose tails.
- **Pull tab** – a flat webbing loop standing off the heel collar.

## Rendering

Studio set: white seamless sweep backdrop, four soft area lights, an
orthographic side camera (toe to the right, lateral logo side to camera),
Cycles with the Standard view transform.

```bash
python3 blender/shoe_cage.py            # final: 1200px, 220 samples -> shoe_render.png
python3 blender/shoe_cage.py --quick    # preview: 1080px, 24 samples -> shoe_preview.png
# or inside Blender:
blender --background --python blender/shoe_cage.py
```

Requires the `bpy` module (`pip install bpy`, Blender 4.x/5.x) or a Blender
install. `shoe_render.png` is the committed result.
