"""Agent orb generator for the redesign canvas — the "network" orb.

A transparent sphere of nodes and edges (sparse shell + dense core) in a slowly turning
CSS-3D core. Motion is pulses travelling along edges; each state enables edge tiers and
sets speed. Pure CSS; every colour derives from one state token via color-mix.

    python design_docs/canvas/orb.py            # rewrites every orb in *.dc.html + AgentOrb board
    from orb import orb_html, ORB_CSS
"""
import glob
import json
import math
import random
import re

ORB_CSS = """    /* ---- agent orb: the network nucleus with broken rings ---- */
    @property --orb-a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
    .orb { position: relative; flex-shrink: 0; width: var(--orb-size); height: var(--orb-size); --c: var(--orb-c); perspective: calc(var(--orb-size) * 9); }
    .orb::after { content: ''; position: absolute; inset: -10%; border-radius: 9999px; pointer-events: none; background: radial-gradient(circle, color-mix(in srgb, var(--c) 10%, transparent) 0%, color-mix(in srgb, var(--c) 6%, transparent) 45%, transparent 68%); }
    .orb__w { position: absolute; inset: 0; transform-style: preserve-3d; }
    .orb__nw { position: absolute; inset: 0; transform-style: preserve-3d; animation: orb-wobble 37s ease-in-out infinite alternate; }
    @keyframes orb-wobble { from { transform: rotateX(-14deg) rotateZ(-6deg); } to { transform: rotateX(14deg) rotateZ(6deg); } }
    .orb__core { position: absolute; inset: 0; transform-style: preserve-3d; animation: orb-spin var(--orb-spin, 48s) linear infinite; }
    @keyframes orb-spin { to { transform: rotateY(360deg); } }
    .orb__ring { position: absolute; left: 50%; top: 50%; width: var(--rw); height: var(--rw); margin: calc(var(--rw) / -2) 0 0 calc(var(--rw) / -2); border-radius: 9999px; opacity: .9;
      -webkit-mask: radial-gradient(circle, transparent calc(50% - var(--rt) - .5px), #000 calc(50% - var(--rt)), #000 calc(50% - .5px), transparent 50%); mask: radial-gradient(circle, transparent calc(50% - var(--rt) - .5px), #000 calc(50% - var(--rt)), #000 calc(50% - .5px), transparent 50%);
      transform: rotate(var(--orb-a)); animation: orb-ring var(--t) linear infinite var(--dir, normal); animation-delay: var(--dl); }
    @keyframes orb-ring { to { --orb-a: 360deg; } }
    .orb__n { position: absolute; left: 50%; top: 50%; width: var(--orb-dot); height: var(--orb-dot); margin: calc(var(--orb-dot) / -2) 0 0 calc(var(--orb-dot) / -2); border-radius: 9999px; background: radial-gradient(circle at 40% 40%, #fff 0 30%, color-mix(in srgb, var(--c) 70%, #fff) 60%, var(--c) 100%); box-shadow: 0 0 0 .5px color-mix(in srgb, var(--c) 60%, #fff), 0 0 calc(var(--orb-dot) * .8) color-mix(in srgb, var(--c) 70%, transparent); opacity: .7; animation: orb-node var(--orb-node, 7s) ease-in-out infinite; animation-delay: var(--dl); }
    .orb__n--c { width: calc(var(--orb-dot) * 1.5); height: calc(var(--orb-dot) * 1.5); margin: calc(var(--orb-dot) * -.75) 0 0 calc(var(--orb-dot) * -.75); opacity: 1; box-shadow: 0 0 0 .5px #fff, 0 0 calc(var(--orb-dot) * 1.6) var(--c); }
    @keyframes orb-node { 0%, 100% { opacity: .6; } 50% { opacity: 1; } }
    .orb__e { position: absolute; left: 50%; top: 50%; width: var(--l); height: var(--orb-line); margin: calc(var(--orb-line) / -2) 0 0 calc(var(--l) / -2); transform-origin: center;
      background: linear-gradient(90deg, transparent 30%, color-mix(in srgb, var(--c) 40%, #fff) 50%, transparent 70%) no-repeat 160% 0 / 220% 100%,
                  linear-gradient(color-mix(in srgb, var(--c) 22%, transparent), color-mix(in srgb, var(--c) 22%, transparent)); }
    @keyframes orb-pulse { 0% { background-position: 160% 0, 0 0; } 55%, 100% { background-position: -160% 0, 0 0; } }
    .orb__x { display: none; position: absolute; left: 50%; top: 50%; width: var(--orb-dot); height: var(--orb-dot); margin: calc(var(--orb-dot) / -2) 0 0 calc(var(--orb-dot) / -2); border-radius: 9999px; background: #fff; box-shadow: 0 0 calc(var(--orb-dot) * 2) var(--c); animation: orb-exit 5s ease-in infinite; animation-delay: var(--dl); }
    @keyframes orb-exit { 0% { transform: translate(0, 0) scale(.6); opacity: 0; } 8% { opacity: 1; } 30% { transform: translate(var(--ex), var(--ey)) scale(1); opacity: 1; } 42% { transform: translate(calc(var(--ex) * 1.5), calc(var(--ey) * 1.5)) scale(.3); opacity: 0; } 100% { opacity: 0; } }
    /* detached: the graph is there, dark and still */
    .orb--detached { opacity: .38; } .orb--detached .orb__core, .orb--detached .orb__n, .orb--detached .orb__ring { animation-play-state: paused; } .orb--detached::after { opacity: 0; }
    /* idle: a few pathways fire now and then */
    .orb--idle .orb__e--t1 { --t: 3.2s; animation: orb-pulse var(--t) linear infinite; animation-delay: var(--dl); }
    /* reading: activity arrives from the shell and converges — many pathways, quick */
    .orb--reading { --orb-spin: 22s; --orb-node: 2.5s; } .orb--reading .orb__ring--1 { animation-duration: calc(var(--t) / 2); } .orb--reading .orb__ring--2 { animation-duration: calc(var(--t) / 1.4); } .orb--reading .orb__ring--3 { animation-duration: calc(var(--t) / 2.6); } .orb--reading .orb__ring--4 { animation-duration: calc(var(--t) / 1.2); } .orb--reading .orb__e--t1, .orb--reading .orb__e--t2 { --t: 1.3s; animation: orb-pulse var(--t) linear infinite; animation-delay: var(--dl); }
    /* running: a sustained pattern cycles through the whole graph */
    .orb--running { --orb-spin: 12s; --orb-node: 1.2s; } .orb--running .orb__ring--1 { animation-duration: calc(var(--t) / 4); } .orb--running .orb__ring--2 { animation-duration: calc(var(--t) / 2.2); } .orb--running .orb__ring--3 { animation-duration: calc(var(--t) / 6); } .orb--running .orb__ring--4 { animation-duration: calc(var(--t) / 1.6); } .orb--running .orb__e--t1, .orb--running .orb__e--t2, .orb--running .orb__e--t3 { --t: .9s; animation: orb-pulse var(--t) linear infinite; animation-delay: var(--dl); }
    /* wrote: a path lights and leaves the sphere — an output actually exited */
    .orb--wrote .orb__e--t1, .orb--wrote .orb__e--t2 { --t: 2s; animation: orb-pulse var(--t) linear infinite; animation-delay: var(--dl); } .orb--wrote .orb__x { display: block; }
    /* needs you: one pathway held bright and still; attention ring outside */
    .orb--needs { --orb-spin: 90s; --orb-node: 10s; } .orb--needs .orb__ring { animation-play-state: paused; opacity: 1; filter: brightness(1.3); } .orb--needs .orb__e--t1 { background-position: 50% 0, 0 0; filter: brightness(1.6); } .orb--needs::before { content: ''; position: absolute; inset: -5px; border-radius: 9999px; animation: lt-pulse 1.4s ease-out infinite; }
    /* raw access on: every pathway visible and slow; the tint never animates away */
    .orb--raw { --orb-spin: 60s; } .orb--raw .orb__ring--1 { animation-duration: calc(var(--t) * 1.6); } .orb--raw .orb__ring--2 { animation-duration: calc(var(--t) * 3); } .orb--raw .orb__ring--3 { animation-duration: calc(var(--t) * 1.3); } .orb--raw .orb__ring--4 { animation-duration: calc(var(--t) * 2); } .orb--raw .orb__e { background-image: linear-gradient(90deg, transparent 30%, color-mix(in srgb, var(--c) 40%, #fff) 50%, transparent 70%), linear-gradient(color-mix(in srgb, var(--c) 45%, transparent), color-mix(in srgb, var(--c) 45%, transparent)); --t: 3.5s; animation: orb-pulse var(--t) linear infinite; animation-delay: var(--dl); }
    .orb--raw::after { background: radial-gradient(circle, color-mix(in srgb, var(--c) 22%, transparent) 0%, color-mix(in srgb, var(--c) 10%, transparent) 50%, transparent 70%); }
"""
STATE_TOKEN = {
    'detached': 'var(--agent-idle)', 'idle': 'var(--agent-idle)', 'reading': 'var(--agent-reading)',
    'running': 'var(--agent-running)', 'wrote': 'var(--agent-wrote)', 'needs': 'var(--agent-needs)', 'raw': 'var(--agent-raw)',
}
STATES = list(STATE_TOKEN)


