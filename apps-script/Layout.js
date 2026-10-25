/**
 * How wide will this line be on the slide? The drafter (Drafter.js) needs the answer to decide where to break lines.
 * A layout describes the template's text box: { fontName, fontPt, trackingPt, boxWidth, caps }.
 *
 * The width model is picked from the font name:
 *   cmg      CMG Sans: exact advance widths of CMG Sans Medium Caps (CmgWidths.js). Used when the template font is CMG Sans.
 *   arial    Arial and Arial Bold (and Helvetica, which has the same widths): exact advance widths read from the font
 *            files on a computer (ArialWidths.js, made by tools/build_arial_widths.js). This is the built-in default look.
 *   average  Any other font: a simple rule, every character is a fixed share of the font size wide. The share is on the
 *            wide side (0.56 em for mixed case, 0.72 em for capitals), so unknown fonts get lines that are a little short
 *            rather than lines that run off the slide. On hymn text it comes out 5 to 25 percent wider than Arial, so lines break a
 *            little early, never late.
 * Every model adds the template's tracking (extra space after each character) and keeps 3 percent of the box clear.
 *
 * caps is true when the template shows capital letters (an All Caps setting, a CAPS font, or placeholder words typed in
 * capitals); the width is then measured on the capital version of the text.
 */

var LAYOUT_SAFETY = 0.97;          // keep 3% clear of the box edge
var LAYOUT_AVG_EM = 0.56;          // average model, mixed case
var LAYOUT_AVG_EM_CAPS = 0.72;     // average model, capitals

/** "cmg", "arial" or "average" for a font name such as "Arial-BoldMT" or "CMGSans-MediumCAPS". */
function layout_model(fontName) {
  var n = String(fontName || "");
  if (/^CMG ?Sans/i.test(n)) return "cmg";
  if (/^(Arial|Helvetica)(MT)?([-, ]?(Bold|Regular|Italic|Oblique|BoldItalic|BoldOblique|BoldItalicMT|BoldMT|ItalicMT))*$/i.test(n.replace(/\s+/g, "")) &&
      !/narrow|black|rounded|condensed|neue|light/i.test(n)) return "arial";
  return "average";
}

function layout_isBold(fontName) { return /bold|heavy|black|semibold/i.test(String(fontName || "")); }

/** A complete layout from { fontName, fontPt, trackingPt, boxWidth, caps }. */
function layout_make(spec) {
  return {
    fontName: String(spec.fontName || ""),
    fontPt: spec.fontPt > 0 ? spec.fontPt : 60,
    trackingPt: spec.trackingPt || 0,
    boxWidth: spec.boxWidth > 0 ? spec.boxWidth : 1400,
    caps: !!spec.caps,
    model: layout_model(spec.fontName),
    bold: layout_isBold(spec.fontName),
  };
}

/** The layout of the built-in default look (PP_ASSETS.layout, written by tools/build_default_template.js). */
function layout_default() { return layout_make(PP_ASSETS.layout); }

function layout_em(layout, s) {
  var i, total = 0, ch, w;
  if (layout.model === "cmg") {
    var adv = CMG_WIDTHS.advance;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      w = adv[ch === "’" ? "'" : ch];
      total += (w === undefined) ? adv["?"] : w;
    }
    return total / CMG_WIDTHS.unitsPerEm;
  }
  if (layout.model === "arial") {
    var table = layout.bold ? ARIAL_WIDTHS.bold : ARIAL_WIDTHS.regular, unknown = layout.caps ? LAYOUT_AVG_EM_CAPS : LAYOUT_AVG_EM;
    for (i = 0; i < s.length; i++) {
      w = table[s.charAt(i)];
      total += (w === undefined) ? unknown * ARIAL_WIDTHS.unitsPerEm : w;
    }
    return total / ARIAL_WIDTHS.unitsPerEm;
  }
  return s.length * (layout.caps ? LAYOUT_AVG_EM_CAPS : LAYOUT_AVG_EM);
}

/** Estimated width of the text on the slide, in slide units. */
function layout_width(layout, text) {
  var s = String(text);
  if (layout.caps) s = s.toUpperCase();
  return layout_em(layout, s) * layout.fontPt + layout.trackingPt * s.length;
}

function layout_fits(layout, text) { return layout_width(layout, text) <= layout.boxWidth * LAYOUT_SAFETY; }

/** One readable line about a layout, for the Log tab. */
function layout_describe(layout) {
  var how = layout.model === "cmg" ? "CMG Sans widths" : layout.model === "arial" ? "Arial widths" : "average character width";
  return layout.fontName + ", " + layout.fontPt + " pt" + (layout.caps ? ", capitals" : "") + ", line breaks by " + how;
}
