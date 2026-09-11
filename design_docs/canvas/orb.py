"""Agent orb generator for the redesign canvas — the "cell" orb.

A translucent membrane with a bright rim, a dense speckled nucleus inside its own
envelope, drifting organelles, tilted orbit rings carrying particles, and per-state
behaviour (radar sweep when reading, emission from the nucleus when running, ...).
Pure CSS; every colour derives from one state token via color-mix.

    python design_docs/canvas/orb.py            # rewrites every orb in *.dc.html + AgentOrb board
    from orb import orb_html, ORB_CSS
"""
import glob
import json
import math
import random
import re

ORB_CSS = """    /* ---- agent orb: cell ---- */
    @property --orb-a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
    .orb { position: relative; flex-shrink: 0; width: var(--orb-size); height: var(--orb-size); --c: var(--orb-c); }
    .orb::after { content: ''; position: absolute; inset: -14%; border-radius: 9999px; pointer-events: none; background: radial-gradient(circle, transparent 52%, color-mix(in srgb, var(--c) 22%, transparent) 66%, transparent 76%); }
    .orb__m { position: absolute; inset: 0; border-radius: 9999px; overflow: hidden; isolation: isolate; transform: translateZ(0);
      background: radial-gradient(circle at 32% 26%, rgba(255,255,255,.26), rgba(255,255,255,0) 36%),
                  radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--c) 5%, transparent) 0%, color-mix(in srgb, var(--c) 9%, transparent) 58%, color-mix(in srgb, var(--c) 42%, transparent) 88%, color-mix(in srgb, var(--c) 85%, transparent) 100%);
      box-shadow: inset 0 0 calc(var(--orb-size) / 9) color-mix(in srgb, var(--c) 50%, transparent);
      border: 1px solid color-mix(in srgb, var(--c) 60%, transparent); }
    .orb__n { position: absolute; left: 47%; top: 48%; width: var(--orb-nw, 40%); height: var(--orb-nw, 40%); border-radius: 9999px; transform: translate(-50%, -50%);
      background: radial-gradient(circle at 36% 32%, rgba(255,255,255,.5), transparent 34%),
                  radial-gradient(circle at 56% 58%, color-mix(in srgb, var(--c) 55%, #fff) 0 9%, color-mix(in srgb, var(--c) 40%, #000) 10%, transparent 13%),
                  radial-gradient(circle at 35% 52%, color-mix(in srgb, var(--c) 30%, #000) 0 2.9%, transparent 3.9%),
                  radial-gradient(circle at 56% 57%, color-mix(in srgb, var(--c) 30%, #000) 0 2.3%, transparent 3.3%),
                  radial-gradient(circle at 23% 69%, color-mix(in srgb, var(--c) 30%, #000) 0 2.7%, transparent 3.7%),
                  radial-gradient(circle at 35% 78%, color-mix(in srgb, var(--c) 30%, #000) 0 3.1%, transparent 4.1%),
                  radial-gradient(circle at 69% 49%, color-mix(in srgb, var(--c) 30%, #000) 0 3.5%, transparent 4.5%),
                  radial-gradient(circle at 30% 58%, color-mix(in srgb, var(--c) 30%, #000) 0 3.9%, transparent 4.9%),
                  radial-gradient(circle at 51% 64%, color-mix(in srgb, var(--c) 30%, #000) 0 3.5%, transparent 4.5%),
                  radial-gradient(circle at 26% 64%, color-mix(in srgb, var(--c) 30%, #000) 0 3.4%, transparent 4.4%),
                  radial-gradient(circle at 39% 24%, color-mix(in srgb, var(--c) 30%, #000) 0 3.9%, transparent 4.9%),
                  radial-gradient(circle, color-mix(in srgb, var(--c) 90%, #fff) 0%, var(--c) 48%, color-mix(in srgb, var(--c) 65%, #000) 100%);
      box-shadow: 0 0 calc(var(--orb-size) / 7) color-mix(in srgb, var(--c) 75%, transparent), inset 0 0 calc(var(--orb-size) / 18) rgba(0,0,0,.4);
      animation: orb-nuc var(--orb-nuc, 4.5s) ease-in-out infinite; }
    .orb__n::after { content: ''; position: absolute; inset: -14%; border-radius: 9999px; border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 18%, transparent); }
    @keyframes orb-nuc { 0%, 100% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.07); } }
    .orb__o { position: absolute; border-radius: 9999px; opacity: .5; background: linear-gradient(135deg, color-mix(in srgb, var(--c) 70%, #fff), color-mix(in srgb, var(--c) 45%, transparent)); box-shadow: inset 0 0 0 1px rgba(255,255,255,.28), 0 0 calc(var(--orb-size) / 30) color-mix(in srgb, var(--c) 40%, transparent);
      animation: orb-drift var(--t) ease-in-out infinite alternate; animation-delay: var(--dl); }
    @keyframes orb-drift { 0% { transform: translate(0, 0) rotate(var(--rot)); } 35% { transform: translate(var(--dx), var(--dy)) rotate(calc(var(--rot) + 18deg)); } 70% { transform: translate(calc(var(--dx) * -.7), calc(var(--dy) * .4)) rotate(calc(var(--rot) - 12deg)); } 100% { transform: translate(calc(var(--dx) * .3), calc(var(--dy) * -1)) rotate(var(--rot)); } }
    .orb__r { position: absolute; left: 50%; top: 50%; width: var(--rw); height: var(--rw); margin: calc(var(--rw) / -2) 0 0 calc(var(--rw) / -2); border-radius: 9999px; border: 1px solid transparent;
      border-top-color: color-mix(in srgb, var(--c) 75%, transparent); border-right-color: color-mix(in srgb, var(--c) 22%, transparent);
      transform: rotate3d(1, .2, 0, var(--tilt)) rotate(var(--orb-a)); animation: orb-ring var(--t) linear infinite; animation-delay: var(--dl); }
    .orb__r i { position: absolute; left: 50%; top: -1px; width: var(--orb-dot); height: var(--orb-dot); margin: calc(var(--orb-dot) / -2) 0 0 calc(var(--orb-dot) / -2); border-radius: 9999px; background: #fff; box-shadow: 0 0 calc(var(--orb-dot) * 1.5) var(--c), 0 0 2px #fff; }
    @keyframes orb-ring { to { --orb-a: 360deg; } }
    .orb__s { display: none; position: absolute; inset: 0; border-radius: 9999px; background: conic-gradient(from 0deg, transparent 0 68%, color-mix(in srgb, var(--c) 40%, transparent) 100%); animation: orb-sweep 1.6s linear infinite; }
    @keyframes orb-sweep { to { transform: rotate(360deg); } }
    .orb__e { display: none; position: absolute; left: 47%; top: 48%; width: var(--orb-dot); height: var(--orb-dot); margin: calc(var(--orb-dot) / -2) 0 0 calc(var(--orb-dot) / -2); border-radius: 9999px; background: #fff; box-shadow: 0 0 calc(var(--orb-dot) * 1.5) var(--c);
      animation: orb-emit var(--orb-emit, 1.4s) ease-out infinite; animation-delay: var(--dl); }
    @keyframes orb-emit { 0% { transform: translate(0, 0) scale(1); opacity: 1; } 70% { opacity: .9; } 100% { transform: translate(var(--ex), var(--ey)) scale(.4); opacity: 0; } }
    /* detached: dim, still */
    .orb--detached { filter: saturate(.25) brightness(.7); } .orb--detached::after { opacity: 0; } .orb--detached .orb__m, .orb--detached .orb__n, .orb--detached .orb__o, .orb--detached .orb__r { animation-play-state: paused; }
    /* reading: rings speed up, a sweep circles the cytoplasm */
    .orb--reading .orb__s { display: block; } .orb--reading .orb__r { animation-duration: calc(var(--t) / 2.5); } .orb--reading { --orb-nuc: 2.4s; }
    /* running: nucleus pumps, rings race, particles emit from the nucleus to the membrane */
    .orb--running { --orb-nuc: 1s; } .orb--running .orb__e { display: block; } .orb--running .orb__r { animation-duration: calc(var(--t) / 4); } .orb--running .orb__o { animation-duration: calc(var(--t) / 2); }
    /* wrote: one flare of the membrane and a single emission burst, then settles (loops slowly in the mockup) */
    .orb--wrote .orb__m { animation: orb-flare 5s ease-out infinite; } .orb--wrote .orb__e { display: block; --orb-emit: 5s; }
    @keyframes orb-flare { 0% { box-shadow: inset 0 0 calc(var(--orb-size) / 4) color-mix(in srgb, var(--c) 95%, #fff), 0 0 calc(var(--orb-size) / 3) color-mix(in srgb, var(--c) 80%, transparent); filter: brightness(1.7); } 20% { filter: brightness(1); box-shadow: inset 0 0 calc(var(--orb-size) / 9) color-mix(in srgb, var(--c) 50%, transparent); } 100% { box-shadow: inset 0 0 calc(var(--orb-size) / 9) color-mix(in srgb, var(--c) 50%, transparent); } }
    /* needs you: attention ring outside, organelles jitter, nucleus quickens */
    .orb--needs { --orb-nuc: .9s; } .orb--needs::before { content: ''; position: absolute; inset: -5px; border-radius: 9999px; animation: lt-pulse 1.4s ease-out infinite; } .orb--needs .orb__o { animation: orb-jitter .5s steps(2, jump-none) infinite; animation-delay: var(--dl); }
    @keyframes orb-jitter { 0%, 100% { transform: translate(0, 0) rotate(var(--rot)); } 50% { transform: translate(1.5px, -1px) rotate(calc(var(--rot) + 6deg)); } }
    /* raw access on: denser nucleus, steadier, warmer membrane */
    .orb--raw { --orb-nw: 50%; --orb-nuc: 7s; } .orb--raw .orb__m { border-color: color-mix(in srgb, var(--c) 85%, transparent); box-shadow: inset 0 0 calc(var(--orb-size) / 6) color-mix(in srgb, var(--c) 70%, transparent); }
"""

