---
name: jsPDF Czech diacritics
description: Why PDF text export in this repo must embed a Unicode TTF font, and the gotchas around it.
---

# jsPDF + Czech diacritics

jsPDF's built-in fonts (helvetica/times/courier) are WinAnsi-only and cannot
render Czech characters like ř, š, ě, ů, č — they come out as garbage/blank.

**Rule:** any jsPDF/autoTable export containing Czech text MUST embed a Unicode
TTF (Roboto here) and set `font` on every `styles`/`headStyles`/`footStyles`
block plus `doc.setFont(...)` for raw `doc.text` calls. Missing it on even one
autoTable style block reverts that block to helvetica and breaks diacritics there.

**Why:** reported bug — exported "zakázkový list" / job PDFs showed broken Czech.

**How to apply:**
- Font loader lives at `artifacts/stavba/src/lib/pdf-fonts.ts`
  (`registerPdfFonts(doc)` — fetch TTF via `?url` import → blob → FileReader
  base64 → `addFileToVFS` + `addFont` for normal+bold). Base64 is cached module-level.
- Always wrap `registerPdfFonts` in try/catch and fall back to `"helvetica"`
  so export still completes if the font asset fails to load.
- Working TTF source that actually serves raw bytes:
  `https://raw.githubusercontent.com/googlefonts/roboto-2/main/src/hinted/Roboto-{Regular,Bold}.ttf`.
  The `google/fonts` raw paths return 404/HTML, not the font.

# autoTable section headers without orphaning

To label grouped tables (e.g. per-customer sections) without the header getting
orphaned at a page bottom, put the label as a full-width `colSpan` row in the
table `head` (two head rows: title row + column-label row). autoTable repeats
the whole head after every page break, so the section title can never be
separated from its rows. Manually drawing a band + guessing remaining page
height is fragile with tall wrapped cells.