def _fib(n: int, rng: random.Random, jitter: float = 0.0) -> list[tuple[float, float, float]]:
    pts = []
    for i in range(n):
        y = 1 - 2 * (i + 0.5) / n
        rad = math.sqrt(max(0.0, 1 - y * y))
        a = i * math.pi * (3 - math.sqrt(5))
        x, z = math.cos(a) * rad, math.sin(a) * rad
        if jitter:
            x, y, z = (v + rng.uniform(-jitter, jitter) for v in (x, y, z))
            m = math.sqrt(x * x + y * y + z * z) or 1
            x, y, z = x / m, y / m, z / m
        pts.append((x, y, z))
    return pts


def _detail(size: int) -> tuple[int, int]:
    """(shell nodes, core nodes) by diameter."""
    if size < 24:
        return 10, 4
    if size < 40:
        return 18, 6
    if size < 80:
        return 30, 10
    return 44, 14


def _edge(p, q, rng, tier, delay_max):
    mx, my, mz = ((p[i] + q[i]) / 2 for i in range(3))
    dx, dy, dz = (q[i] - p[i] for i in range(3))
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    dx, dy, dz = dx / L, dy / L, dz / L
    theta = math.degrees(math.asin(max(-1, min(1, dy))))
    phi = math.degrees(math.atan2(-dz, dx))
    return (f'<i class="orb__e orb__e--t{tier}" style="--l:{L:.1f}px;--dl:{-rng.uniform(0, delay_max):.2f}s;'
            f'transform:translate3d({mx:.1f}px,{my:.1f}px,{mz:.1f}px) rotateY({phi:.1f}deg) rotateZ({theta:.1f}deg)"></i>')


