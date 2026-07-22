# Bold Agency — Service Page Content

A one-shot Figma plugin that rewrites the copy on the six service pages in the
**Bold Agency** file so each page reads about the service it's named for —
Logo Design, Visual Identity, Social Media Management, Creative Campaigns,
Performance Marketing, and Web Development.

The **Motion Design** page is the reference for tone and layout and is **never
modified**. All new copy is written in that same voice: short, confident,
contrarian setups (“X isn't Y — it's Z”), em-dashes, direct address, and
concrete, results-first language.

## What it rewrites on each page

- Breadcrumb page name
- Hero headline (both lines) + subtitle
- Overview heading + body
- The three stats (numbers + labels)
- Deliverables section heading + the four deliverable cards (title + description)
- Process section heading + subtitle + the four workflow steps (title + description)

It intentionally **leaves untouched** the shared/generic pieces: section
eyebrows (“What it is”, “Deliverables”, “Projects”, “Progress”, “FAQs”),
the Projects and FAQ headings, the FAQ questions, testimonials, the CTA, the
footer, the navbar, and the contact form.

## How the mapping stays reliable

The seven `Single Service — <Name>` frames are structural clones, so every text
layer sits at the same position in each frame. The plugin walks each frame's
text layers with a depth-first traversal that skips component instances, which
produces an identical ordered list on every page, and then addresses each field
by its index in that list. The deliverable cards (whose text lives inside the
shared `dev` component) are handled separately by matching the reference card
titles and rewriting each card's title and description together.

## Install & run

1. In the Figma desktop app, open the **Bold Agency** file.
2. **Menu → Plugins → Development → Import plugin from manifest…**
3. Select `service-content-plugin/manifest.json` from this repo.
4. Run **Plugins → Development → Bold Agency — Service Page Content**.
5. Click **Rewrite service pages**. The log shows exactly which layers changed.

The plugin runs fully offline and only reads/writes text layers in the open
file. Editing the copy is as simple as changing the strings in the `CONTENT`
object in `code.js` and re-importing.

## Note on re-running

The plugin rewrites the reference (Motion) strings into service-specific ones,
so it's meant to be run **once per file**. Re-running is harmless — the
index-based fields simply overwrite whatever text is currently in place.
