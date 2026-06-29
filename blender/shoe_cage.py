"""
Vivobarefoot Primus Trail Knit FG  —  parametric "cage" representation.

Every component of the shoe is generated as a COARSE control cage (a low-poly
quad mesh built from a handful of parametric profile curves) and then turned
into its final smooth surface by a Catmull-Clark Subdivision-Surface modifier.
The cage + subsurf pair *is* the parametric representation: change a profile
control point and the whole smooth shoe updates.

Run headless with the pip `bpy` module:
    python3 blender/shoe_cage.py            # builds + renders
or inside Blender:
    blender --background --python blender/shoe_cage.py

Coordinate frame:  +X = heel->toe (length),  +Y = width,  +Z = up.
The lateral (logo) side faces the camera, toe pointing right, like the photo.
"""

import bpy
import bmesh
import math
import os
import numpy as np
from mathutils import Vector

# --------------------------------------------------------------------------- #
#  Global dimensions (metres) — a UK ~9 barefoot last
# --------------------------------------------------------------------------- #
L = 0.285                      # overall length, heel tip -> toe tip
OUT_DIR = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------- #
#  Small helpers
# --------------------------------------------------------------------------- #
def interp(t, pts):
    """Linear interp of control points [(x,val), ...] at parameter t."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return float(np.interp(t, xs, ys))


def smoothstep(a, b, x):
    if b == a:
        return 0.0
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def new_obj(name, verts, faces, col=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    (col or bpy.context.scene.collection).objects.link(ob)
    return ob


def shade_smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


def add_subsurf(ob, view=2, render=3):
    m = ob.modifiers.new("subsurf", "SUBSURF")
    m.levels = view
    m.render_levels = render
    return m


def add_solidify(ob, thickness, offset=-1.0, rim_mat=0):
    m = ob.modifiers.new("solid", "SOLIDIFY")
    m.thickness = thickness
    m.offset = offset
    m.use_rim = True
    m.material_offset_rim = rim_mat
    return m


# --------------------------------------------------------------------------- #
#  Parametric profiles that define the last
# --------------------------------------------------------------------------- #
# half width of the footprint as a function of normalised length xn in [0,1]
HALFW = [
    (0.00, 0.020), (0.03, 0.030), (0.08, 0.035), (0.16, 0.039),
    (0.30, 0.044), (0.46, 0.049), (0.62, 0.053), (0.74, 0.054),
    (0.84, 0.052), (0.92, 0.045), (0.97, 0.034), (1.00, 0.022),
]
# height of the upper dome above the sole top
DOMEH = [
    (0.00, 0.086), (0.06, 0.100), (0.13, 0.104), (0.22, 0.101),
    (0.34, 0.097), (0.46, 0.093), (0.58, 0.089), (0.70, 0.082),
    (0.80, 0.071), (0.88, 0.057), (0.94, 0.040), (1.00, 0.022),
]
# sole bottom line (gentle toe-spring + heel rocker — barefoot last is flat)
def sole_bot(xn):
    z = 0.0
    if xn > 0.82:                       # mild toe spring up
        z += 0.013 * ((xn - 0.82) / 0.18) ** 1.7
    if xn < 0.06:                       # mild heel rocker
        z += 0.006 * ((0.06 - xn) / 0.06) ** 2
    return z


def sole_thick(xn):
    return interp(xn, [(0.0, 0.018), (0.1, 0.016), (0.5, 0.014),
                       (0.85, 0.012), (1.0, 0.010)])


def sole_top(xn):
    return sole_bot(xn) + sole_thick(xn)


def halfw(xn):
    return interp(xn, HALFW)


def domeh(xn):
    return interp(xn, DOMEH)


# the topline scoops down through the instep/lace throat: a smooth valley
# along the apex of the dome (no jagged carving — pure vertex displacement).
def throat_valley(xn, s):
    if xn < 0.06 or xn > 0.52:
        return 0.0
    back = smoothstep(0.06, 0.14, xn)
    front = 1.0 - smoothstep(0.34, 0.52, xn)
    depth = 0.030 * back * front
    # only affect the central top of the arch
    lat = max(0.0, 1.0 - (s / 0.62) ** 2)
    return depth * lat


# --------------------------------------------------------------------------- #
#  UPPER  (knitted sock)  — open dome cage, hole cut for the collar
# --------------------------------------------------------------------------- #
def end_taper(xn):
    """Shrinks the cross-section near the very heel/toe so the closed loft
    caps round over instead of ending in a vertical cliff."""
    return min(smoothstep(0.0, 0.05, xn), 1.0 - smoothstep(0.95, 1.0, xn))


KTOP = 17                                # ring samples over the top arc
KBOT = 13                                # ring samples along the footbed
NV = KTOP + KBOT                          # closed-loop ring resolution


def upper_ring(xn):
    """Closed cross-section loop: top dome arc (medial->lateral) then footbed
    back (lateral->medial)."""
    w = halfw(xn)
    h = domeh(xn)
    st = sole_top(xn)
    taper = 0.18 + 0.82 * end_taper(xn)
    w *= (0.30 + 0.70 * end_taper(xn)) if end_taper(xn) < 1 else 1.0
    h *= taper
    ring = []
    for j in range(KTOP):                # top arc, s: -1 -> +1
        s = -1.0 + 2.0 * j / (KTOP - 1)
        y = w * s
        z = st + h * (1.0 - abs(s) ** 1.9) ** 0.8
        z -= throat_valley(xn, s)        # scoop the instep / lace throat
        ring.append((xn * L, y, z))
    for j in range(1, KBOT + 1):         # footbed, s: +1 -> -1 (skip shared ends)
        s = 1.0 - 2.0 * j / (KBOT + 1)
        y = w * s
        z = st - 0.004 * (1.0 - abs(s) ** 2)
        ring.append((xn * L, y, z))
    return ring


def build_opening_cutter():
    """A smooth solid that Boolean-carves the foot-entry hole in the collar,
    leaving a clean-edged dark recess (no staircase artifacts)."""
    bm = bmesh.new()
    NU, NV = 30, 18
    # the cavity runs from the heel collar forward along the throat valley
    xs = np.linspace(0.0, 0.50, NU)
    rows = []
    for k, xn in enumerate(xs):
        a = k / (NU - 1)
        w = halfw(xn)
        st = sole_top(xn)
        h = domeh(xn)
        # taper the cavity to nothing at the front so it closes smoothly
        endclose = smoothstep(0.50, 0.40, xn)          # 0 at front, 1 behind
        cw = (0.66 * w) * (0.35 + 0.65 * endclose)
        rim = st + h + 0.012                            # well above the rim
        floor = st + h * (0.30 + 0.45 * (1 - endclose)) # shallower at the front
        row = []
        for j in range(NV):
            ang = math.pi * j / (NV - 1)
            y = -cw * math.cos(ang)
            z = floor + (rim - floor) * math.sin(ang) ** 0.6
            row.append(bm.verts.new((xn * L, y, z)))
        rows.append(row)
    for i in range(NU - 1):
        for j in range(NV - 1):
            bm.faces.new((rows[i][j], rows[i][j + 1],
                          rows[i + 1][j + 1], rows[i + 1][j]))
    # cap the two open ends so the cutter is a closed solid
    bm.faces.new(rows[0][::-1])
    bm.faces.new(rows[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("OpeningCutter")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("OpeningCutter", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.hide_render = True
    ob.display_type = "WIRE"
    return ob


def build_upper():
    NU = 84
    xs = np.linspace(0.006, 0.994, NU)
    grid = [upper_ring(xn) for xn in xs]
    verts = [p for ring in grid for p in ring]

    def idx(i, j):
        return i * NV + (j % NV)

    faces = []
    for i in range(NU - 1):
        for j in range(NV):
            faces.append((idx(i, j), idx(i, j + 1),
                          idx(i + 1, j + 1), idx(i + 1, j)))
    # collapse-cap the heel and toe rings -> closed manifold solid
    faces.append(tuple(range(NV)))
    faces.append(tuple(range((NU - 1) * NV, NU * NV)))

    ob = new_obj("Upper", verts, faces)
    shade_smooth(ob)
    sub = add_subsurf(ob, 2, 3)
    cutter = build_opening_cutter()
    boo = ob.modifiers.new("opening", "BOOLEAN")
    boo.operation = "DIFFERENCE"
    boo.solver = "EXACT"
    boo.object = cutter
    return ob


# --------------------------------------------------------------------------- #
#  SOLE  — closed-ring cage with a slightly crowned top and flat lugged base
# --------------------------------------------------------------------------- #
def build_sole():
    NU = 60
    xs = np.linspace(0.0, 1.0, NU)
    rings = []
    for xn in xs:
        w = halfw(xn) + 0.004            # sole flares a touch past the upper
        # taper the very tips so the caps close cleanly
        tip = min(smoothstep(0.0, 0.04, xn), 1.0 - smoothstep(0.96, 1.0, xn))
        w *= (0.25 + 0.75 * tip) if (xn < 0.04 or xn > 0.96) else 1.0
        zb = sole_bot(xn)
        zt = sole_top(xn)
        # cross-section loop (Y-Z), clockwise
        ring = [
            (xn * L, -w, zt - 0.002),            # top inner shoulder
            (xn * L, -w * 0.92, zt + 0.001),     # crowned top
            (xn * L, w * 0.92, zt + 0.001),
            (xn * L, w, zt - 0.002),
            (xn * L, w, zb + 0.002),             # lateral wall
            (xn * L, w * 0.8, zb),               # flat base
            (xn * L, -w * 0.8, zb),
            (xn * L, -w, zb + 0.002),            # medial wall
        ]
        rings.append(ring)

    NV = 8
    verts = [p for r in rings for p in r]

    def idx(i, j):
        return i * NV + (j % NV)

    faces = []
    for i in range(NU - 1):
        for j in range(NV):
            faces.append((idx(i, j), idx(i, j + 1),
                          idx(i + 1, j + 1), idx(i + 1, j)))
    # end caps
    faces.append(tuple(range(NV)))
    faces.append(tuple(range((NU - 1) * NV, NU * NV)))

    ob = new_obj("Sole", verts, faces)
    shade_smooth(ob)
    add_subsurf(ob, 2, 2)
    return ob


# --------------------------------------------------------------------------- #
#  LUGS  — chunky tread blocks arrayed under the sole (visible from the side)
# --------------------------------------------------------------------------- #
def build_lugs():
    bm = bmesh.new()
    n = 30
    for k in range(n):
        xn = 0.035 + 0.93 * k / (n - 1)
        w = halfw(xn) + 0.004
        zb = sole_bot(xn)
        depth = 0.012
        # rows of lugs near each edge + centre, tops sunk into the sole
        for yy in (-w * 0.80, -w * 0.34, w * 0.06, w * 0.46, w * 0.82):
            cx, cy = xn * L, yy
            cz = zb - depth * 0.5 + 0.003
            sx, sy, sz = 0.0105, 0.013, depth
            cube = bmesh.ops.create_cube(bm, size=1.0)["verts"]
            for v in cube:
                v.co.x = v.co.x * sx + cx
                v.co.y = v.co.y * sy + cy
                v.co.z = v.co.z * sz + cz
    me = bpy.data.meshes.new("Lugs")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Lugs", me)
    bpy.context.scene.collection.objects.link(ob)
    bev = ob.modifiers.new("bev", "BEVEL")
    bev.width = 0.0018
    bev.segments = 2
    shade_smooth(ob)
    return ob


# --------------------------------------------------------------------------- #
#  RUBBER OVERLAYS  — toe cap, heel counter, lateral logo band
# --------------------------------------------------------------------------- #
def paint_upper_regions(ob):
    """Assign the rubber-overlay material (slot 2) to the toe bumper, heel
    counter and the diagonal lateral logo band directly on the upper's faces,
    so the overlays sit perfectly flush instead of as floating shells."""
    me = ob.data
    for p in me.polygons:
        c = p.center
        xn = c.x / L
        st = sole_top(xn)
        h = domeh(xn)
        zrel = (c.z - st) / max(h, 1e-5)        # 0 at sole, 1 at apex
        mat = 0
        if xn > 0.86 and zrel < 0.72:           # toe bumper wraps the front
            mat = 2
        elif xn < 0.085:                         # heel counter
            mat = 2
        p.material_index = mat


def overlay_patch(name, xn0, xn1, f0, f1, push=0.0016, nu=18, nv=12):
    """A thin shell hugging the upper dome between station/arc bounds."""
    us = np.linspace(xn0, xn1, nu)
    grid = []
    for xn in us:
        w = halfw(xn)
        h = domeh(xn)
        st = sole_top(xn)
        ring = []
        for j in range(nv):
            f = f0 + (f1 - f0) * j / (nv - 1)
            s = (f - 0.5) * 2.0
            y = w * s
            z = st + h * (1.0 - abs(s) ** 1.9) ** 0.8
            # outward normal approx (radial in Y-Z from dome centre)
            ny, nz = y, (z - st)
            nlen = math.hypot(ny, nz) or 1.0
            ring.append((xn * L, y + push * ny / nlen, z + push * nz / nlen))
        grid.append(ring)
    verts = [p for r in grid for p in r]

    def idx(i, j):
        return i * nv + j
    faces = []
    for i in range(nu - 1):
        for j in range(nv - 1):
            faces.append((idx(i, j), idx(i, j + 1),
                          idx(i + 1, j + 1), idx(i + 1, j)))
    ob = new_obj(name, verts, faces)
    shade_smooth(ob)
    add_solidify(ob, 0.0022, offset=0.0)
    add_subsurf(ob, 2, 2)
    return ob


# --------------------------------------------------------------------------- #
#  CURVE-BASED parts: laces, toggle, pull tab, side logo
# --------------------------------------------------------------------------- #
def dome_point(xn, f, push=0.0):
    w = halfw(xn)
    h = domeh(xn)
    st = sole_top(xn)
    s = (f - 0.5) * 2.0
    y = w * s
    z = st + h * (1.0 - abs(s) ** 1.9) ** 0.8
    z -= throat_valley(xn, s)
    ny, nz = y, (z - st)
    nlen = math.hypot(ny, nz) or 1.0
    return Vector((xn * L, y + push * ny / nlen, z + push * nz / nlen))


def side_point(xn, zrel, push=0.0):
    """A point on the camera-facing (-Y) flank of the upper, addressed by
    length fraction xn and height fraction zrel (0 = sole, 1 = apex)."""
    w = halfw(xn)
    h = domeh(xn)
    st = sole_top(xn)
    q = min(1.0, max(0.0, zrel))
    base = max(0.0, 1.0 - q ** (1.0 / 0.8))
    s = -(base ** (1.0 / 1.9))               # negative -> camera side
    y = w * s
    z = st + h * q
    ny, nz = y, (z - st)
    nlen = math.hypot(ny, nz) or 1.0
    return Vector((xn * L, y + push * ny / nlen, z + push * nz / nlen))


def build_side_decal(mat):
    """A smooth TPU swoosh on the lateral flank carrying the brand text —
    a thin ribbon offset just off the surface (clean edges, no staircase)."""
    nu, nv = 40, 12
    verts, faces = [], []
    for i in range(nu):
        u = i / (nu - 1)
        xn = 0.255 + (0.66 - 0.255) * u
        # centreline sweeps gently downward toward the toe
        zc = 0.46 - 0.13 * smoothstep(0.0, 1.0, u)
        # ribbon tapers at both ends
        hh = 0.135 * (0.35 + 0.65 * math.sin(math.pi * min(1.0, max(0.0, u))) ** 0.5)
        for j in range(nv):
            v = j / (nv - 1)
            zrel = zc + (v - 0.5) * hh * 0.82
            verts.append(side_point(xn, zrel, push=0.0009))
    for i in range(nu - 1):
        for j in range(nv - 1):
            a = i * nv + j
            faces.append((a, a + 1, a + nv + 1, a + nv))
    ob = new_obj("SideDecal", verts, faces)
    shade_smooth(ob)
    add_solidify(ob, 0.0011, offset=0.0)
    add_subsurf(ob, 1, 2)
    if mat:
        ob.data.materials.append(mat)
    return ob


def bevel_curve(name, points, radius, mat=None, closed=False):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 4
    cu.resolution_u = 12
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp.points[i].co = (p.x, p.y, p.z, 1.0)
    sp.use_cyclic_u = closed
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    if mat:
        ob.data.materials.append(mat)
    return ob


def build_laces(mat_cord, mat_toggle):
    obs = []
    # speed-lace bungee: thin cord zig-zags across the throat between guide
    # points on either rim, then gathers into the cord-lock toggle.
    guides_med = [(xn, dome_point(xn, 0.5 - 0.30, push=0.003))
                  for xn in (0.20, 0.27, 0.34, 0.41)]
    guides_lat = [(xn, dome_point(xn, 0.5 + 0.30, push=0.003))
                  for xn in (0.235, 0.305, 0.375, 0.445)]
    # cross strands forming the V/zigzag lacing
    pairs = [(0, 0), (1, 0), (1, 1), (2, 1), (2, 2), (3, 2), (3, 3)]
    for a, b in pairs:
        p0 = guides_med[a][1]
        p1 = guides_lat[b][1]
        mid = (p0 + p1) * 0.5
        mid.z += 0.006
        obs.append(bevel_curve(f"lace{a}{b}", [p0, mid, p1], 0.0013, mat_cord))

    # cord-lock toggle gathering the cord near the front of the throat
    tpos = dome_point(0.46, 0.5, push=0.006)
    tpos.z += 0.005
    bm = bmesh.new()
    # cone built with its axis already along Y (lies across the throat)
    bmesh.ops.create_cone(bm, segments=16, radius1=0.0075, radius2=0.0055,
                          depth=0.014, cap_ends=True)
    for v in bm.verts:
        x, y, z = v.co
        v.co = (x + tpos.x, z + tpos.y, y + tpos.z)   # swap Y<->Z axis
    me = bpy.data.meshes.new("Toggle")
    bm.to_mesh(me)
    bm.free()
    tog = bpy.data.objects.new("Toggle", me)
    bpy.context.scene.collection.objects.link(tog)
    b = tog.modifiers.new("b", "BEVEL")
    b.width = 0.0015
    b.segments = 2
    shade_smooth(tog)
    if mat_toggle:
        tog.data.materials.append(mat_toggle)
    obs.append(tog)

    # two loose cord tails curling down from the toggle
    for sgn in (1, -1):
        e1 = tpos + Vector((0.012, 0.006 * sgn, -0.012))
        e2 = e1 + Vector((0.016, 0.004 * sgn, -0.014))
        e3 = e2 + Vector((0.006, 0.0, -0.012))
        obs.append(bevel_curve(f"tail{sgn}", [tpos, e1, e2, e3],
                               0.0013, mat_cord))
    return obs


def build_pulltab(mat):
    # a flat webbing loop standing up off the back of the heel collar
    anchor = dome_point(0.055, 0.5)         # heel-back, top of the collar
    cx = anchor.x - 0.004                    # lean the loop slightly rearward
    cz = anchor.z + 0.004
    pts = []
    for a in np.linspace(0, 2 * math.pi, 20, endpoint=False):
        ry, rz = 0.008, 0.016
        x = cx - 0.006 * (1 + math.cos(a)) - ry * math.sin(a)
        z = cz + rz * math.cos(a)
        pts.append(Vector((x, anchor.y, z)))
    cu = bpy.data.curves.new("PullTab", "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p.x, p.y, p.z, 1.0)
    sp.use_cyclic_u = True
    ob = bpy.data.objects.new("PullTab", cu)
    bpy.context.scene.collection.objects.link(ob)
    # flat webbing cross-section
    prof = bpy.data.curves.new("tabprof", "CURVE")
    pr = prof.splines.new("POLY")
    pr.points.add(3)
    for i, (a, b) in enumerate([(-0.006, -0.0013), (0.006, -0.0013),
                                (0.006, 0.0013), (-0.006, 0.0013)]):
        pr.points[i].co = (a, b, 0, 1)
    pr.use_cyclic_u = True
    profob = bpy.data.objects.new("tabprof", prof)
    bpy.context.scene.collection.objects.link(profob)
    cu.bevel_mode = "OBJECT"
    cu.bevel_object = profob
    profob.hide_render = True
    if mat:
        ob.data.materials.append(mat)
    return ob


# --------------------------------------------------------------------------- #
#  MATERIALS
# --------------------------------------------------------------------------- #
def set_principled(bsdf, **kw):
    name_map = {
        "base": "Base Color", "rough": "Roughness", "metal": "Metallic",
        "spec": "Specular IOR Level", "sheen": "Sheen Weight",
        "sheentint": "Sheen Tint", "ior": "IOR", "coat": "Coat Weight",
    }
    for k, v in kw.items():
        sock = name_map.get(k, k)
        if sock not in bsdf.inputs:
            continue
        inp = bsdf.inputs[sock]
        if inp.type == "RGBA" and not hasattr(v, "__len__"):
            v = (v, v, v, 1.0)            # broadcast scalar -> grey colour
        inp.default_value = v


def make_mat(name, base, rough, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    if len(base) == 3:
        base = (*base, 1.0)
    set_principled(bsdf, base=base, rough=rough, **kw)
    return m, bsdf


def add_fabric_bump(m, bsdf, scale=900.0, strength=0.25):
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 4.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return tex


def add_knit_weave(m, bsdf, base):
    """Anisotropic woven look: fine wave stripes + heathered colour variation."""
    nt = m.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    # directional wave for the knit ribs
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.inputs["Scale"].default_value = 320.0
    wave.inputs["Distortion"].default_value = 1.5
    nt.links.new(coord.outputs["Object"], wave.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.28
    bump.inputs["Distance"].default_value = 0.0008
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    # heathered colour: mix two close greys by a noise mask
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 240.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*[c * 0.86 for c in base[:3]], 1.0)
    mix.inputs["B"].default_value = (*[min(1, c * 1.12) for c in base[:3]], 1.0)
    nt.links.new(noise.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    return bump


def build_materials():
    mats = {}
    knit_base = (0.275, 0.285, 0.305)
    knit, kb = make_mat("Knit", knit_base, 0.90,
                        sheen=0.7, sheentint=0.4, spec=0.22)
    add_knit_weave(knit, kb, knit_base)
    mats["knit"] = knit

    inner, ib = make_mat("Inner", (0.045, 0.045, 0.052), 0.95, sheen=0.2)
    mats["inner"] = inner

    rub_dark, rb = make_mat("RubberSole", (0.052, 0.056, 0.066), 0.52, spec=0.45)
    add_fabric_bump(rub_dark, rb, 1300, 0.18)
    mats["sole"] = rub_dark

    overlay, ob = make_mat("Overlay", (0.125, 0.130, 0.145), 0.33,
                           spec=0.7, coat=0.25)
    add_fabric_bump(overlay, ob, 600, 0.08)
    mats["overlay"] = overlay

    cord, cb = make_mat("Cord", (0.46, 0.47, 0.49), 0.78, sheen=0.5)
    mats["cord"] = cord

    toggle, tb = make_mat("Toggle", (0.02, 0.02, 0.025), 0.28, spec=0.8, coat=0.5)
    mats["toggle"] = toggle

    web, wb = make_mat("Webbing", (0.10, 0.105, 0.115), 0.7)
    mats["web"] = web

    white, _ = make_mat("WhiteText", (0.86, 0.87, 0.89), 0.45, spec=0.3)
    mats["text"] = white
    return mats


def assign(ob, mat, extra=None):
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    if extra:
        for e in extra:
            ob.data.materials.append(e)


# --------------------------------------------------------------------------- #
#  SIDE LOGO  (text + hex), placed flat on the lateral overlay band
# --------------------------------------------------------------------------- #
def add_text(body, size, xn, zrel, mat):
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    ob = bpy.data.objects.new("txt_" + body[:6], cu)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = side_point(xn, zrel, push=0.0022)
    # read normally when viewed from -Y: local +Z -> -Y, local +X -> +X
    ob.rotation_euler = (math.radians(90), 0, 0)
    ex = ob.modifiers.new("solid", "SOLIDIFY")
    ex.thickness = 0.0005
    if mat:
        ob.data.materials.append(mat)
    return ob


def build_logo(mats):
    obs = []
    obs.append(add_text("VIVOBAREFOOT", 0.0076, 0.375, 0.42, mats["text"]))
    obs.append(add_text("PRIMUS TRAIL / HEX GROUND", 0.0038, 0.375, 0.345,
                        mats["text"]))
    # small double-hexagon logo just ahead of the wordmark
    for r in (0.0088, 0.0052):
        bm = bmesh.new()
        bmesh.ops.create_circle(bm, cap_ends=False, segments=6, radius=r)
        me = bpy.data.meshes.new("hex")
        bm.to_mesh(me)
        bm.free()
        hx = bpy.data.objects.new("hex", me)
        bpy.context.scene.collection.objects.link(hx)
        hx.location = side_point(0.605, 0.40, push=0.0022)
        hx.rotation_euler = (math.radians(90), 0, 0)
        sk = hx.modifiers.new("skin", "SKIN")
        for sv in me.skin_vertices[0].data:
            sv.radius = (0.0010, 0.0010)
        if mats.get("text"):
            hx.data.materials.append(mats["text"])
        obs.append(hx)
    return obs


# --------------------------------------------------------------------------- #
#  SCENE: world, lights, camera, render settings
# --------------------------------------------------------------------------- #
def build_backdrop():
    # seamless studio sweep: floor (in -Y, toward cam) curving up to a back
    # wall (in +Y, behind the shoe).  Profile lives in the Y-Z plane, the sheet
    # is wide along X (the length axis seen by the camera).
    me = bpy.data.meshes.new("Backdrop")
    bm = bmesh.new()
    res = 40
    prof = []
    for i in range(res):
        a = i / (res - 1)
        z0 = -0.009                       # rest the lugs on the floor
        if a < 0.45:                      # flat floor coming toward camera
            y = -0.9 + (0.45 + 0.9) * (a / 0.45)
            z = z0
        else:                             # quarter-circle sweep up to wall
            t = (a - 0.45) / 0.55
            r = 0.55
            y = 0.45 + r * math.sin(t * math.pi / 2)
            z = z0 + r * (1 - math.cos(t * math.pi / 2))
        prof.append((y, z))
    xspan = (-1.2, 1.6)
    cols = 6
    vid = []
    for (y, z) in prof:
        row = []
        for c in range(cols):
            x = xspan[0] + (xspan[1] - xspan[0]) * c / (cols - 1)
            row.append(bm.verts.new((x, y, z)))
        vid.append(row)
    for i in range(len(vid) - 1):
        for c in range(cols - 1):
            bm.faces.new((vid[i][c], vid[i][c + 1],
                          vid[i + 1][c + 1], vid[i + 1][c]))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Backdrop", me)
    bpy.context.scene.collection.objects.link(ob)
    shade_smooth(ob)
    add_subsurf(ob, 2, 2)
    m, b = make_mat("BG", (0.90, 0.905, 0.915), 0.5)
    ob.data.materials.append(m)
    return ob


def area_light(name, loc, energy, size, rot=(0, 0, 0)):
    d = bpy.data.lights.new(name, "AREA")
    d.energy = energy
    d.size = size
    ob = bpy.data.objects.new(name, d)
    ob.location = loc
    ob.rotation_euler = rot
    bpy.context.scene.collection.objects.link(ob)
    return ob


def look_at(ob, target):
    direction = Vector(target) - ob.location
    ob.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def build_scene():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    try:
        sc.cycles.device = "CPU"
    except Exception:
        pass
    sc.render.resolution_x = 1200
    sc.render.resolution_y = 1200
    sc.render.film_transparent = False
    try:
        sc.view_settings.view_transform = "Standard"
    except Exception:
        pass
    sc.view_settings.exposure = 0.0

    world = sc.world
    if world is None:
        world = bpy.data.worlds.new("World")
        sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.80, 0.81, 0.83, 1.0)
    bg.inputs["Strength"].default_value = 0.85

    tgt = (L * 0.5, 0, 0.06)
    cx = L * 0.5
    # studio softboxes — soft key on the camera side, gentle fill + rim
    key = area_light("Key", (cx - 0.2, -1.0, 0.95), 16, 1.4)
    look_at(key, tgt)
    fill = area_light("Fill", (cx + 0.7, -1.1, 0.4), 6, 1.7)
    look_at(fill, tgt)
    rim = area_light("Rim", (cx + 0.4, 0.9, 0.85), 14, 1.0)
    look_at(rim, tgt)
    top = area_light("Top", (cx, -0.2, 1.3), 9, 1.5)
    look_at(top, tgt)

    # camera: orthographic catalogue side view, toe to the right
    cam_d = bpy.data.cameras.new("Cam")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = 0.36
    cam = bpy.data.objects.new("Cam", cam_d)
    cam.location = (cx, -3.0, 0.075)
    bpy.context.scene.collection.objects.link(cam)
    look_at(cam, (cx, 0, 0.075))
    sc.camera = cam


# --------------------------------------------------------------------------- #
#  ASSEMBLY
# --------------------------------------------------------------------------- #
def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def main(render=True, out="shoe_render.png", samples=96):
    clear_scene()
    mats = build_materials()

    upper = build_upper()
    assign(upper, mats["knit"], extra=[mats["inner"], mats["overlay"]])
    paint_upper_regions(upper)            # toe / heel / side rubber overlays
    cutter = bpy.data.objects.get("OpeningCutter")
    if cutter:
        cutter.data.materials.append(mats["inner"])   # dark recess interior

    sole = build_sole()
    assign(sole, mats["sole"])

    lugs = build_lugs()
    assign(lugs, mats["sole"])

    decal = build_side_decal(mats["overlay"])
    laces = build_laces(mats["cord"], mats["toggle"])
    tab = build_pulltab(mats["web"])
    logo = build_logo(mats)

    build_backdrop()
    build_scene()

    if render:
        sc = bpy.context.scene
        sc.cycles.samples = samples
        sc.render.filepath = os.path.join(OUT_DIR, out)
        bpy.ops.render.render(write_still=True)
        print("WROTE", sc.render.filepath)


if __name__ == "__main__":
    import sys
    spp = 220
    name = "shoe_render.png"
    if "--quick" in sys.argv:
        spp = 24
        name = "shoe_preview.png"
    main(render=True, out=name, samples=spp)