def _ring_html(size: int, rng: random.Random, rw: float, rt: float, tilt: int, t: float, reverse: bool, ticks: bool, k: int = 1) -> str:
    """One broken ring: a conic gradient of arcs and gaps, masked to a band of thickness rt."""
    stops, a = [], 0.0
    bright = 'color-mix(in srgb, var(--c) 85%, #fff)'
    dim = 'color-mix(in srgb, var(--c) 72%, transparent)'
    while a < 360:
        if ticks:
            arc, gap = rng.uniform(2, 6), rng.uniform(4, 14)
        else:
            arc, gap = rng.uniform(22, 85), rng.uniform(10, 30)
        arc = min(arc, 360 - a)
        col = bright if rng.random() < .45 else dim
        stops.append(f'{col} {a:.0f}deg {a + arc:.0f}deg')
        a += arc
        if a < 360:
            gap = min(gap, 360 - a)
            stops.append(f'transparent {a:.0f}deg {a + gap:.0f}deg')
            a += gap
    grad = 'conic-gradient(from 0deg, ' + ', '.join(stops) + ')'
    d = ';--dir:reverse' if reverse else ''
    op = ''
    return (f'<s class="orb__ring orb__ring--{k}" style="--rw:{rw * 100:.0f}%;--rt:{rt:.1f}px;--tilt:{tilt}deg;--t:{t:.0f}s;--dl:{-rng.uniform(0, t):.1f}s{d}{op};'
            f'background:{grad}"></s>')


