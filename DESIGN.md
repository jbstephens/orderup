# ORDER UP! — the Stephens Diner

Ticket-rush cooking game for the Stephens Arcade. Origin: the Replit
prototype John built with Ben and Luke (tickets arrive → assemble menu
items from ingredients → ticket clears → next ticket). Full-license
rebuild with the house's modern look and feel. DECIDED 2026-09-12 —
implement as written; tune numbers for fun.

## Core loop
- Tickets slide onto a rail at the top of the kitchen. Each ticket shows
  its dish as a readable stacked pictogram (e.g. bun / patty / cheese /
  lettuce / bun) — kids read pictures, not words.
- The counter below holds the ingredient grid. Moving the highlight and
  pressing ✕ adds that ingredient to the build plate — and THE BUILD IS
  THE SHOW: each layer visibly drops onto the stack with a squashy
  bounce, particles (sesame seeds, steam, sauce drips), and a musical
  "plop" that rises in pitch per layer. The assembling burger/pie/shake
  is the hero of the screen.
- Exact stack match → AUTO-SERVE: bell DING!, plate slides to the pass,
  ticket flies off the rail, tips ring up. No serve button to fumble —
  finishing IS the reward. ○ scraps the current build (fun garbage-lid
  gag, tiny cost, never punishing). Wrong ingredient = it comically
  bounces off the plate (instructive, rate-limited — Maria's law), never
  a fail state.
- Menu: burgers (3–6 layers), fries basket, shakes (cup+flavor+topping),
  slice pies (crust+filling+lattice), hot dogs, pancake stacks — each
  dish family 3–5 picks. Days introduce dishes one at a time ("NEW ON
  THE MENU!" banner).

## Structure & kid-proofing
- Service runs in DAYS (~2–3 minutes). Tickets have patience faces that
  drift unhappy, but a run NEVER hard-fails: an expired ticket walks
  away with a sad-but-gentle beat and the day always finishes. End of
  day = report card (tips, orders served, star rating 1–3) + a
  celebration proportional to the stars.
- Score = TIPS. Combo multiplier for consecutive no-mistake orders.
  localStorage: best tips per day + stars (slug-prefixed keys).
- Light meta: tips buy diner cosmetics between days (neon sign colors,
  jukebox, counter finish) — pure pride, nothing gated.
- House flavor: it's THE STEPHENS DINER. Sammy the (brown, male) cat
  naps on a stool. Customer chatter in the house voice — short, warm,
  kid-logic, no sarcasm.

## 2P
- Drop-in co-op: "P2 PRESS ✕ TO JOIN" on title and between days.
  Vertical split — each cook gets their own counter and ticket rail,
  tips pool into one shared register (house style), with a friendly
  per-cook "orders served" tally on the day card. 1P is the default and
  fully first-class.

## Controls
- Pad: stick/d-pad moves the ingredient highlight (held-direction
  repeat), ✕ add ingredient, ○ scrap build, START pause. △ makes your
  cook flip their spatula (pure delight, no mechanic). Prompts name the
  diamond positions. Every state pad-reachable.
- Keyboard: WASD/arrows + J/K equivalents, P pause.
- Touch: the shared virtual pad comes free via controller.js; ALSO keep
  direct tap-an-ingredient as a first-class gesture (tap = add). No
  bespoke touch UI beyond that.

## The look (this is the point — NOT cheesy)
- Committed mood: warm diner at golden hour — chrome, checkerboard
  floor, big windows with low sun, neon signage with BAKED gradient
  glows. One palette, declared up front, everything obeys it.
- Food art is appetizing: chunky layered sprites with baked highlights
  and occlusion, pre-rendered at load. Plates, ticket paper texture,
  steam wisps. Subtle baked vignette. It should read like a poster, not
  programmer art.
- All Stephens perf commandments apply: no shadowBlur, no
  backdrop-filter, prebaked everything, <150 drawImage and ~0 path ops
  per frame, pooled particles, lazy WebAudio. `?fx=low` trims cosmetic
  extras.

## Ship facts
- Repo: ~/Developer/stephensgames/orderup → jbstephens/orderup (John
  creates the GitHub repo + Render static site "orderup" before ship).
- Single self-contained index.html. Slug `order-up`, title "ORDER UP!",
  genre COOKING. Carousel icon: a layered burger with a ticket spike.
