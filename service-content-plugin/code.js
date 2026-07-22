// Bold Agency — Service Page Content
// -----------------------------------------------------------------------------
// Rewrites the copy on each "Single Service — <Name>" frame so it matches the
// service the page is about, keeping the exact voice of the existing
// "Single Service — Motion Design" page (which is treated as the reference and
// is never modified).
//
// HOW IT MAPS TEXT RELIABLY
// The seven service frames are structural clones of one another — same layers,
// same order. So every editable text layer sits at the SAME position in each
// frame. We collect the text layers of a frame with a depth-first walk that
// deliberately skips COMPONENT INSTANCES (navbar, footer, buttons, FAQ items,
// the "dev" deliverables component). That walk produces the exact same ordered
// list on every frame, so we can address a field by its index in that list.
// The one section whose copy lives inside an instance — the "dev" deliverables
// cards — is handled separately, by matching the reference card titles inside
// that instance and rewriting each card's title + description together.
//
// The plugin is not idempotent by design: it rewrites the reference (Motion)
// strings into service-specific ones. Run it once per file. Re-running is safe
// (it simply won't find the old strings again for the deliverables), but the
// index-based fields will overwrite whatever is currently there.
// -----------------------------------------------------------------------------

// Index of each editable field within the instance-skipping text walk.
// Validated against both the Motion Design and Logo Design frames.
const FIELD_INDEX = {
  pageName: 1, // breadcrumb: "Services  >  <pageName>"
  heroLine1: 2, // hero headline, first line (ends with a comma)
  heroHighlight: 3, // hero headline, highlighted completion
  heroSubtitle: 4,
  overviewHeading: 6, // index 5 ("What it is" eyebrow) is left untouched
  overviewBody: 7,
  stat1Num: 8,
  stat1Label: 9,
  stat2Num: 10,
  stat2Label: 11,
  stat3Num: 12,
  stat3Label: 13,
  deliverablesHeading: 15, // index 14 ("Deliverables" eyebrow) untouched
  // 16-19 (Projects eyebrow/heading/subtitle, "Progress" eyebrow) untouched
  processHeading: 20,
  processSubtitle: 21,
  step1Title: 22,
  step1Desc: 23,
  step2Title: 24,
  step2Desc: 25,
  step3Title: 26,
  step3Desc: 27,
  step4Title: 28,
  step4Desc: 29,
  // 30+ (FAQ eyebrow/heading/subtitle/tabs, testimonials, CTA, form) untouched
};

// Reference titles as they currently read inside the shared "dev" deliverables
// component. Used only to locate each card; the new copy replaces them.
const DELIVERABLE_REF_TITLES = [
  "Motion style guidelines",
  "Short-form video & Reels",
  "Animated brand assets",
  "Motion graphics",
];