def _rings(size: int) -> list[tuple[float, float, int, float, bool, bool]]:
    """(diameter fraction, thickness px, tilt deg [always 0: rings face the viewer], period s, reverse, ticks)"""
    if size < 24:
        return [(1.0, 1.5, 0, 20, False, False)]
    if size < 40:
        return [(0.84, 1.5, 0, 22, False, False), (1.0, 1.0, 0, 13, True, False)]
    if size < 80:
        return [(0.72, max(2.0, size / 32), 0, 24, False, False), (0.86, 1.0, 0, 10, True, True), (1.0, max(1.5, size / 60), 0, 50, False, False)]
    return [(0.68, size / 36, 0, 26, False, False), (0.79, max(1.0, size / 110), 0, 11, True, True), (0.90, size / 64, 0, 44, False, False), (1.0, size / 80, 0, 70, True, False)]


def orb_html(size: int, state: str, extra_style: str = '', title: str | None = None) -> str:
    rng = random.Random(size * 7 + 3)
    n_shell, n_core = _detail(size)
    rings = _rings(size)
    r = (size / 2 - 2) * (0.40 if size >= 40 else 0.55)
    dot = max(2, round(size / 40))
    line = 1 if size < 80 else 1.5
    shell = [(x * r, y * r, z * r) for x, y, z in _fib(n_shell, rng, .08)]
    core = [(x * r * .42, y * r * .42, z * r * .42) for x, y, z in _fib(n_core, rng, .25)]
    allpts = shell + core

    def nearest(idx, pool_range, k):
        p = allpts[idx]
        order = sorted((j for j in pool_range if j != idx), key=lambda j: sum((p[i] - allpts[j][i]) ** 2 for i in range(3)))
        return order[:k]

    edges = set()
    for i in range(n_shell):
        for j in nearest(i, range(n_shell), 2):
            edges.add((min(i, j), max(i, j)))
    for i in range(n_shell, n_shell + n_core):
        for j in nearest(i, range(n_shell, n_shell + n_core), 2):
            edges.add((min(i, j), max(i, j)))
        for j in nearest(i, range(n_shell), 1):
            edges.add((min(i, j), max(i, j)))
    parts = []
    for a, b in sorted(edges):
        tier = rng.choices((1, 2, 3, 4), weights=(18, 27, 30, 25))[0]
        parts.append(_edge(allpts[a], allpts[b], rng, tier, 3))
    for x, y, z in shell:
        parts.append(f'<b class="orb__n" style="--dl:{-rng.uniform(0, 7):.1f}s;transform:translate3d({x:.1f}px,{y:.1f}px,{z:.1f}px)"></b>')
    for x, y, z in core:
        parts.append(f'<b class="orb__n orb__n--c" style="--dl:{-rng.uniform(0, 7):.1f}s;transform:translate3d({x:.1f}px,{y:.1f}px,{z:.1f}px)"></b>')
    exits = ''.join(
        f'<u class="orb__x" style="--ex:calc(var(--orb-size) * {0.5 * math.cos(a):.3f});--ey:calc(var(--orb-size) * {0.5 * math.sin(a):.3f});--dl:{-rng.uniform(0, 5):.2f}s"></u>'
        for a in [rng.uniform(0, 2 * math.pi) for _ in range(3)])
    style = f'--orb-size:{size}px;--orb-dot:{dot}px;--orb-line:{line}px;--orb-c:{STATE_TOKEN[state]}'
    if extra_style:
        style += ';' + extra_style.strip(';')
    t = f' title="{title}"' if title else ''
    ring_html = ''.join(_ring_html(size, rng, *spec, k=i + 1) for i, spec in enumerate(rings))
    return (f'<div class="orb orb--{state}" style="{style}"{t}><div class="orb__w"><div class="orb__nw"><div class="orb__core">{"".join(parts)}</div></div>{ring_html}</div>'
            f'{exits}<!--/orb--></div>')