STATE_TOKEN = {
    'detached': 'var(--agent-idle)', 'idle': 'var(--agent-idle)', 'reading': 'var(--agent-reading)',
    'running': 'var(--agent-running)', 'wrote': 'var(--agent-wrote)', 'needs': 'var(--agent-needs)', 'raw': 'var(--agent-raw)',
}
STATES = list(STATE_TOKEN)


def _detail(size: int) -> tuple[int, int, int]:
    """(organelles, rings, emitters) by diameter."""
    if size < 24:
        return 0, 1, 3
    if size < 40:
        return 4, 2, 4
    if size < 80:
        return 7, 3, 6
    return 11, 3, 8


def orb_html(size: int, state: str, extra_style: str = '', title: str | None = None) -> str:
    rng = random.Random(size * 7 + STATES.index(state))
    n_org, n_ring, n_emit = _detail(size)
    dot = max(2, round(size / 14))
    parts = ['<div class="orb__s"></div>']
    # rings: three tilts so they read as a 3D cage around the nucleus
    for k in range(n_ring):
        rw = (0.86, 0.70, 0.94)[k]
        tilt = (64, -58, 78)[k]
        t = (9, 14, 20)[k]
        parts.append(f'<div class="orb__r" style="--rw:{rw * 100:.0f}%;--tilt:{tilt}deg;--t:{t}s;--dl:{-rng.uniform(0, t):.1f}s"><i></i></div>')
    # organelles: elongated blobs placed in the cytoplasm, outside the nucleus
    for _ in range(n_org):
        ang = rng.uniform(0, 2 * math.pi)
        rad = rng.uniform(0.30, 0.42)
        cx, cy = 0.5 + rad * math.cos(ang), 0.5 + rad * math.sin(ang)
        w, h = rng.uniform(0.07, 0.14), rng.uniform(0.04, 0.07)
        t = rng.uniform(5, 11)
        parts.append(
            f'<div class="orb__o" style="left:{(cx - w / 2) * 100:.0f}%;top:{(cy - h / 2) * 100:.0f}%;width:{w * 100:.0f}%;height:{h * 100:.0f}%;'
            f'--rot:{rng.uniform(0, 180):.0f}deg;--t:{t:.1f}s;--dl:{-rng.uniform(0, t):.1f}s;'
            f'--dx:calc(var(--orb-size) * {rng.uniform(-.06, .06):.3f});--dy:calc(var(--orb-size) * {rng.uniform(-.06, .06):.3f})"></div>')
    # emitters: nucleus -> membrane
    for k in range(n_emit):
        ang = 2 * math.pi * k / n_emit + rng.uniform(-.3, .3)
        parts.append(f'<div class="orb__e" style="--ex:calc(var(--orb-size) * {0.46 * math.cos(ang):.3f});--ey:calc(var(--orb-size) * {0.46 * math.sin(ang):.3f});--dl:{-rng.uniform(0, 1.4):.2f}s"></div>')
    parts.append('<div class="orb__n"></div>')
    style = f'--orb-size:{size}px;--orb-dot:{dot}px;--orb-c:{STATE_TOKEN[state]}'
    if extra_style:
        style += ';' + extra_style.strip(';')
    t = f' title="{title}"' if title else ''
    return f'<div class="orb orb--{state}" style="{style}"{t}><div class="orb__m">{"".join(parts)}</div></div>'


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
    if count:
        if CSS_BLOCK.search(out):
            out = CSS_BLOCK.sub(lambda _: ORB_CSS, out, count=1)
        else:
            out = out.replace('  </style>\n</helmet>', ORB_CSS + '  </style>\n</helmet>', 1)
    return out, count