// -----------------------------------------------------------------------------
// The generated copy. Keyed by the exact frame name. Motion Design is omitted
// on purpose — it is the reference and stays as-is.
// -----------------------------------------------------------------------------
const CONTENT = {
  "Single Service — Logo Design": {
    fields: {
      pageName: "Logo Design",
      heroLine1: "A Logo Isn't a Picture,",
      heroHighlight: "It's a Signature",
      heroSubtitle:
        "We design marks built to work everywhere — a single symbol that carries your whole brand at a glance, not just a nice shape.",
      overviewHeading: "A logo isn't decoration. It's the shortest version of your brand",
      overviewBody:
        "A mark has to survive a favicon, a billboard, and everything between. We draw logos with the same discipline as the rest of your brand system — one idea, one intent, one voice — so it reads instantly and ages well instead of chasing a trend.",
      stat1Num: "3s",
      stat1Label: "All it takes to recognise a strong mark",
      stat2Num: "12+",
      stat2Label: "Logo variations delivered per project",
      stat3Num: "100%",
      stat3Label: "Vector, scalable to any size",
      deliverablesHeading: "Everything Your Mark Needs",
      processHeading: "How Your Mark Gets Made",
      processSubtitle: "Four steps from rough sketch to final files.",
      step1Title: "Research & references",
      step1Desc: "we study your market before we draw a single curve",
      step2Title: "Sketching & concepts",
      step2Desc: "directions explored on paper before anything goes digital",
      step3Title: "Refinement & vectors",
      step3Desc: "the chosen mark drawn precisely and tested at every size",
      step4Title: "Delivery & guidelines",
      step4Desc: "every file format, plus the rules to use them right",
    },
    deliverables: [
      { title: "Primary logo", desc: "The hero mark, drawn to lead everywhere your brand shows up" },
      { title: "Logo suite & lockups", desc: "Horizontal, stacked, and icon versions for every layout" },
      { title: "Responsive variations", desc: "Marks that hold up from favicon to billboard" },
      { title: "Clear-space & usage rules", desc: "The guardrails that keep your logo consistent" },
    ],
  },

  "Single Service — Visual Identity": {
    fields: {
      pageName: "Visual Identity",
      heroLine1: "A Brand Isn't One Logo,",
      heroHighlight: "It's a System",
      heroSubtitle:
        "We build complete identity systems — colour, type, and rules that make your brand recognisable long before anyone reads the name.",
      overviewHeading: "Identity isn't a logo. It's every decision after it",
      overviewBody:
        "A logo is the start, not the system. We design the full visual language around it — consistent colour, consistent type, consistent spacing — so every touchpoint looks unmistakably yours, whoever builds it next.",
      stat1Num: "3.5x",
      stat1Label: "More memorable with consistent branding",
      stat2Num: "1",
      stat2Label: "System behind every touchpoint",
      stat3Num: "50+",
      stat3Label: "Ready-to-use brand assets delivered",
      deliverablesHeading: "Everything Your Brand Needs",
      processHeading: "How the System Comes Together",
      processSubtitle: "From strategy to a kit your whole team can use.",
      step1Title: "Discovery & strategy",
      step1Desc: "we define what the brand stands for before we style it",
      step2Title: "Moodboards & direction",
      step2Desc: "the visual world agreed on before we build it out",
      step3Title: "System design",
      step3Desc: "colour, type, and layout rules built to scale",
      step4Title: "Guidelines & handoff",
      step4Desc: "everything documented so the brand stays consistent",
    },
    deliverables: [
      { title: "Colour & type system", desc: "The palette and typefaces that carry your voice" },
      { title: "Brand guidelines", desc: "One source of truth so nothing drifts off-brand" },
      { title: "Logo & mark suite", desc: "Every version your brand needs to show up" },
      { title: "Templates & assets", desc: "Ready-made pieces your team can run with" },
    ],
  },

  "Single Service — Social Media Management": {
    fields: {
      pageName: "Social Media Management",
      heroLine1: "Posting Isn't a Strategy,",
      heroHighlight: "Showing Up Is",
      heroSubtitle:
        "We run social like a system — content, calendar, and community built to grow an audience, not just keep the grid full.",
      overviewHeading: "Social isn't a chore. It's your most public sales channel",
      overviewBody:
        "Every scroll is a chance to be chosen or ignored. We manage your channels with the same discipline as the rest of your brand — consistent voice, consistent cadence, consistent quality — so your feed builds trust instead of noise.",
      stat1Num: "3x",
      stat1Label: "More engagement with a consistent cadence",
      stat2Num: "20+",
      stat2Label: "Posts planned and produced each month",
      stat3Num: "24h",
      stat3Label: "Average community response time",
      deliverablesHeading: "Everything Your Channels Need",
      processHeading: "How We Run Your Socials",
      processSubtitle: "A repeatable loop, not a scramble every week.",
      step1Title: "Strategy & pillars",
      step1Desc: "we set the themes before we fill the calendar",
      step2Title: "Content production",
      step2Desc: "posts designed and written a month ahead",
      step3Title: "Scheduling & publishing",
      step3Desc: "everything queued to go live at the right time",
      step4Title: "Engage & report",
      step4Desc: "we join the conversation, then measure what moved",
    },
    deliverables: [
      { title: "Content calendar", desc: "Every post planned, so nothing goes out on a guess" },
      { title: "Post design & copy", desc: "On-brand visuals and words, ready to publish" },
      { title: "Community management", desc: "Replies and DMs handled in your voice" },
      { title: "Monthly reporting", desc: "What worked, what didn't, and what's next" },
    ],
  },

  "Single Service — Creative Campaigns": {
    fields: {
      pageName: "Creative Campaigns",
      heroLine1: "A Campaign Isn't More Ads,",
      heroHighlight: "It's One Big Idea",
      heroSubtitle:
        "We build campaigns around a single idea — concept, assets, and rollout designed to be remembered, not just seen once and scrolled past.",
      overviewHeading: "A campaign isn't noise. It's one idea, everywhere",
      overviewBody:
        "Scattered posts don't add up to a campaign. We build around one strong concept and carry it across every channel — consistent story, consistent look, consistent message — so the whole thing lands harder than the sum of its parts.",
      stat1Num: "1",
      stat1Label: "Big idea behind every campaign",
      stat2Num: "6+",
      stat2Label: "Channels covered per launch",
      stat3Num: "2x",
      stat3Label: "Recall versus one-off posts",
      deliverablesHeading: "Everything Your Launch Needs",
      processHeading: "How a Campaign Comes to Life",
      processSubtitle: "From a blank page to a launch that lands.",
      step1Title: "Brief & big idea",
      step1Desc: "we lock the concept before we make anything",
      step2Title: "Concept & key visual",
      step2Desc: "the hero look that sets the tone for it all",
      step3Title: "Production & adaptation",
      step3Desc: "the idea built out for every channel it runs on",
      step4Title: "Launch & measure",
      step4Desc: "we ship the rollout, then track what it moved",
    },
    deliverables: [
      { title: "Campaign concept", desc: "The single idea everything else hangs on" },
      { title: "Key visuals", desc: "Hero assets built to anchor the whole rollout" },
      { title: "Channel adaptations", desc: "One idea, resized and tuned for every platform" },
      { title: "Rollout plan", desc: "What goes where, and in what order" },
    ],
  },

  "Single Service — Performance Marketing": {
    fields: {
      pageName: "Performance Marketing",
      heroLine1: "Impressions Don't Pay Bills,",
      heroHighlight: "Conversions Do",
      heroSubtitle:
        "We run paid media built to sell — creative, targeting, and testing tuned to return, not just reach.",
      overviewHeading: "Performance isn't guesswork. It's math with creative",
      overviewBody:
        "Ad spend without a system is just donation. We run paid media with the same discipline as the rest of your brand — consistent testing, consistent tracking, consistent iteration — so every dollar is accountable to a number, not a hunch.",
      stat1Num: "4.2x",
      stat1Label: "Average return on ad spend",
      stat2Num: "38%",
      stat2Label: "Lower cost per acquisition after testing",
      stat3Num: "100+",
      stat3Label: "Ad variations tested per account",
      deliverablesHeading: "Everything Your Funnel Needs",
      processHeading: "How We Drive Returns",
      processSubtitle: "Test, measure, scale — then do it again.",
      step1Title: "Audit & strategy",
      step1Desc: "we find the leaks before we spend a cent",
      step2Title: "Creative & setup",
      step2Desc: "ads and audiences built to be tested, not guessed",
      step3Title: "Launch & test",
      step3Desc: "campaigns live, variations racing against each other",
      step4Title: "Optimise & scale",
      step4Desc: "we cut what fails and pour into what wins",
    },
    deliverables: [
      { title: "Ad creative", desc: "Scroll-stopping assets built to convert, not just look good" },
      { title: "Audience & targeting", desc: "The right people, not the most people" },
      { title: "A/B testing", desc: "Constant experiments to find what actually works" },
      { title: "Reporting & ROAS", desc: "Clear numbers tied to what you spent" },
    ],
  },

  "Single Service — Web Development": {
    fields: {
      pageName: "Web Development",
      heroLine1: "A Website Isn't a Brochure,",
      heroHighlight: "It's Your Engine",
      heroSubtitle:
        "We build fast, responsive sites that turn visitors into customers — engineered to perform, not just to launch.",
      overviewHeading: "A site isn't decoration. It's where the brand does its work",
      overviewBody:
        "A slow, pretty site still loses. We build with the same discipline as the rest of your brand — consistent design, consistent speed, consistent structure — so the experience feels like you and works on every device, not just the designer's screen.",
      stat1Num: "<1s",
      stat1Label: "Average page load we build toward",
      stat2Num: "100",
      stat2Label: "Lighthouse performance we aim for",
      stat3Num: "100%",
      stat3Label: "Responsive across every device",
      deliverablesHeading: "Everything Your Site Needs",
      processHeading: "How Your Site Gets Built",
      processSubtitle: "From wireframe to a live, fast website.",
      step1Title: "Plan & wireframe",
      step1Desc: "we map the structure before we write any code",
      step2Title: "Design & build",
      step2Desc: "your brand turned into responsive, real pages",
      step3Title: "Test & optimise",
      step3Desc: "every device, every speed check, before launch",
      step4Title: "Launch & support",
      step4Desc: "we go live, then keep it fast and current",
    },
    deliverables: [
      { title: "Responsive build", desc: "One site that works on every screen size" },
      { title: "CMS integration", desc: "Update content yourself, no developer needed" },
      { title: "Performance & SEO", desc: "Fast to load and easy to find" },
      { title: "Launch & support", desc: "We ship it, then keep it running" },
    ],
  },
};

