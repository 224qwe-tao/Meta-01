# AI Image Metadata Viewer

A static, browser-only image metadata viewer for PNG, JPG/JPEG and WEBP files.

## Features

- Select, drag-and-drop, or paste images from clipboard
- Latest result appears at the top
- Extracts common PNG text chunks: `tEXt`, `iTXt`, `zTXt`
- Extracts readable JPEG APP/EXIF/XMP/comment text
- Extracts readable WEBP EXIF/XMP chunks
- Best-effort AI metadata detection for Stable Diffusion, ComfyUI and NovelAI-style fields
- Best-effort Stealth PNGInfo / NovelAI LSB reader for signatures such as:
  - `stealth_pnginfo`
  - `stealth_pngcomp`
  - `stealth_rgbinfo`
  - `stealth_rgbcomp`
- Copy JSON and download TXT report
- No server needed. Images are processed locally in the browser.

## Important note

This project is an original implementation. It is not a clone of any third-party website design or source code.

The NovelAI alpha-channel metadata format is publicly documented by NovelAI's open-source metadata scripts. This tool implements a browser-side reader for compatible data.

## How to use locally

Open `index.html` in a modern browser.

For best compatibility, use Chrome, Edge or Firefox with `DecompressionStream` support for gzip/deflate decoding.

## Upload to GitHub

```bash
git init
git add .
git commit -m "Initial metadata viewer"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

## Publish with GitHub Pages

1. Open your GitHub repository.
2. Go to **Settings**.
3. Go to **Pages**.
4. Source: choose **Deploy from a branch**.
5. Branch: choose **main** and `/root`.
6. Save.

After a short time, GitHub will show the public Pages URL.

## License

MIT