LEGACY = re.compile(
    r'<div style="width:(\d+)px;height:\1px;border-radius:9999px;background:radial-gradient\(circle at 35% 35%, '
    r'var\(--agent-(\w+)\), transparent 70%\), var\(--bg-overlay\)((?:;[^"]*)?)"></div>'
)
LATTICE = re.compile(
    r'<div class="orb orb--(\w+)" style="--orb-size:(\d+)px;--orb-tile:\d+px;--orb-r:[\d.]+px;--orb-c:var\(--agent-\w+\)((?:;[^"]*)?)"(?: title="[^"]*")?>'
    r'<div class="orb__core">.*?</div></div>'
)
CELL = re.compile(
    r'<div class="orb orb--(\w+)" style="--orb-size:(\d+)px;--orb-dot:\d+px;--orb-c:var\(--agent-\w+\)((?:;[^"]*)?)"(?: title="[^"]*")?>'
    r'<div class="orb__m">.*?<div class="orb__n"></div></div></div>'
)
NET = re.compile(
    r'<div class="orb orb--(\w+)" style="--orb-size:(\d+)px;--orb-dot:\d+px;--orb-line:[\d.]+px;--orb-c:var\(--agent-\w+\)((?:;[^"]*)?)"(?: title="[^"]*")?>'
    r'.*?<!--/orb--></div>'
)
DROP = re.compile(r'(?:^|;)\s*(?:animation|border|box-shadow|filter|opacity)\s*:[^;]*')
CSS_BLOCK = re.compile(r'    /\* ---- agent orb: [^\n]*\n.*?(?=  </style>\n</helmet>)', re.S)


def _clean(extra: str) -> str:
    return ';'.join(p for p in DROP.sub('', extra).split(';') if p.strip())


def convert(src: str) -> tuple[str, int]:
    count = 0

    def legacy(m):
        nonlocal count
        count += 1
        return orb_html(int(m.group(1)), m.group(2), _clean(m.group(3) or ''))

    def modern(m):
        nonlocal count
        count += 1
        return orb_html(int(m.group(2)), m.group(1), _clean(m.group(3) or ''))

    out = LEGACY.sub(legacy, src)
    out = LATTICE.sub(modern, out)
    out = CELL.sub(modern, out)
    out = NET.sub(modern, out)
    if count:
        if CSS_BLOCK.search(out):
            out = CSS_BLOCK.sub(lambda _: ORB_CSS, out, count=1)
        else:
            out = out.replace('  </style>\n</helmet>', ORB_CSS + '  </style>\n</helmet>', 1)
    return out, count


BOARD_STATES = [
    ('detached', 'Bridge on, no client activity', 'graph and rings there, dark and still'),
    ('idle', 'Connected, no recent action', 'a few pathways fire now and then'),
    ('reading', 'query / search / lines activity', 'many pathways; rings turn faster'),
    ('running', 'pipeline run in progress', 'whole graph cycles; rings race'),
    ('wrote', 'published analysis / created watch or bookmark', 'a path lights and leaves the sphere'),
    ('needs', 'consent prompt pending', 'rings stop and breathe bright; one pathway held'),
    ('raw', 'agentRawAccess is on', 'every pathway visible, slow; red never fades'),
]