// -----------------------------------------------------------------------------
// Runtime
// -----------------------------------------------------------------------------
figma.showUI(__html__, { width: 380, height: 560 });

const log = (line, kind) => figma.ui.postMessage({ type: "log", line, kind: kind || "info" });

// Load whatever fonts a node uses, then set its text. Handles mixed-font runs
// and empty nodes. Returns true on success.
async function setText(node, text) {
  try {
    if (node.characters.length > 0) {
      const fonts = node.getRangeAllFontNames(0, node.characters.length);
      for (const f of fonts) await figma.loadFontAsync(f);
    } else {
      const f = node.fontName;
      if (f !== figma.mixed) await figma.loadFontAsync(f);
    }
    node.characters = text;
    return true;
  } catch (e) {
    log(`      ⚠︎ could not set text (${e.message})`, "warn");
    return false;
  }
}

// Depth-first list of TEXT layers, skipping component instances so the ordering
// is identical across every service frame.
function collectNonInstanceTexts(node, out) {
  const kids = node.children || [];
  for (const child of kids) {
    if (child.type === "INSTANCE") continue;
    if (child.type === "TEXT") out.push(child);
    if ("children" in child) collectNonInstanceTexts(child, out);
  }
}

async function applyDeliverables(frame, deliverables, counters) {
  const dev = frame.findOne((n) => n.type === "INSTANCE" && n.name === "dev");
  if (!dev) {
    log("      ⚠︎ deliverables component ('dev') not found — cards skipped", "warn");
    return;
  }
  for (let i = 0; i < deliverables.length; i++) {
    const refTitle = DELIVERABLE_REF_TITLES[i];
    const card = deliverables[i];
    const titleNode = dev.findOne(
      (n) => n.type === "TEXT" && n.characters.trim() === refTitle
    );
    if (!titleNode) {
      log(`      ⚠︎ deliverable card "${refTitle}" not found — skipped`, "warn");
      continue;
    }
    const parent = titleNode.parent;
    const textKids = (parent.children || []).filter((c) => c.type === "TEXT");
    const descNode = textKids.find((c) => c !== titleNode);
    if (await setText(titleNode, card.title)) counters.updated++;
    if (descNode && card.desc && (await setText(descNode, card.desc))) counters.updated++;
  }
}

