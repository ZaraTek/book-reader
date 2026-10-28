# Book Reader

A mobile-friendly PDF reader that runs in the browser. Open a PDF and read it as one
continuous scroll of text that reflows to fit your screen, with no page breaks.

## Features

- **Reflowed text view**: pulls the text out of the PDF and lays it out as one continuous
  column sized for your phone. Page numbers and running headers/footers are removed,
  words hyphenated across lines are joined back together, and headings are detected.
- **Original view**: the real PDF pages stacked edge to edge as one continuous scroll.
  Useful for scanned PDFs, diagrams, or complex layouts. Scanned PDFs with no text switch to
  this view on their own.
- **Links work**: links inside the PDF, such as a contents page linking to chapters, can be
  tapped in both views. A **Back** button appears for a few seconds after a jump so you can
  return to where you were. Links to websites open in a new tab.
- **Go to a page**: the list button in the toolbar has a "Go to page" box. Type a page
  number and tap Go. Back takes you to where you were. If the PDF has bookmarks, the same panel
  lists them, and tapping one jumps to that chapter.
- **Zoom**: pinch with two fingers, use the A− / A+ buttons, or use the size slider.
  Your place in the text stays put while you zoom.
- **Light, sepia, and dark themes**: the moon/sun button switches light and dark; sepia is in
  the settings. The first theme follows your system setting.
- Serif or sans font, and adjustable line spacing.
- **Library**: every PDF you open is saved in the browser on your device, so it's still there
  next time. The library shows how far you've read in each book, and tapping one reopens it
  where you left off. The books button in the toolbar goes back to the library; the trash icon
  removes a book. Books aren't synced between devices or browsers. On iPhone, adding the reader
  to your Home Screen keeps Safari from clearing saved books after a few weeks of not using it.
- Remembers your settings and where you were in each book.
- The toolbar hides while you scroll down. Tap the text to bring it back.
- **Private**: the PDF is read on your device and never uploaded anywhere.

## Running it

It's a static site with no build step. [PDF.js](https://mozilla.github.io/pdf.js/) loads from a CDN.

- **GitHub Pages**: the included workflow deploys it on every push to `main`. If the first
  run fails, go to *Settings → Pages* and set *Source* to **GitHub Actions**, then re-run it.
  The site will be at `https://<user>.github.io/book-reader/`.
- **Locally**: serve the folder with any static server, for example
  `python3 -m http.server`, then open http://localhost:8000. Opening `index.html` directly
  as a file won't work because browsers block ES modules on `file://`.

On a phone you can use *Add to Home Screen* so it opens like an app.

## Files

- `index.html`: page structure
- `styles.css`: themes and layout
- `app.js`: PDF loading, text reflow, zoom, themes, reading position