BOARD_STATES = [
    ('detached', 'Bridge on, no client activity', 'dim, everything still'),
    ('idle', 'Connected, no recent action', 'organelles drift, nucleus breathes'),
    ('reading', 'query / search / lines activity', 'rings speed up, a sweep circles the cytoplasm'),
    ('running', 'pipeline run in progress', 'nucleus pumps, particles emit to the membrane'),
    ('wrote', 'published analysis / created watch or bookmark', 'membrane flares once, single burst, settles'),
    ('needs', 'consent prompt pending', 'attention ring outside, organelles jitter'),
    ('raw', 'agentRawAccess is on', 'denser nucleus, steady, red membrane'),
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
    <span style="font-size:20px;font-weight:600;color:var(--text)">Agent orb — the cell</span>
    <span style="font-size:13px;color:var(--text-muted)">A living cell: translucent membrane, dense nucleus, moving internals. Motion is state-driven from the activity journal and bridge status; never decorative.</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(7, minmax(0, 1fr));gap:14px">
      {cards}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;flex:1;min-height:0">
    <div style="display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--bg-raised)">
      <span style="font:600 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">Sizes (running state)</span>
      <div style="display:flex;align-items:flex-end;gap:26px;flex:1">{sizes}</div>
      <span style="font-size:12px;color:var(--text-subtle)">Top bar and rails use 18–28 px (membrane, nucleus, one ring); panel headers 44–56 px add organelles; the expanded presence panel and first run use 96 px+ with the full cage.</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--bg-raised);font-size:13px;line-height:1.55;color:var(--text)">
      <span style="font:600 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">Anatomy &amp; rules</span>
      <div><b>Membrane.</b> A translucent sphere with a Fresnel rim: near-clear at the centre, bright at the edge, a specular highlight top-left and an outer halo. Everything inside is clipped to it.</div>
      <div><b>Nucleus.</b> Dense, slightly off-centre, speckled with chromatin, inside its own thin envelope. It breathes slowly at rest and pumps when the agent works.</div>
      <div><b>Internals.</b> Organelles drift on their own loops; three tilted rings form a cage, each carrying a bright particle; when running, particles emit from the nucleus to the membrane.</div>
      <div><b>Colour.</b> One token per state (<span style="font-family:var(--font-mono)">--agent-idle … --agent-raw</span>). Membrane, nucleus, rings and halo are all mixed from it, so a theme swap or a user theme restyles the cell for free.</div>
      <div><b>Motion budget.</b> Opacity, transform and one registered angle property only; each layer composites on the GPU. Honour <span style="font-family:var(--font-mono)">prefers-reduced-motion</span>: freeze the drift and rings, keep colour and the needs-you ring.</div>
      <div><b>Truthfulness.</b> Reading, running and wrote hold for a minimum beat so a 40 ms query still registers. Needs-you persists until answered. The raw-access tint never animates away.</div>
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