async function applyFrame(frameName, spec, counters) {
  await figma.loadAllPagesAsync();
  const frame = figma.root.findOne(
    (n) => (n.type === "FRAME" || n.type === "COMPONENT") && n.name === frameName
  );
  if (!frame) {
    log(`✗ ${frameName} — frame not found`, "warn");
    return;
  }

  const texts = [];
  collectNonInstanceTexts(frame, texts);

  // Sanity check: the reference structure yields >= 33 non-instance text layers
  // before the fields we care about end. Bail loudly if the frame looks wrong.
  const maxIndex = Math.max(...Object.values(FIELD_INDEX));
  if (texts.length <= maxIndex) {
    log(
      `✗ ${frameName} — only ${texts.length} text layers found (expected > ${maxIndex}); skipped to avoid mangling`,
      "warn"
    );
    return;
  }

  log(`▸ ${frameName}`, "head");

  for (const [field, idx] of Object.entries(FIELD_INDEX)) {
    const value = spec.fields[field];
    if (value == null) continue;
    const node = texts[idx];
    if (!node || node.type !== "TEXT") {
      log(`      ⚠︎ ${field}: no text layer at index ${idx}`, "warn");
      continue;
    }
    if (await setText(node, value)) counters.updated++;
  }

  await applyDeliverables(frame, spec.deliverables, counters);
  log(`   done`, "ok");
}

async function run() {
  const counters = { updated: 0 };
  log("Starting…", "head");
  const names = Object.keys(CONTENT);
  for (const name of names) {
    try {
      await applyFrame(name, CONTENT[name], counters);
    } catch (e) {
      log(`✗ ${name} — ${e.message}`, "warn");
    }
  }
  log(`Finished — ${counters.updated} text layers updated across ${names.length} pages.`, "ok");
  figma.notify(`Bold Agency: updated ${counters.updated} text layers on ${names.length} service pages.`);
  figma.ui.postMessage({ type: "done" });
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "run") {
    figma.ui.postMessage({ type: "running" });
    await run();
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