def write_board() -> None:
    main = open('design_docs/canvas/Main.dc.html', encoding='utf-8').read()
    head = main[:main.index('<div class="theme-{{theme}}"')]
    head = CSS_BLOCK.sub(lambda _: ORB_CSS, head, count=1) if CSS_BLOCK.search(head) else head.replace('  </style>\n</helmet>', ORB_CSS + '  </style>\n</helmet>', 1)
    tail = main[main.rindex('<script data-dc-script'):].replace('"$preview":{"width":1920,"height":1080}', '"$preview":{"width":1600,"height":820}')
    cards = ''.join(f'''<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px 10px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-raised)">
        {orb_html(104, s)}
        <span style="font-weight:600;color:var(--text)">{"Needs you" if s == "needs" else s.capitalize()}</span>
        <span style="font-size:12px;color:var(--text-muted);text-align:center">{sig}</span>
        <span style="font:12px var(--font-mono);color:var(--text-subtle);text-align:center">{motion}</span>
      </div>''' for s, sig, motion in BOARD_STATES)
    sizes = ''.join(f'<div style="display:flex;flex-direction:column;align-items:center;gap:8px">{orb_html(n, "running")}<span style="font:11px var(--font-mono);color:var(--text-muted)">{n}px</span></div>' for n in (18, 26, 36, 44, 56, 96, 140))
    body = f'''<div class="theme-{{{{theme}}}}" style="width:1600px;height:820px;display:flex;flex-direction:column;gap:22px;padding:28px 32px;background:var(--bg-base);overflow:hidden">
  <div style="display:flex;align-items:baseline;gap:14px">
    <span style="font-size:20px;font-weight:600;color:var(--text)">Agent orb — network nucleus, broken rings</span>
    <span style="font-size:13px;color:var(--text-muted)">A cell whose nucleus is a network. Broken rings orbit outside it like instrumentation; inside, thought is signal moving along connections. Quiet when nothing happens.</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(7, minmax(0, 1fr));gap:14px">
      {cards}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;flex:1;min-height:0">
    <div style="display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--bg-raised)">
      <span style="font:600 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">Sizes (running state)</span>
      <div style="display:flex;align-items:flex-end;gap:26px;flex:1">{sizes}</div>
      <span style="font-size:12px;color:var(--text-subtle)">Top bar and rails use 18–28 px (one ring, a dozen nodes); panel headers 44–56 px get three rings; the expanded presence panel and first run use 96 px+ with four rings and the full graph.</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--bg-raised);font-size:13px;line-height:1.55;color:var(--text)">
      <span style="font:600 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">Anatomy &amp; rules</span>
      <div><b>Why a network.</b> This is what the agent is, structurally: many simple nodes, connections between them, and activity that is a pattern of signals moving along those connections. Nothing is hidden behind a surface; it is seen through, not looked at.</div>
      <div><b>Nucleus.</b> A sparse shell of nodes on a sphere and a denser core cluster for what is currently held. Each node links to its nearest neighbours; core nodes also reach the shell. The whole graph turns very slowly so depth reads.</div>
      <div><b>Rings.</b> Two to four concentric broken rings face the viewer around the nucleus: arcs of uneven length and brightness with gaps between, a fine tick ring among them, each with its own direction, period and start angle so nothing moves in lockstep; the nucleus adds a slow independent wobble. They are the instrument around the mind: they speed up with reading and running, stop and breathe bright when the agent needs you, and slow when raw access is on.</div>
      <div><b>Signal, not spin.</b> The primary motion is a pulse travelling along an edge. Pathways are tiered; each state enables tiers and sets speed, so idle fires a few, reading many, running all. No state performs "thinking" while nothing is happening.</div>
      <div><b>Direction means something.</b> Reading converges inward. Wrote lights a path that leaves the sphere: an output actually exited. Needs-you holds one pathway bright and still while the rings stop and breathe — blocked on a person, from the inside.</div>
      <div><b>Colour.</b> One token per state (<span style="font-family:var(--font-mono)">--agent-idle … --agent-raw</span>); nodes, edges, pulses and halo are mixed from it. No face, no eyes, no orientation toward the viewer — ever.</div>
      <div><b>Later.</b> The shared-focus handoff becomes a bright entry point on the shell where the human's context enters. Under <span style="font-family:var(--font-mono)">prefers-reduced-motion</span>: freeze the turn, keep pulses slow, keep colour and the ring.</div>
    </div>
  </div>
</div>

'''
    open('design_docs/canvas/AgentOrb.dc.html', 'w', encoding='utf-8', newline='\n').write(head + body + tail)
    c = json.load(open('design_docs/canvas/canvas.json', encoding='utf-8'))
    for a in c['artboards']:
        if a['file'] == 'AgentOrb.dc.html':
            a['title'] = '9 · Agent orb — the cell'
    json.dump(c, open('design_docs/canvas/canvas.json', 'w', encoding='utf-8', newline='\n'), indent=2, ensure_ascii=False)


if __name__ == '__main__':
    for p in sorted(glob.glob('design_docs/canvas/*.dc.html')):
        if p.endswith('AgentOrb.dc.html'):
            continue
        s = open(p, encoding='utf-8').read()
        o, n = convert(s)
        if n:
            open(p, 'w', encoding='utf-8', newline='\n').write(o)
        print(f'{p}: {n} orbs')
    write_board()
    print('AgentOrb.dc.html rewritten')
