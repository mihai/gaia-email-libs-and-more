/**
 * Process text/html for message body purposes.  Specifically:
 *
 * - sanitize HTML (using bleach.js): discard illegal markup entirely, render
 *   legal but 'regulated' markup inert (ex: links to external content).
 * - TODO: perform normalization of quote markup from different clients into
 *   blockquotes, like how Thunderbird conversations does it.
 * - snippet generation: Try and generate a usable snippet string from something
 *   that is not a quote.  In cases of complicated HTML, probably just fail.
 *
 * We may eventually try and perform more detailed analysis like `quotechew.js`
 * does with structured markup, potentially by calling out to quotechew, but
 * that's a tall order to get right, so it's mightily postponed.
 **/

define(
  [
    'exports',
    'bleach'
  ],
  function(
    exports,
    $bleach
  ) {

/**
 * Whitelisted HTML tags list. Currently from nsTreeSanitizer.cpp which credits
 * Mark Pilgrim and Sam Ruby for its own initial whitelist.
 *
 * IMPORTANT THUNDERBIRD NOTE: Thunderbird only engages its sanitization logic
 * when processing mailto URIs, when the non-default
 * "view | message body as | simple html" setting is selected, or when
 * displaying spam messages.  Accordingly, the settings are pretty strict
 * and not particularly thought-out.  Non-CSS presentation is stripped, which
 * is pretty much the lingua franca of e-mail.  (Thunderbird itself generates
 * font tags, for example.)
 *
 * Some things are just not in the list at all:
 * - SVG: Thunderbird nukes these itself because it forces
 *   SanitizerCidEmbedsOnly which causes flattening of everything in the SVG
 *   namespace.
 *
 * Tags that we are opting not to include will be commented with a reason tag:
 * - annoying: This thing is ruled out currently because it only allows annoying
 *   things to happen *given our current capabilities*.
 * - scripty: This thing requires scripting to make anything happen, and we do
 *   not allow scripting.
 * - forms: We have no UI to expose the target of a form right now, so it's
 *   not safe.  Thunderbird displays a scam warning, which isn't realy a big
 *   help, but it's something.  Because forms are largely unsupported or just
 *   broken in many places, they are rarely used, so we are turning them off
 *   entirely.
 * - implicitly-nuked: killed as part of the parse process because we assign
 *   to innerHTML rather than creating a document with the string in it.
 * - inline-style-only: Styles have to be included in the document itself,
 *   and for now, on the elements themselves.  We now support <style> tags
 *   (although src will be sanitized off), but not <link> tags because they want
 *   to reference external stuff.
 * - dangerous: The semantics of the tag are intentionally at odds with our
 *   goals and/or are extensible.  (ex: link tag.)
 * - interactive-ui: A cross between scripty and forms, things like (HTML5)
 *   menu and command imply some type of mutation that requires scripting.
 *   They also are frequently very attribute-heavy.
 */
var LEGAL_TAGS = [
  'a', 'abbr', 'acronym', 'area', 'article', 'aside',
  // annoying: 'audio',
  'b',
  'bdi', 'bdo', // (bidirectional markup stuff)
  'big', 'blockquote',
  // implicitly-nuked: 'body'
  'br',
  // forms: 'button',
  // scripty: canvas
  'caption',
  'center',
  'cite', 'code', 'col', 'colgroup',
  // interactive-ui: 'command',
  // forms: 'datalist',
  'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt',
  'em',
  // forms: 'fieldset' (but allowed by nsTreeSanitizer)
  'figcaption', 'figure',
  'font',
  'footer',
  // forms: 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // implicitly-nuked: head
  'header', 'hgroup', 'hr',
  // implicitly-nuked: html
  'i', 'img',
  // forms: 'input',
  'ins', // ("represents a range of text that has been inserted to a document")
  'kbd', // ("The kbd element represents user input")
  'label', 'legend', 'li',
  // dangerous, inline-style-only: link
  /* link supports many types, none of which we want, some of which are
   * risky: http://dev.w3.org/html5/spec/links.html#linkTypes. Specifics:
   * - "stylesheet": This would be okay for cid links, but there's no clear
   *   advantage over inline styles, so we forbid it, especially as supporting
   *   it might encourage other implementations to dangerously support link.
   * - "prefetch": Its whole point is de facto information leakage.
   */
  'listing', // (deprecated, like "pre")
  'map', 'mark',
  // interactive-ui: 'menu', 'meta', 'meter',
  'nav',
  'nobr', // (deprecated "white-space:nowrap" equivalent)
  'noscript',
  'ol',
  // forms: 'optgroup',
  // forms: 'option',
  'output', // (HTML5 draft: "result of a calculation in a form")
  'p', 'pre',
  // interactive-ui: 'progress',
  'q',
  /* http://www.w3.org/TR/ruby/ is a pronounciation markup that is not directly
   * supported by gecko at this time (although there is a Firefox extension).
   * All of 'rp', 'rt', and 'ruby' are ruby tags.  The spec also defines 'rb'
   * and 'rbc' tags that nsTreeSanitizer does not whitelist, however.
   */
  'rp', 'rt', 'ruby',
  's', 'samp', 'section',
  // forms: 'select',
  'small',
  // annoying?: 'source',
  'span', 'strike', 'strong',
  'style',
  'sub', 'summary', 'sup',
  'table', 'tbody', 'td',
  // forms: 'textarea',
  'tfoot', 'th', 'thead', 'time',
  'title', // XXX does this mean anything outside head?
  'tr',
  // annoying?: 'track'
  'tt',
  'u', 'ul', 'var',
  // annoying: 'video',
  'wbr' // (HTML5 draft: line break opportunity)
];

/**
 * Tags whose children should be removed along with the tag itself, rather than
 * splicing the children into the position originally occupied by the parent.
 *
 * We do this for:
 * - forms; see `LEGAL_TAGS` for the rationale.  Note that we don't bother
 *   including children that should already be nuked by PRUNE_TAGS.  For
 *   example, 'option' and 'optgroup' only make sense under 'select' or
 *   'datalist', so we need not include them.  This means that if the tags
 *   are used in nonsensical positions, they will have their contents
 *   merged into the document text, but that's not a major concern.
 * - 'script': no one wants to read the ignored JS code!
 * - 'style': no one wants to read the CSS we are (currently) ignoring
 */
var PRUNE_TAGS = [
  'button', // (forms)
  'datalist', // (forms)
  'script', // (script)
  'select', // (forms)
  'style', // (style)
];

/**
 * What attributes to allow globally and on specific tags.
 *
 * Forbidden marker names:
 * - URL-like: The attribute can contain URL's and we don't care enough to
 *   sanitize the contents right now.
 * - sanitized: We manually do something with the attribute in our processing
 *   logic.
 * - specific: The attribute is explicitly named on the relevant element types.
 * - unsupported: Gecko ignores the attribute and there is no chance of
 *   standardization, so just strip it.
 * - microformat: we can't do anything with microformats right now, save some
 *   space.
 * - awkward: It's not dangerous, but it's not clear how it could have useful
 *   semantics.
 */
var LEGAL_ATTR_MAP = {
  '*': [
    'abbr', // (tables: removed from HTML5)
    // forms: 'accept', 'accept-charset',
    // interactive-ui: 'accesskey',
    // forms: 'action',
    'align', // (pres)
    'alt', // (fallback content)
    // forms: 'autocomplete', 'autofocus',
    // annoying: 'autoplay',
    'axis', // (tables: removed from HTML5)
    // URL-like: 'background',
    'bgcolor', 'border', // (pres)
    'cellpadding', 'cellspacing', // (pres)
    // unsupported: 'char',
    'charoff', // (tables)
    // specific: 'charset'
    // forms, interactive-ui: 'checked',
    // URL-like: 'cite'
    'class', 'clear', 'color', // (pres)
    'cols', 'colspan', // (tables)
    'compact', // (pres)
    // dangerous: 'content', (meta content refresh is bad.)
    // interactive-ui: 'contenteditable', (we already use this ourselves!)
    // interactive-ui: 'contextmenu',
    // annoying: 'controls', (media)
    'coords', // (area image map)
    'datetime', // (ins, del, time semantic markups)
    // forms: 'disabled',
    'dir', // (rtl)
    // interactive-ui: 'draggable',
    // forms: 'enctype',
    'face', // (pres)
    // forms: 'for',
    'frame', // (tables)
    'headers', // (tables)
    'height', // (layout)
    // interactive-ui: 'hidden', 'high',
    // sanitized: 'href',
    // specific: 'hreflang',
    'hspace', // (pres)
    // dangerous: 'http-equiv' (meta refresh, maybe other trickiness)
    // interactive-ui: 'icon',
    // inline-style-only: 'id',
    // specific: 'ismap', (area image map)
    // microformat: 'itemid', 'itemprop', 'itemref', 'itemscope', 'itemtype',
    // annoying: 'kind', (media)
    // annoying, forms, interactive-ui: 'label',
    'lang', // (language support)
    // forms: 'list',
    // dangerous: 'longdesc', (link to a long description, html5 removed)
    // annoying: 'loop',
    // interactive-ui: 'low',
    // forms, interactive-ui: 'max',
    // forms: 'maxlength',
    'media', // (media-query for linky things; safe if links are safe)
    // forms: 'method',
    // forms, interactive-ui: 'min',
    // unsupported: 'moz-do-not-send', (thunderbird internal composition)
    // forms: 'multiple',
    // annoying: 'muted',
    // forms, interactive-ui: 'name', (although pretty safe)
    'nohref', // (image maps)
    // forms: 'novalidate',
    'noshade', // (pres)
    'nowrap', // (tables)
    'open', // (for "details" element)
    // interactive-ui: 'optimum',
    // forms: 'pattern', 'placeholder',
    // annoying: 'playbackrate',
    'pointsize', // (pres)
    // annoying:  'poster', 'preload',
    // forms: 'prompt',
    'pubdate', // ("time" element)
    // forms: 'radiogroup', 'readonly',
    // dangerous: 'rel', (link rel, a rel, area rel)
    // forms: 'required',
    // awkward: 'rev' (reverse link; you can't really link to emails)
    'reversed', // (pres? "ol" reverse numbering)
    // interactive-ui: 'role', We don't want a screen reader making the user
    //   think that part of the e-mail is part of the UI.  (WAI-ARIA defines
    //   "accessible rich internet applications", not content markup.)
    'rows', 'rowspan', 'rules', // (tables)
    // sanitized: 'src',
    'size', // (pres)
    'scope', // (tables)
    // inline-style-only: 'scoped', (on "style" elem)
    // forms: 'selected',
    'shape', // (image maps)
    'span', // (tables)
    // interactive-ui: 'spellcheck',
    // sanitized, dangerous: 'src'
    // annoying: 'srclang',
    'start', // (pres? "ol" numbering)
    'summary', // (tables accessibility)
    'style', // (pres)
    // interactive-ui: 'tabindex',
    // dangerous: 'target', (specifies a browsing context, but our semantics
    //   are extremely clear and don't need help.)
    'title', // (advisory)
    // specific, dangerous: type (various, but mime-type for links is not the
    //   type of thing we would ever want to propagate or potentially deceive
    //   the user with.)
    'valign', // (pres)
    'value', // (pres? "li" override for "ol"; various form uses)
    'vspace', // (pres)
    'width', // (layout)
    // forms: 'wrap',
  ],
  'a': ['ext-href', 'hreflang'],
  'area': ['ext-href', 'hreflang'],
  'img': ['cid-src', 'ext-src', 'ismap', 'usemap'],
  // This may only end up being used as a debugging thing, but let's let charset
  // through for now.
  'meta': ['charset'],
  'ol': ['type'], // (pres)
};

/**
 * CSS Style rules to support.
 *
 * nsTreeSanitizer is super lazy about style binding and does not help us out.
 * What it does is nuke all rule types except NAMESPACE (@namespace), FONT_FACE
 * (@font-face), and STYLE rules (actual styling).  This means nuking CHARSET
 * (@charset to specify the encoding of the stylesheet if the server did not
 * provide it), IMPORT (@import to reference other stylesheet files), MEDIA
 * (@media media queries), PAGE (@page page box info for paged media),
 * MOZ_KEYFRAMES, MOZ_KEYFRAME, SUPPORTS (@supports provides support for rules
 * conditioned on browser support, but is at risk.)  The only style directive it
 * nukes is "-moz-binding" which is the XBL magic and considered dangerous.
 *
 * Risks: Anything that takes a url() is dangerous insofar as we need to
 * sanitize the url.  XXX for now we just avoid any style that could potentially
 * hold a URI.
 *
 * Good news: We always cram things into an iframe, so we don't need to worry
 * about clever styling escaping out into our UI.
 *
 * New reasons not to allow:
 * - animation: We don't want or need animated wackiness.
 * - slow: Doing the thing is slow!
 */
var LEGAL_STYLES = [
  // animation: animation*
  // URI-like: background, background-image
  'background-color',
  // NB: border-image is not set by the 'border' aliases
  'border',
  'border-bottom', 'border-bottom-color', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-bottom-style', 'border-bottom-width',
  'border-color',
  // URI-like: border-image*
  'border-left', 'border-left-color', 'border-left-style', 'border-left-width',
  'border-radius',
  'border-right', 'border-right-color', 'border-right-style',
  'border-right-width',
  'border-style',
  'border-top', 'border-top-color', 'border-top-left-radius',
  'border-top-right-radius', 'border-top-style', 'border-top-width',
  'border-width',
  // slow: box-shadow
  'clear',
  'color',
  'display',
  'float',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'line-height',
  // URI-like: list-style, list-style-image
  'list-style-position',
  'list-style-type',
  'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top',
  'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'text-align', 'text-align-last',
  'text-decoration', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-style', 'text-indent',
  'vertical-align',
  'white-space',
  'width',
  'word-break', 'word-spacing', 'word-wrap',
];

/**
 * The regular expression to detect nodes that should be passed to stashLinks.
 *
 * ignore-case is not required; the value is checked against the lower-cased tag.
 */
const RE_NODE_NEEDS_TRANSFORM = /^(?:a|area|img)$/;

const RE_CID_URL = /^cid:/i;
const RE_HTTP_URL = /^http(?:s)?/i;

const RE_IMG_TAG = /^img$/;

/**
 * Transforms src tags, ensure that links are http and transform them too so
 * that they don't actually navigate when clicked on but we can hook them.  (The
 * HTML display iframe is not intended to navigate; we just want to trigger the
 * browser.
 */
function stashLinks(node, lowerTag) {
  // - img: src
  if (RE_IMG_TAG.test(lowerTag)) {
    var src = node.getAttribute('src');
    if (RE_CID_URL.test(src)) {
      node.classList.add('moz-embedded-image');
      // strip the cid: bit, it is necessarily there and therefore redundant.
      node.setAttribute('cid-src', src.substring(4));
      // 'src' attribute will be removed by whitelist
    }
    else if (RE_HTTP_URL.test(src)) {
      node.classList.add('moz-external-image');
      node.setAttribute('ext-src', src);
      // 'src' attribute will be removed by whitelist
    }
    else {
      // paranoia; no known benefit if this got through
      node.removeAttribute('cid-src');
      node.removeAttribute('ext-src');
    }
  }
  // - a, area: href
  else {
    var link = node.getAttribute('href');
    if (RE_HTTP_URL.test(link)) {
      node.classList.add('moz-external-link');
      node.setAttribute('ext-href', link);
      // 'href' attribute will be removed by whitelist
    }
    else {
      // paranoia; no known benefit if this got through
      node.removeAttribute('ext-href');
    }
  }
}

var BLEACH_SETTINGS = {
  tags: LEGAL_TAGS,
  strip: true,
  prune: PRUNE_TAGS,
  attributes: LEGAL_ATTR_MAP,
  styles: LEGAL_STYLES,
  asNode: true,
  callbackRegexp: RE_NODE_NEEDS_TRANSFORM,
  callback: stashLinks
};

/**
 * @args[
 *   @param[htmlString String]{
 *     An unsanitized HTML string.  The HTML content can be a fully valid HTML
 *     document with 'html' and 'body' tags and such, but most of that extra
 *     structure will currently be discarded.
 *
 *     In the future we may try and process the body and such correctly, but for
 *     now we don't.  This is consistent with many webmail clients who ignore
 *     style tags in the head, etc.
 *   }
 * ]
 * @return[HtmlElement]{
 *   The sanitized HTML content wrapped in a div container.
 * }
 */
exports.sanitizeAndNormalizeHtml = function sanitizeAndNormalize(htmlString) {
  var sanitizedNode = $bleach.clean(htmlString, BLEACH_SETTINGS);
  return sanitizedNode;
};

/**
 * Derive snippet text from the already-sanitized HTML representation.
 */
exports.generateSnippet = function generateSnippet(sanitizedHtmlNode,
                                                   desiredLength) {
  // XXX this is not efficient to get the entire textContent and then substring
  // it.
  // XXX we really should ignore things that we believe to be quoting.
  var text = sanitizedHtmlNode.textContent;
  return text.substring(0, desiredLength);
};

/**
 * Wrap text/plain content into a serialized HTML string safe for insertion
 * via innerHTML.
 *
 * NB: simple escaping should also be fine, but this is unlikely to be a
 * performance hotspot.
 */
exports.wrapTextIntoSafeHTMLString = function(text, wrapTag) {
  var doc = document.implementation.createHTMLDocument(''),
      wrapNode = doc.createElement(wrapTag || 'code');
  wrapNode.textContent = text;
  return wrapNode.outerHTML;
};

}); // end define
